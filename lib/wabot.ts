// The WhatsApp assistant's pure half — WHEN it may answer, WHAT it is told, and
// the checks every reply must pass before a customer sees it.
//
// No database, no network: lib/wabotsweep.ts does the I/O and feeds plain rows
// in, so scratch tests can replay real threads through exactly what ships.
//
// The brief (owner, 2026-11-10), packaging only, both WhatsApp lines:
//   • a customer writes and no person has answered within DELAY minutes →
//     the assistant answers on Claude (never Groq — see llm.ts noFallback);
//   • any WhatsApp / email / call from an agent on the lead → silent there
//     for 24 hours; a per-lead "Bot off" and a workspace switch override all;
//   • it may state products, sizes, materials, printing, turnaround, MOQ and
//     "Starting from X per unit" ONLY as the lead's own site states them
//     (lib/sitefacts.ts) — a figure not in that text is refused here;
//   • it collects email, product, size, quantity, artwork status and ship-to
//     country, then hands off to the agent for the custom quote;
//   • never a custom/total price, a discount, a date beyond the site's
//     turnaround, the UK registration (to a US customer), payment problems,
//     alcohol / religious / Christmas products, "configurator", "design tool"
//     or "written quote".

import { isLikelySpamQuote } from './quoteintake'
import { parseWaMessage, type WaMessage } from './whatsapp'
import { parseCrmEmail } from './crmemail'
import { parseCrmStage, stageFromLeadStatus, CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, CRM_STAGE_ROLE,
  CRM_NOT_A_LEAD_ROLE, CRM_WA_BOT_ROLE, CRM_WA_BOT_OFF_ROLE } from './crm'
import { CRM_EMAIL_ROLE } from './crmemail'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import { parseNotALead } from './notalead'

/** Owner's pick; WA_BOT_MODEL overrides without a code change. */
export const WA_BOT_MODEL = process.env.WA_BOT_MODEL || 'claude-sonnet-5-5'

export interface WaBotConfig {
  enabled: boolean
  /** Minutes a customer's message waits for a person before the assistant answers. */
  delayMin: number
  /** Assistant replies per lead per rolling 24 hours. */
  maxPerDay: number
}
export const WA_BOT_DEFAULTS: WaBotConfig = { enabled: true, delayMin: 3, maxPerDay: 6 }

/** Hours of silence after any agent contact on the lead. */
export const HUMAN_QUIET_HOURS = 24
/** The customer may still be typing: the NEWEST unanswered message must be this old. */
export const SETTLE_SEC = 45
/** Never answer anything older than this. It is what stops the first live run
 *  (or a run after an outage) from replying to yesterday's backlog. */
export const MAX_AGE_MIN = 90
/** Sends per sweep run, across all leads. */
export const MAX_SENDS_PER_RUN = 8
/** Stages the assistant works. Past them (quote sent, won, on hold…) the
 *  customer is in a person's hands and a "what size do you need?" would be absurd. */
export const BOT_STAGES = new Set(['new', 'contacted'])

export interface Row { role: string; message: string; created_at: string }

/** One entry in the assistant's per-lead ledger (CRM_WA_BOT_ROLE). */
export interface WaBotLedger {
  /** Newest customer message this reply answers — the at-most-once key. */
  inboundSid: string
  state: 'sending' | 'sent' | 'failed' | 'skipped'
  at: string
  why?: string
  sid?: string
  model?: string
  collected?: Collected
  handoff?: boolean
}

export interface Collected {
  email?: string; product?: string; size?: string; quantity?: string; artwork?: string; shipTo?: string
}
export const COLLECTED_LABEL: Record<keyof Collected, string> = {
  email: 'Email', product: 'Product', size: 'Size', quantity: 'Quantity', artwork: 'Artwork', shipTo: 'Ship to',
}

export function parseLedger(message: string | null | undefined): WaBotLedger | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && typeof o.inboundSid === 'string' && typeof o.state === 'string' ? (o as WaBotLedger) : null
  } catch { return null }
}

const ms = (s: string) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)

export interface ThreadMsg { sid: string; at: number; inbound: boolean; bot: boolean; body: string; media: string[]; template?: string }

