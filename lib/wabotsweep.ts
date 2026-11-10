// The WhatsApp assistant's I/O half: find customers waiting on WhatsApp, ask
// lib/wabot.ts whether to answer, write the reply on Claude, check it, send it
// on the lead's own line, and record everything.
//
// Driven by /api/crm/wa-bot (Vercel Cron every minute, CRON_SECRET; or an
// admin by hand). Idempotent and at-most-once: the ledger row naming the
// customer message being answered is written BEFORE the send, so a run that
// dies mid-send, a run that overlaps the next one, or a run twice in a minute
// can never answer the same message twice. A failure leaves silence — the
// agent already had a push for the customer's message from the webhook.
//
// dryRun: everything up to the send — real threads, real site facts, a real
// Claude reply and the real checks — and nothing written, sent or pushed.

import { supabase } from './supabase'
import { PACKAGING_SITES, siteWorkspace } from './workspaces'
import {
  CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, CRM_STAGE_ROLE, CRM_NOT_A_LEAD_ROLE,
  CRM_WA_BOT_ROLE, CRM_WA_BOT_OFF_ROLE, CRM_WA_BOT_CFG_ROLE, CRM_NOTE_ROLE, CRM_FIELD_ROLE,
} from './crm'
import { CRM_EMAIL_ROLE } from './crmemail'
import { LEAD_STATUS_ROLE } from './leadstatus'
import { llmComplete, wasCutOff } from './llm'
import {
  WA_BOT_MODEL, WA_BOT_DEFAULTS, MAX_AGE_MIN, MAX_SENDS_PER_RUN, decide, systemPrompt, transcript,
  parseOutput, tidy, replyProblem, COLLECTED_LABEL, type WaBotConfig, type WaBotLedger, type Collected, type Row,
} from './wabot'
import { waLeadContext } from './wacontext'
import { siteFacts } from './sitefacts'
import { memberDisplayName } from './membername'
import { twilioConfig, sendWhatsApp } from './twilio'
import { metaWaConfig, sendMetaWhatsApp } from './metawa'
import { leadPhone } from './leadrecord'
import { sendPushToMember, sendPushToWorkspace } from './push'
import { extractEmail } from './contactharvest'
import { formatDateTime } from './datetime'
import { BOT_ACTOR } from './quotebotcore'

/** Reserved site + session for the workspace switch — in nobody's site scope. */
export const WA_BOT_SITE = 'zeeops-wabot'
export const WA_BOT_CFG_SESSION = 'zeeops-wabot-packaging'

const LEAD_ROLES = [CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_EMAIL_ROLE, CRM_CALL_ROLE, CRM_STAGE_ROLE, LEAD_STATUS_ROLE,
  CRM_NOT_A_LEAD_ROLE, CRM_WA_BOT_ROLE, CRM_WA_BOT_OFF_ROLE]

export async function readBotConfig(): Promise<WaBotConfig & { by?: string; at?: string }> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('site_id', WA_BOT_SITE).eq('session_id', WA_BOT_CFG_SESSION).eq('role', CRM_WA_BOT_CFG_ROLE)
    .order('created_at', { ascending: false }).limit(1)
  let cfg: WaBotConfig & { by?: string; at?: string } = { ...WA_BOT_DEFAULTS }
  try {
    const o = JSON.parse(data?.[0]?.message ?? '{}')
    cfg = {
      enabled: typeof o.enabled === 'boolean' ? o.enabled : WA_BOT_DEFAULTS.enabled,
      delayMin: Number.isFinite(o.delayMin) ? Math.min(60, Math.max(1, Number(o.delayMin))) : WA_BOT_DEFAULTS.delayMin,
      maxPerDay: Number.isFinite(o.maxPerDay) ? Math.min(20, Math.max(1, Number(o.maxPerDay))) : WA_BOT_DEFAULTS.maxPerDay,
      by: typeof o.by === 'string' ? o.by : undefined, at: typeof o.at === 'string' ? o.at : undefined,
    }
  } catch { /* defaults */ }
  // The hard kill switch, for when the dashboard itself is the problem.
  if (String(process.env.WA_BOT ?? '').toLowerCase() === 'off') cfg.enabled = false
  return cfg
}

export async function writeBotConfig(patch: Partial<WaBotConfig>, by: string): Promise<WaBotConfig> {
  const cur = await readBotConfig()
  const next = { enabled: patch.enabled ?? cur.enabled, delayMin: patch.delayMin ?? cur.delayMin, maxPerDay: patch.maxPerDay ?? cur.maxPerDay }
  await supabase.from('chat_logs').insert({
    site_id: WA_BOT_SITE, session_id: WA_BOT_CFG_SESSION, role: CRM_WA_BOT_CFG_ROLE,
    message: JSON.stringify({ ...next, by, at: new Date().toISOString() }),
  })
  return next
}