/** The WhatsApp conversation, one entry per message (status rows folded away). */
export function threadOf(rows: Row[]): ThreadMsg[] {
  const by = new Map<string, ThreadMsg>()
  for (const r of rows) {
    if (r.role !== CRM_WA_IN_ROLE && r.role !== CRM_WA_OUT_ROLE) continue
    const w: WaMessage | null = parseWaMessage(r.message)
    if (!w) continue
    const key = w.sid || `${r.role}-${r.created_at}`
    if (by.has(key)) continue
    by.set(key, {
      sid: w.sid, at: ms(r.created_at), inbound: r.role === CRM_WA_IN_ROLE, bot: w.bot === true,
      body: w.body ?? '', media: (w.media ?? []).map((m) => String(m.type || 'file')), template: w.template,
    })
  }
  return [...by.values()].sort((a, b) => a.at - b.at)
}

/** "ok", "thanks", "👍", "🙏🙏" — a message that needs no answer. A greeting
 *  ("hi", "hello") is NOT one: it is often the whole first message. */
export function isTrivialAck(text: string): boolean {
  const t = String(text || '').trim().toLowerCase()
  if (!t) return false
  if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\s‍️!.]+$/u.test(t)) return true
  return /^(ok(ay|k)?|k+|kk|thanks?( you)?( so much)?|thank u|thx|ty|cool|great|perfect|noted|sure|alright|got it|will do|fine|good|nice|awesome|appreciate it|cheers|ta)[\s!.,]*(👍|🙏|😊|🙂)?[\s!.]*$/u.test(t)
}

export type Decision =
  | { act: false; why: string }
  | { act: true; pending: ThreadMsg[]; thread: ThreadMsg[]; sentToday: number; firstReply: boolean; prevCollected: Collected }

/**
 * May the assistant answer this lead right now? Rows: the lead's crm_wa_in,
 * crm_wa_out, crm_email, crm_call, crm_stage, lead_status, crm_not_a_lead,
 * crm_wa_bot and crm_wa_bot_off rows, oldest first.
 */
export function decide(rows: Row[], now: number, cfg: WaBotConfig, opts: { ignoreTiming?: boolean } = {}): Decision {
  if (!cfg.enabled) return { act: false, why: 'assistant switched off for the workspace' }
  let off = false
  let spam = false
  let stage = 'new'
  const stageAt = new Set(rows.filter((r) => r.role === CRM_STAGE_ROLE).map((r) => r.created_at))
  const ledgers: WaBotLedger[] = []
  let lastHuman = 0
  for (const r of rows) {
    const t = ms(r.created_at)
    switch (r.role) {
      case CRM_WA_BOT_OFF_ROLE: try { off = JSON.parse(r.message)?.off === true } catch { /* keep */ } break
      case CRM_NOT_A_LEAD_ROLE: { const m = parseNotALead(r.message); if (m) spam = m.spam; break }
      case CRM_STAGE_ROLE: { const s = parseCrmStage(r.message); if (s) stage = s.stage; break }
      case LEAD_STATUS_ROLE: if (!stageAt.has(r.created_at)) { const m = stageFromLeadStatus(parseLeadStatus(r.message)?.status); if (m) stage = m } break
      case CRM_WA_BOT_ROLE: { const l = parseLedger(r.message); if (l) ledgers.push(l); break }
      case CRM_WA_OUT_ROLE: { const w = parseWaMessage(r.message); if (w && !w.bot) lastHuman = Math.max(lastHuman, t); break }
      case CRM_EMAIL_ROLE: { const e = parseCrmEmail(r.message); if (e && !e.bot) lastHuman = Math.max(lastHuman, t); break }
      case CRM_CALL_ROLE: {
        // A call an agent placed or answered; a missed inbound ring is not contact.
        try { const o = JSON.parse(r.message); if (String(o?.by ?? '').includes('@') || Number(o?.duration ?? 0) > 0) lastHuman = Math.max(lastHuman, t) } catch { /* skip */ }
        break
      }
    }
  }
  if (off) return { act: false, why: 'Bot off on this lead' }
  if (spam) return { act: false, why: 'marked not a lead' }
  if (!BOT_STAGES.has(stage)) return { act: false, why: `stage is ${stage}` }
  if (lastHuman && now - lastHuman < HUMAN_QUIET_HOURS * 3600e3) return { act: false, why: 'an agent contacted this customer in the last 24 hours' }

  const thread = threadOf(rows)
  const lastOutIdx = thread.map((m) => !m.inbound).lastIndexOf(true)
  const pending = thread.slice(lastOutIdx + 1).filter((m) => m.inbound)
  if (!pending.length) return { act: false, why: 'nothing unanswered' }
  const newest = pending[pending.length - 1]
  if (ledgers.some((l) => l.inboundSid === newest.sid)) return { act: false, why: 'already handled this message' }
  if (!opts.ignoreTiming) {
    if (now - pending[0].at < cfg.delayMin * 60e3) return { act: false, why: `waiting ${cfg.delayMin} min for a person` }
    if (now - newest.at < SETTLE_SEC * 1000) return { act: false, why: 'customer may still be typing' }
    if (now - newest.at > MAX_AGE_MIN * 60e3) return { act: false, why: 'too old to answer automatically' }
  }
  const sentToday = ledgers.filter((l) => (l.state === 'sent' || l.state === 'sending') && now - ms(l.at) < 24 * 3600e3).length
  if (sentToday >= cfg.maxPerDay) return { act: false, why: `daily limit of ${cfg.maxPerDay} replies reached` }
  if (pending.every((m) => !m.media.length && isTrivialAck(m.body))) return { act: false, why: 'only "ok / thanks" — no answer needed' }
  const customerText = thread.filter((m) => m.inbound).map((m) => m.body).join('\n')
  if (customerText.trim() && isLikelySpamQuote(customerText, null)) return { act: false, why: 'reads as a vendor / SEO pitch' }
  const prev = [...ledgers].reverse().find((l) => l.collected)
  return { act: true, pending, thread, sentToday, firstReply: !thread.some((m) => m.bot), prevCollected: prev?.collected ?? {} }
}