export interface BotRunItem {
  leadId: string
  siteId: string
  state: 'would-send' | 'sent' | 'skipped' | 'failed' | 'model-skip'
  why?: string
  line?: string
  site?: string
  uk?: boolean
  customer?: string
  reply?: string
  collected?: Collected
  handoff?: boolean
  facts?: string[]
  model?: string
}

export interface BotRunResult { enabled: boolean; dryRun: boolean; scanned: number; items: BotRunItem[]; sent: number }

export async function runWaBot(opts: {
  dryRun?: boolean; now?: Date; leadIds?: string[]; sampleDays?: number; ignoreTiming?: boolean
  /** Dry run only: answer each thread as it stood at the customer's FIRST
   *  message (rows cut 2 minutes after it), so a week of threads that agents
   *  have since answered can still be used to judge the assistant's tone. */
  replayFirst?: boolean
} = {}): Promise<BotRunResult> {
  const now = opts.now ?? new Date()
  const dryRun = !!opts.dryRun
  const cfg = await readBotConfig()
  const result: BotRunResult = { enabled: cfg.enabled, dryRun, scanned: 0, items: [], sent: 0 }
  // A dry run may preview a switched-off assistant; a live run never acts.
  if (!cfg.enabled && !dryRun) return result
  const runCfg = dryRun ? { ...cfg, enabled: true } : cfg

  // Who is waiting: inbound WhatsApp on packaging sites, recent enough to answer.
  const sinceMs = now.getTime() - (opts.sampleDays ? opts.sampleDays * 864e5 : (MAX_AGE_MIN + 5) * 60e3)
  let q = supabase.from('chat_logs').select('session_id, site_id, created_at')
    .eq('role', CRM_WA_IN_ROLE).in('site_id', PACKAGING_SITES)
    .gte('created_at', new Date(sinceMs).toISOString())
    .order('created_at', { ascending: false }).limit(500)
  if (opts.leadIds?.length) q = q.in('session_id', opts.leadIds)
  const { data: inbound } = await q
  const sessions = [...new Map((inbound ?? []).map((r) => [String(r.session_id), String(r.site_id)])).entries()]
  result.scanned = sessions.length

  for (const [leadId, siteId] of sessions) {
    if (siteWorkspace(siteId) !== 'packaging') continue
    if (!dryRun && result.sent >= MAX_SENDS_PER_RUN) break
    const item = await handleLead(leadId, siteId, now, runCfg, dryRun, !!opts.ignoreTiming, dryRun && !!opts.replayFirst)
    result.items.push(item)
    if (item.state === 'sent') result.sent++
  }
  return result
}

async function handleLead(leadId: string, siteId: string, now: Date, cfg: WaBotConfig, dryRun: boolean, ignoreTiming: boolean, replayFirst = false): Promise<BotRunItem> {
  const { data } = await supabase.from('chat_logs').select('role, message, created_at')
    .eq('session_id', leadId).in('role', LEAD_ROLES).order('created_at', { ascending: true }).limit(1000)
  let rows = (data ?? []) as Row[]
  let at = now.getTime()
  if (replayFirst) {
    const first = rows.find((r) => r.role === CRM_WA_IN_ROLE)
    if (first) {
      const cut = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(first.created_at) ? first.created_at : `${first.created_at}Z`) + 120e3
      rows = rows.filter((r) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(r.created_at) ? r.created_at : `${r.created_at}Z`) <= cut)
      at = cut + 60e3
    }
  }
  const d = decide(rows, at, cfg, { ignoreTiming })
  if (!d.act) return { leadId, siteId, state: 'skipped', why: d.why }

  const ctx = await waLeadContext(leadId)
  if (!ctx) return { leadId, siteId, state: 'skipped', why: 'lead not found' }
  const facts = ctx.siteKnown && ctx.siteId ? await siteFacts(ctx.siteId) : null
  const agentName = ctx.assignee ? ((await memberDisplayName(ctx.assignee)).split(/\s+/)[0] || null) : null
  const customerText = d.thread.filter((m) => m.inbound).map((m) => m.body).join('\n')
  const base: BotRunItem = {
    leadId, siteId, state: 'skipped', line: ctx.line === 'meta' ? 'UK' : 'US', site: ctx.siteName, uk: ctx.uk,
    customer: d.pending.map((m) => [m.media.length ? `[${m.media.join(', ')}]` : '', m.body].filter(Boolean).join(' ')).join(' / ').slice(0, 500),
    facts: facts?.sources,
  }

  const system = systemPrompt({
    siteName: ctx.siteName, siteDomain: ctx.siteDomain, siteKnown: ctx.siteKnown, uk: ctx.uk, agentName,
    customerFirstName: ctx.firstName, facts: facts?.text ?? '', firstReply: d.firstReply, prevCollected: d.prevCollected,
  })
  const convo = transcript(d.thread, (t) => formatDateTime(new Date(t).toISOString()))
  let feedback = ''
  let out: ReturnType<typeof parseOutput> = null
  let reply = ''
  let model = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await llmComplete({
      system,
      messages: [{ role: 'user', content: `THE WHATSAPP CHAT SO FAR (newest last):\n${convo}\n\nWrite your next message as the JSON object.${feedback}` }],
      model: WA_BOT_MODEL, maxTokens: 1500, anthropicMaxTokens: 1500, effort: 'low', noFallback: true, timeoutMs: 30000,
    })
    model = r.model
    if (r.error || !r.text.trim() || wasCutOff(r.stopReason)) { feedback = ''; continue }
    out = parseOutput(r.text)
    if (!out) { feedback = '\n\nYOUR LAST ANSWER WAS NOT VALID JSON. Return only the JSON object.'; continue }
    if (out.skip) {
      // Recorded, or every minute's run would ask Claude about the same pitch again.
      if (!dryRun) await standDown(leadId, ctx.leadSiteId, d.pending[d.pending.length - 1].sid, 'skipped', `model: ${out.skip}`, model)
      return { ...base, state: 'model-skip', why: `model: ${out.skip}`, model }
    }
    reply = tidy(out.reply)
    const problem = replyProblem(reply, facts?.text ?? '', { uk: ctx.uk, siteKnown: ctx.siteKnown, firstReply: d.firstReply, customerText })
    if (!problem) break
    console.warn(`[wa-bot] ${leadId} reply rejected: ${problem}`)
    feedback = `\n\nYOUR LAST REPLY WAS REJECTED: ${problem}. Rewrite it following every rule.`
    reply = ''
  }
  if (!out || !reply) {
    const why = feedback ? feedback.trim().replace(/^YOUR LAST (REPLY|ANSWER) WAS /, '') : 'Claude did not answer'
    // Silence is the safe failure, and it is final for this message: the agent
    // already had a push for it, and retrying every minute would only spend
    // calls on a reply that keeps failing its checks.
    if (!dryRun) await standDown(leadId, ctx.leadSiteId, d.pending[d.pending.length - 1].sid, 'failed', why, model)
    return { ...base, state: 'failed', why, model }
  }

  // Only an email the customer actually typed is kept — never one the model inferred.
  const collected: Collected = { ...d.prevCollected, ...out.collected }
  if (collected.email && !extractEmail(customerText)?.toLowerCase().includes(collected.email.toLowerCase())) delete collected.email
  const item: BotRunItem = { ...base, state: dryRun ? 'would-send' : 'sent', reply, collected, handoff: out.handoff, model }
  if (dryRun) return item

  // ── At most once: claim the message, then send ───────────────────────────
  const newest = d.pending[d.pending.length - 1]
  const ledger = (l: Omit<WaBotLedger, 'inboundSid' | 'at'>) => supabase.from('chat_logs').insert({
    site_id: ctx.leadSiteId, session_id: leadId, role: CRM_WA_BOT_ROLE,
    message: JSON.stringify({ inboundSid: newest.sid, at: new Date().toISOString(), ...l }),
  })
  const claim = await ledger({ state: 'sending', model })
  if (claim.error) return { ...item, state: 'failed', why: `could not record the claim: ${claim.error.message}` }
  // A person may have answered while Claude was writing.
  const { data: late } = await supabase.from('chat_logs').select('message').eq('session_id', leadId)
    .eq('role', CRM_WA_OUT_ROLE).gt('created_at', new Date(newest.at).toISOString()).limit(5)
  if ((late ?? []).some((r) => !String(r.message).includes('"bot":true'))) {
    await ledger({ state: 'skipped', why: 'an agent replied while the assistant was writing' })
    return { ...item, state: 'skipped', why: 'an agent replied while the assistant was writing' }
  }

  const to = await leadPhone(leadId)
  const meta = ctx.line === 'meta' ? metaWaConfig() : null
  const tw = ctx.line === 'meta' ? null : twilioConfig('packaging')
  if (!to || (!meta && !tw?.whatsappFrom)) {
    await ledger({ state: 'failed', why: !to ? 'no phone on the lead' : 'line not configured' })
    return { ...item, state: 'failed', why: !to ? 'no phone on the lead' : 'line not configured' }
  }
  let sent: { sid: string; status: string }
  try {
    const statusUrl = `https://chat.zeeops.dev/api/twilio/whatsapp/status?leadId=${encodeURIComponent(leadId)}`
    sent = meta ? await sendMetaWhatsApp(meta, to, reply) : await sendWhatsApp(tw!, to, reply, statusUrl)
  } catch (e) {
    const why = e instanceof Error ? e.message : 'send failed'
    await ledger({ state: 'failed', why })
    return { ...item, state: 'failed', why }
  }
  await supabase.from('chat_logs').insert({
    site_id: ctx.leadSiteId, session_id: leadId, role: CRM_WA_OUT_ROLE,
    message: JSON.stringify({
      sid: sent.sid, from: meta ? meta.number : tw!.whatsappFrom.replace(/^whatsapp:/, ''), to, body: reply,
      at: new Date().toISOString(), sentBy: BOT_ACTOR, bot: true, direction: 'outbound', status: sent.status || 'queued',
    }),
  })
  await ledger({ state: 'sent', sid: sent.sid, model, collected, handoff: out.handoff })
  await saveCollected(leadId, ctx.leadSiteId, d.prevCollected, collected, out.handoff, ctx.assignee, ctx.siteName)
  return item
}