// ── What the model is told ──────────────────────────────────────────────────

export interface PromptInput {
  siteName: string
  siteDomain: string | null
  siteKnown: boolean
  uk: boolean
  /** The lead's own agent, first name; null = unassigned. */
  agentName: string | null
  customerFirstName: string | null
  facts: string
  firstReply: boolean
  prevCollected: Collected
}

export function systemPrompt(p: PromptInput): string {
  const who = p.agentName ?? 'our team'
  return `You are the WhatsApp assistant for ${p.siteKnown ? `${p.siteName}${p.siteDomain ? ` (${p.siteDomain})` : ''}, a custom packaging website` : `${p.siteName}, a custom packaging company`}. You answer customers on WhatsApp when the sales team has not replied within a few minutes. You are an automated assistant, not a person: never claim to be a person or use a person's name for yourself.${p.firstReply ? ` This is your first message in this chat, so start by introducing yourself in a few words, e.g. "Hi${p.customerFirstName ? ` ${p.customerFirstName}` : ''}, I'm the ${p.siteName.replace(/^the\s+/i, '')} assistant."` : ' You have already introduced yourself; do not do it again.'}

YOUR JOB
1. Answer what the customer asked, using ONLY the SITE FACTS below.
2. Collect these details, one or two per message, only those still missing: email address, product, size (dimensions), quantity, artwork status (ready, needs design help, or none yet), ship-to country.
3. When product, size and quantity are known, or the customer asks for a price, hand off: say ${who} will send their custom quote shortly${p.agentName ? '' : ' (say "our team", never invent a name)'}. Keep collecting anything still missing.

HARD RULES
- Numbers: you may state a minimum order, a "Starting from X per unit" price, a turnaround or any other figure ONLY if it is written in SITE FACTS, word for word in meaning, for the product the customer is asking about. Say per-unit prices only as "Starting from <price> per <unit>". If SITE FACTS has no figure for it, say ${who} will confirm it in the custom quote.${p.siteKnown ? '' : ' We do not know which of our sites this customer came from, so state NO prices, minimums or turnaround at all.'}
- Never give a custom price, a total, a price for their quantity, a discount or a percentage. Never do arithmetic on prices.
- Never promise a delivery or ship date. You may repeat the turnaround from SITE FACTS ("production usually takes N business days after artwork approval") but never say their order will arrive by a date; if they have a deadline, note it and say ${who} will confirm what is possible.
- Never discuss payment problems, card or bank issues, refunds or chargebacks: say ${who} will help with that.
- Never mention where the company is registered or located${p.uk ? '' : ', and never mention the UK, England or London'}.
- We do not make packaging for alcohol, religious products or Christmas. Politely say it is not something we can help with.
- Never use the words "configurator", "design tool" or "written quote". Say "custom quote".
- Never make up facts about samples, stock, materials or printing that are not in SITE FACTS; say ${who} will confirm.
- If the customer sends a photo or file, thank them for it; you cannot see it, so do not describe it. You cannot listen to voice notes: ask them to type the key details.
- Spelling: ${p.uk ? 'British English (colour, customise, centre, organise), prices in £ as the site shows' : 'American English (color, customize, center, organize)'}.
- WhatsApp style: plain text, no markdown, no asterisks, no bullet points, no headings, no emojis. At most 3 short paragraphs and about 60 words in total. Warm and direct. Reply in the customer's language.

DO NOT REPLY AT ALL (set "skip") when the customer is: a supplier, factory, agency or anyone selling to us ("vendor"); spam or a scam ("spam"); only saying ok / thanks / an emoji to something already answered ("ack"); or asking about something that is not packaging at all ("not_packaging").

ALREADY COLLECTED: ${JSON.stringify(p.prevCollected)}

SITE FACTS (the only source of figures):
${p.facts || '(none available — state no figures at all)'}

OUTPUT: only this JSON object, nothing else:
{"skip": null | "vendor" | "spam" | "ack" | "not_packaging", "reply": "the WhatsApp message", "collected": {"email": string|null, "product": string|null, "size": string|null, "quantity": string|null, "artwork": string|null, "shipTo": string|null}, "handoff": boolean}
"collected" holds everything the CUSTOMER has stated in the whole chat (not guesses), merged with ALREADY COLLECTED.`
}