async function standDown(leadId: string, siteId: string, inboundSid: string, state: 'skipped' | 'failed', why: string, model: string) {
  await supabase.from('chat_logs').insert({
    site_id: siteId, session_id: leadId, role: CRM_WA_BOT_ROLE,
    message: JSON.stringify({ inboundSid, at: new Date().toISOString(), state, why, model }),
  })
}

/** New details go on the record: an empty Email field is filled, and a note
 *  lists what the customer has told the assistant — written only when something
 *  changed, and then the agent is pushed. */
async function saveCollected(leadId: string, siteId: string, before: Collected, now: Collected, handoff: boolean, assignee: string | null, siteName: string) {
  const changed = (Object.keys(COLLECTED_LABEL) as (keyof Collected)[]).filter((k) => now[k] && now[k] !== before[k])
  if (!changed.length && !handoff) return
  const at = new Date().toISOString()
  if (now.email && changed.includes('email')) {
    const { data } = await supabase.from('chat_logs').select('message').eq('session_id', leadId).eq('role', CRM_FIELD_ROLE).limit(50)
    const hasEmail = (data ?? []).some((r) => { try { const o = JSON.parse(r.message); return o.field === 'email' && o.value } catch { return false } })
    const { data: lead } = leadId.startsWith('quote-') ? await supabase.from('leads').select('email').eq('id', leadId.slice(6)).maybeSingle() : { data: null }
    if (!hasEmail && !lead?.email) {
      await supabase.from('chat_logs').insert({ site_id: siteId, session_id: leadId, role: CRM_FIELD_ROLE,
        message: JSON.stringify({ field: 'email', value: now.email, updated_by: 'auto-capture', at }) })
    }
  }
  if (changed.length) {
    const lines = (Object.keys(COLLECTED_LABEL) as (keyof Collected)[]).filter((k) => now[k]).map((k) => `${COLLECTED_LABEL[k]}: ${now[k]}`)
    await supabase.from('chat_logs').insert({ site_id: siteId, session_id: leadId, role: CRM_NOTE_ROLE,
      message: JSON.stringify({ id: `wabot-${Date.now()}`, body: `WhatsApp assistant — details from the customer:\n${lines.join('\n')}`, author: BOT_ACTOR, at }) })
  }
  // One push per NEW detail set, not per message: a handoff repeated on every
  // later reply would otherwise ring the agent each time.
  const enough = !!(now.product && (now.size || now.quantity))
  if (!changed.length || (!enough && !handoff)) return
  const payload = {
    title: 'Customer on WhatsApp — details collected',
    body: [siteName, now.product, now.size, now.quantity].filter(Boolean).join(' · ').slice(0, 140),
    url: `/leads/${encodeURIComponent(leadId)}`, tag: `wabot-${leadId}`,
  }
  if (assignee) {
    const n = await sendPushToMember(assignee, 'packaging', payload).catch(() => 0)
    if (n > 0) return
  }
  await sendPushToWorkspace('packaging', payload).catch(() => {})
}