/** The conversation as the model reads it. Our side is labelled by who wrote it. */
export function transcript(thread: ThreadMsg[], fmt: (ms: number) => string): string {
  return thread.slice(-30).map((m) => {
    const who = m.inbound ? 'CUSTOMER' : m.bot ? 'ASSISTANT (you)' : 'SALES AGENT'
    const media = m.media.map((t) => t.startsWith('audio/') ? '[voice note]' : t.startsWith('image/') ? '[photo]' : t.startsWith('video/') ? '[video]' : '[file]').join(' ')
    return `[${fmt(m.at)}] ${who}: ${[media, m.body.slice(0, 1500)].filter(Boolean).join(' ')}`
  }).join('\n')
}

export interface BotOutput { skip: string | null; reply: string; collected: Collected; handoff: boolean }

export function parseOutput(text: string): BotOutput | null {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(m[0]) } catch { return null }
  const c = (o.collected && typeof o.collected === 'object' ? o.collected : {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' && v.trim() && !/^(null|unknown|n\/a|none)$/i.test(v.trim()) ? v.trim().slice(0, 200) : undefined)
  const collected: Collected = {}
  for (const k of Object.keys(COLLECTED_LABEL) as (keyof Collected)[]) { const v = s(c[k]); if (v) collected[k] = v }
  return {
    skip: typeof o.skip === 'string' && o.skip ? o.skip : null,
    reply: typeof o.reply === 'string' ? o.reply : '',
    collected, handoff: o.handoff === true,
  }
}

/** Markdown and list marks a model sometimes adds anyway, removed rather than refused. */
export function tidy(reply: string): string {
  return reply.replace(/\r/g, '').replace(/\*\*?|__|`/g, '').replace(/^\s*#+\s*/gm, '').replace(/^\s*[-•*]\s+/gm, '')
    // "the The Candle Packaging assistant": site names that start with The.
    .replace(/\bthe (The )/g, '$1')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const norm = (s: string) => s.toLowerCase().replace(/[\s,]/g, '')

/**
 * Why this reply must not be sent, or null. Every figure in it has to be in
 * the site's own text — the model is told so, and this is what makes it a rule.
 */
export function replyProblem(reply: string, facts: string, o: { uk: boolean; siteKnown: boolean; firstReply: boolean; customerText: string }): string | null {
  const t = reply.trim()
  if (!t) return 'empty reply'
  const words = t.split(/\s+/).length
  if (words > 95) return `too long (${words} words)`
  if (t.split(/\n\s*\n/).length > 3) return 'more than 3 paragraphs'
  if (/configurator|design tool|written quote/i.test(t)) return 'banned wording (configurator / design tool / written quote)'
  if (/\bdiscount|\d+\s?%|\bpercent\b|\b(in )?total\b|\bcomes? to\b|\bwould cost\b|\bwill cost\b/i.test(t)) return 'a total, discount or percentage'
  if (/registered in|\bLtd\b|limited company|companies house/i.test(t)) return 'mentions the company registration'
  if (!o.uk && /\b(UK|U\.K\.|United Kingdom|England|London|British)\b/.test(t)) return 'mentions the UK to a US customer'
  if (/\b(chargeback|refund|card (was )?declined|bank transfer|wire transfer|payment (issue|problem|failed))/i.test(t)) return 'discusses payment problems'
  if (/christmas|xmas|alcohol|liquor|wine|beer|religio/i.test(t) && !/\b(not|n't|unable|cannot|can't|don't|do not)\b/i.test(t)) return 'offers a declined product category'
  if (/https?:\/\//i.test(t)) return 'contains a link'
  if (/\b(I am|I'm|this is) (Samir|Steve|Mark|Jennifer|Danny|Kabir|Saifullah|Shazzy)\b/i.test(t)) return 'pretends to be a named person'
  if (o.firstReply && !/assistant/i.test(t)) return 'first reply does not introduce the assistant'
  // Money: every amount must appear in the site facts.
  const factsN = norm(facts)
  for (const m of t.matchAll(/[$£€]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|GBP|EUR|dollars?|pounds?|pence|cents?)\b/gi)) {
    if (!o.siteKnown) return 'states a price with no site known'
    if (!factsN.includes(norm(m[0]).replace(/usd|gbp|eur|dollars?|pounds?/g, ''))) return `price "${m[0]}" is not on the site`
  }
  if (/[$£€]\s?\d/.test(t) && !/starting from/i.test(t)) return 'a price not phrased as "Starting from"'
  // Durations and minimums: every number in those sentences must be in the facts,
  // unless the customer said it first (their own deadline or quantity echoed back).
  // Prices are checked above; taken out here so a decimal point (£0.25) does not split a sentence.
  const noMoney = t.replace(/[$£€]\s?\d[\d,]*(?:\.\d+)?/g, 'PRICE')
  for (const sm of noMoney.matchAll(/[^.!?\n]*\b(\d[\d,]*)\b[^.!?\n]*\b(business days?|days?|weeks?|minimum|MOQ|at least)\b[^.!?\n]*|[^.!?\n]*\b(minimum|MOQ|at least)\b[^.!?\n]*\b(\d[\d,]*)\b[^.!?\n]*/gi)) {
    for (const n of sm[0].match(/\d[\d,]*/g) ?? []) {
      const d = n.replace(/,/g, '')
      // A whole number, not a digit inside another one ("5" is not in "£0.25").
      const whole = new RegExp(`(?<![\\d.])${d}(?!\\d)`)
      if (whole.test(o.customerText.replace(/,/g, ''))) continue
      if (!o.siteKnown) return 'states a minimum or turnaround with no site known'
      if (!whole.test(facts.replace(/,/g, ''))) return `"${sm[0].trim().slice(0, 60)}" is not on the site`
    }
  }
  if (/\b(by|before|on) (mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(will|should) (arrive|be delivered|ship) (by|on|before)\b/i.test(t)) return 'promises a date'
  const us = /\b(color|colors|customize|customized|center|organize|favorite)\b/i
  const gb = /\b(colour|colours|customise|customised|centre|organise|favourite)\b/i
  if (o.uk && us.test(t)) return 'American spelling to a UK customer'
  if (!o.uk && gb.test(t)) return 'British spelling to a US customer'
  return null
}
