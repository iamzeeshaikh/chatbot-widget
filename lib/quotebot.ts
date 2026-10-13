// The quote bot — answers a new packaging quote by email, as the lead's agent.
//
// ── What it does (Step 1 of the owner's 2026-10-13 plan) ─────────────────────
// For every new quote or chat lead with an email address, once:
//   1. reads the enquiry (lib/quotebotcore.ts) for size, style and quantity;
//   2. emails the customer FROM THE AGENT'S OWN MAILBOX, on the site's own
//      domain — asking for exactly what is missing, or, when nothing is,
//      saying the price quote is in process;
//   3. moves the lead New → Contacted;
//   4. when the request is complete, gives the agent a task to price it and
//      pushes them a notification.
// It never gives a price. Pricing stays human.
//
// ── Whose lead it is ────────────────────────────────────────────────────────
// The lead's assignee when that is one of BOT_AGENTS. Most form leads arrive
// unassigned (the owner is whoever writes first), so an unassigned lead is
// given to the agent the bot has sent for least in the last week and the
// assignment is written, exactly as if a team lead had assigned it.
//
// ── At most once, ever ──────────────────────────────────────────────────────
// Same shape as lib/reminderssweep.ts: a crm_bot ledger row is written BEFORE
// the email goes (claim-then-send), and any crm_bot row on a lead means the bot
// has finished with it. A crash between claim and send loses one email rather
// than risking two. Overlapping runs are kept apart by a short lease.
//
// ── What makes it stand down ─────────────────────────────────────────────────
// Anything a human has already done: an email, a WhatsApp, a call, a stage
// change, a "not a lead" mark — on this lead, or an email to the same address
// on any lead in the last 30 days. Also: no email address, not a real quote,
// not written in English, no verified mailbox for the site. Every stand-down
// is a ledger row with its reason, so "why didn't the bot answer this one?"
// always has an answer.

import { supabase } from './supabase'
import { workspaceSites, hasFeature } from './workspaces'
import { quoteSessionId, leadSource } from './quoteintake'
import { leadRecipient, writeControlRow } from './leadrecord'
import { notALeadSessions } from './notalead'
import { ASSIGNMENT_ROLE, setAssignment } from './assignment'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import {
  CRM_STAGE_ROLE, CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, CRM_TASK_ROLE, CRM_WA_IN_ROLE,
  parseCrmStage, stageFromLeadStatus,
} from './crm'
import { applyStageChange } from './stagechange'
import { threadContextFor, isNoiseSender } from './emailsweep'
import { CRM_EMAIL_IN_ROLE, parseCrmEmailIn } from './emailreply'
import { googleConfig, verifiedAliases, sendEmail, GmailAuthError, type SendAsAlias } from './gmail'
import { makeSnippet, newEmailId, isAddress, parseCrmEmail, type CrmEmailEntry } from './crmemail'
import { openPixelHtml } from './emailtrack'
import { buildSendSignature } from './sendsignature'
import { newTaskId, type CrmTaskEntry } from './tasks'
import { sendPushToMember } from './push'
import { llmComplete, CLAUDE_CHAT_MODEL } from './llm'
import {
  ASSESS_SYSTEM, BOT_ACTOR, parseAssessment, buildFirstEmail, missingOf, buildFollowUp,
  FOLLOW_UP_GAP_DAYS, CALL_TASK_EVERY, type Missing,
  quoteTextForAssessment, emailHtml, type QuoteAssessment,
} from './quotebotcore'

export const CRM_BOT_ROLE = 'crm_bot'

/** The agents the bot writes for. The owner's roster on 2026-10-13. */
export const BOT_AGENTS = [
  'samirkhan@shopcardboardboxes.com',
  'stevehayes@shopcardboardboxes.com',
] as const

/**
 * Nothing created before this is ever touched. The bot went live on
 * 2026-10-13; the 1,100 leads already in the CRM were worked by people, and
 * writing "thanks for reaching out" to someone who did so in August would be
 * the worst first impression it could make.
 */
const BOT_START = process.env.QUOTE_BOT_START || '2026-10-13T07:30:00Z'
/** A lead older than this is past the moment a first reply makes sense. */
const MAX_AGE_MS = 72 * 3600 * 1000
/** Lets the intake's dedupe settle and the chat end before anyone is emailed. */
const MIN_AGE_MS = 5 * 60 * 1000
/** A bad day upstream (a form flood) must not become a bad day in Gmail. */
const MAX_SENDS_PER_RUN = 8
const LEASE_SESSION = 'zeeops-quotebot-lease'
const LEDGER_SITE = 'zeeops-crm'
const LEASE_MS = 4 * 60 * 1000
/**
 * Where a customer's mail client fetches the logo and the open pixel from.
 * NEVER the request origin: Vercel Cron calls the deployment's own
 * *.vercel.app URL, which sits behind deployment protection, so every image
 * in the first bot emails came back 401 — a broken logo and no open tracking.
 */
const PUBLIC_BASE = (process.env.NEXT_PUBLIC_BASE_URL || 'https://chat.zeeops.dev').replace(/\/$/, '')

export type BotState = 'claimed' | 'sent' | 'skipped' | 'failed'

export interface BotLedger {
  step: 'first' | 'followup'
  /** Follow-up number, 1-based. */
  n?: number
  state: BotState
  at: string
  why?: string
  to?: string
  agent?: string
  from?: string
  complete?: boolean
  missing?: string[]
  emailId?: string
  /** Discount offered in this follow-up, percent. */
  offer?: number
}

export function parseBotLedger(message: string | null | undefined): BotLedger | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && typeof o.state === 'string' ? (o as BotLedger) : null
  } catch { return null }
}

/** Sends only when switched on. Off, every run is a dry run. */
export function quoteBotEnabled(): boolean {
  return (process.env.QUOTE_BOT || '').toLowerCase() === 'on'
}

export interface BotAction {
  leadId: string
  siteId: string
  state: BotState | 'would-send' | 'retry-later'
  why?: string
  agent?: string
  from?: string
  to?: string
  subject?: string
  text?: string
  complete?: boolean
  missing?: string[]
}

export interface BotRunResult {
  ok: boolean
  enabled: boolean
  dryRun: boolean
  skipped?: 'leased'
  scanned: number
  actions: BotAction[]
}

interface LeadRow { id: string; site_id: string; name: string | null; email: string | null; message: string | null; created_at: string }
interface LogRow { session_id: string; role: string; message: string; created_at: string }

async function ledger(sessionId: string, siteId: string, entry: BotLedger): Promise<boolean> {
  const { error } = await writeControlRow({ sessionId, siteId, role: CRM_BOT_ROLE, message: JSON.stringify(entry) })
  if (error) console.error('[quotebot] ledger write failed:', error)
  return !error
}

async function takeLease(now: Date): Promise<boolean> {
  const { data } = await supabase.from('chat_logs').select('created_at')
    .eq('role', CRM_BOT_ROLE).eq('session_id', LEASE_SESSION)
    .gte('created_at', new Date(now.getTime() - LEASE_MS).toISOString()).limit(1)
  if ((data ?? []).length) return false
  await supabase.from('chat_logs').insert({
    site_id: LEDGER_SITE, session_id: LEASE_SESSION, role: CRM_BOT_ROLE,
    message: JSON.stringify({ step: 'first', state: 'claimed', at: now.toISOString(), why: 'lease' }),
  })
  return true
}

/**
 * Has anyone already written to this address? Any lead, last 30 days.
 *
 * Mail on a lead since marked "not a lead" (spam, a test) does not count: it
 * says nothing about whether this customer has heard from us, and counting it
 * would let one test or one mis-marked record silence a real enquiry.
 */
async function addressAlreadyContacted(address: string, now: Date, notLeads: Set<string>): Promise<boolean> {
  const since = new Date(now.getTime() - 30 * 864e5).toISOString()
  // `_` is ilike's one-character wildcard, which matches a literal `_` too, so
  // the address is used as it is. Stripping it once made john_doe@ unfindable.
  const needle = `%${address.trim().replace(/%/g, '')}%`
  const [mail, bot] = await Promise.all([
    supabase.from('chat_logs').select('session_id').eq('role', CRM_EMAIL_ROLE)
      .gte('created_at', since).ilike('message', needle).limit(200),
    supabase.from('chat_logs').select('session_id, message').eq('role', CRM_BOT_ROLE)
      .gte('created_at', since).ilike('message', needle).limit(200),
  ])
  if ((mail.data ?? []).some((r) => !notLeads.has(r.session_id))) return true
  return (bot.data ?? []).some((r) => {
    if (notLeads.has(r.session_id)) return false
    const e = parseBotLedger(r.message)
    return e?.state === 'sent' || e?.state === 'claimed'
  })
}

/** The alias on this site's own domain — the same matcher the composer uses. */
function siteAlias(aliases: SendAsAlias[], siteId: string, siteName: string): SendAsAlias | null {
  const site = siteId.toLowerCase()
  const name = siteName.toLowerCase().replace(/[^a-z]/g, '')
  return aliases.find((a) => {
    const local = a.email.split('@')[0].toLowerCase()
    const domain = (a.email.split('@')[1] ?? '').toLowerCase().replace(/[^a-z]/g, '')
    return domain.includes(site) || (!!name && domain.includes(name)) || local.includes(site)
  }) ?? null
}

/** How many leads the bot gave each agent this week, so neither inbox gets every one. */
async function weeklyLoad(now: Date): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - 7 * 864e5).toISOString()
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('role', CRM_BOT_ROLE).gte('created_at', since).limit(2000)
  const load = new Map<string, number>(BOT_AGENTS.map((a) => [a, 0]))
  for (const r of data ?? []) {
    const e = parseBotLedger(r.message)
    if (e?.state === 'sent' && e.agent && load.has(e.agent)) load.set(e.agent, load.get(e.agent)! + 1)
  }
  return load
}

export async function assessQuote(message: string, name: string | null): Promise<QuoteAssessment | null> {
  const r = await llmComplete({
    system: ASSESS_SYSTEM,
    messages: [{ role: 'user', content: quoteTextForAssessment(message, name) }],
    maxTokens: 1200, anthropicMaxTokens: 400, temperature: 0,
    model: CLAUDE_CHAT_MODEL, timeoutMs: 25000,
  })
  if (r.error) return null
  return parseAssessment(r.text)
}

export async function runQuoteBot(origin: string, now = new Date(), opts: { dryRun?: boolean; leadIds?: string[] } = {}): Promise<BotRunResult> {
  const enabled = quoteBotEnabled()
  const dryRun = !enabled || !!opts.dryRun
  const result: BotRunResult = { ok: true, enabled, dryRun, scanned: 0, actions: [] }

  if (!dryRun && !(await takeLease(now))) return { ...result, skipped: 'leased' }

  const sites = hasFeature('packaging', 'quotebot') ? workspaceSites('packaging') : []
  if (!sites.length) return result
  const floor = new Date(Math.max(new Date(BOT_START).getTime(), now.getTime() - MAX_AGE_MS)).toISOString()
  const ceiling = new Date(now.getTime() - MIN_AGE_MS).toISOString()

  let q = supabase.from('leads').select('id, site_id, name, email, message, created_at').in('site_id', sites)
  // Named leads are a manual preview: they skip the time window, never the
  // safety checks below.
  q = opts.leadIds?.length
    ? q.in('id', opts.leadIds.map((x) => x.replace(/^quote-/, '')))
    : q.gte('created_at', floor).lte('created_at', ceiling)
  const { data: leadRows, error } = await q.order('created_at', { ascending: true }).limit(200)
  if (error) throw new Error(`leads query failed: ${error.message}`)
  const leads = (leadRows ?? []) as LeadRow[]
  result.scanned = leads.length
  if (!leads.length) return result

  const sessions = leads.map((l) => quoteSessionId(l.id))
  const [{ data: logRows }, excluded, siteRes] = await Promise.all([
    supabase.from('chat_logs').select('session_id, role, message, created_at')
      .in('session_id', sessions)
      .in('role', [CRM_BOT_ROLE, CRM_STAGE_ROLE, LEAD_STATUS_ROLE, CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, ASSIGNMENT_ROLE])
      .order('created_at', { ascending: true }),
    notALeadSessions(sites),
    supabase.from('sites').select('site_id, name'),
  ])
  const bySession = new Map<string, LogRow[]>()
  for (const r of (logRows ?? []) as LogRow[]) {
    const list = bySession.get(r.session_id) ?? []
    list.push(r)
    bySession.set(r.session_id, list)
  }
  const siteName = new Map((siteRes.data ?? []).map((s) => [s.site_id, String(s.name ?? s.site_id)]))
  const cfg = googleConfig(origin)
  // Counted up as this run hands leads out, not just read once — otherwise a
  // run with five new leads gives all five to whoever was lighter at the start.
  let load: Map<string, number> | null = null
  let sends = 0

  for (const lead of leads) {
    const id = quoteSessionId(lead.id)
    const rows = bySession.get(id) ?? []
    const act = (a: Omit<BotAction, 'leadId' | 'siteId'>) => { result.actions.push({ leadId: id, siteId: lead.site_id, ...a }) }

    // ── stand down quietly: these were never the bot's ──────────────────────
    if (rows.some((r) => r.role === CRM_BOT_ROLE)) continue // already handled, once
    const kind = leadSource(lead.message)
    if (kind !== 'quote' && kind !== 'chat') continue // calls, WhatsApp, checkout
    if (excluded.has(id)) continue

    // From here on every stand-down is recorded, so it is never retried and
    // somebody can see why.
    const skip = async (why: string, extra: Partial<BotLedger> = {}) => {
      act({ state: 'skipped', why })
      if (!dryRun) await ledger(id, lead.site_id, { step: 'first', state: 'skipped', at: now.toISOString(), why, ...extra })
    }

    const human = rows.find((r) => r.role === CRM_EMAIL_ROLE || r.role === CRM_WA_OUT_ROLE || r.role === CRM_CALL_ROLE)
    if (human) { await skip(`an agent already reached out (${human.role})`); continue }
    if (currentStage(rows) !== 'new') { await skip(`stage is already ${currentStage(rows)}`); continue }

    const to = await leadRecipient(id)
    if (!to) { await skip('no email address on the lead'); continue }
    if (!isAddress(to)) { await skip(`"${to}" is not a valid email address`); continue }
    if (await addressAlreadyContacted(to, now, excluded)) { await skip('this address was already emailed in the last 30 days', { to }); continue }

    const assessment = await assessQuote(lead.message ?? '', lead.name)
    // The model being down is not a decision about the lead: no ledger row, so
    // the next run tries again (until the lead ages out of the window).
    if (!assessment) { act({ state: 'retry-later', why: 'could not read the enquiry (model unavailable)' }); continue }
    if (!assessment.isQuote) { await skip(`not a packaging quote: ${assessment.reason}`); continue }
    if (!assessment.language.startsWith('en')) { await skip(`customer wrote in "${assessment.language}" — left for a person`); continue }

    // ── whose lead, and which address ───────────────────────────────────────
    const assigned = lastAssignment(rows)
    const preset = assigned && (BOT_AGENTS as readonly string[]).includes(assigned) ? assigned : null
    if (assigned && !preset) {
      // Assigned to somebody outside the bot's roster (a chat agent, a team
      // lead). Writing in another person's name would be wrong either way.
      await skip(`assigned to ${assigned}, who the bot does not write for`)
      continue
    }
    if (!cfg) { act({ state: 'retry-later', why: 'Google OAuth is not configured' }); continue }
    load ??= await weeklyLoad(now)
    const tally = load
    const candidates = preset ? [preset] : [...BOT_AGENTS].sort((a, b) => tally.get(a)! - tally.get(b)!)
    let agent: string | null = null
    let alias: SendAsAlias | null = null
    for (const who of candidates) {
      try {
        const found = siteAlias(await verifiedAliases(who, cfg), lead.site_id, siteName.get(lead.site_id) ?? '')
        if (found) { agent = who; alias = found; break }
      } catch (e) {
        console.error(`[quotebot] aliases for ${who} unavailable:`, e instanceof Error ? e.message : e)
      }
    }
    if (!agent || !alias) { await skip(`no verified ${lead.site_id} mailbox for ${candidates.join(' / ')}`); continue }

    const mail = buildFirstEmail(assessment, { siteName: siteName.get(lead.site_id) ?? lead.site_id, fromChat: kind === 'chat' })
    const missing = missingOf(assessment)
    const preview = { agent, from: alias.email, to, subject: mail.subject, text: mail.text, complete: mail.complete, missing }
    tally.set(agent, (tally.get(agent) ?? 0) + 1)

    if (dryRun) { act({ state: 'would-send', why: assessment.reason, ...preview }); continue }
    if (sends >= MAX_SENDS_PER_RUN) { act({ state: 'retry-later', why: 'per-run send cap reached' }); continue }

    // ── claim, then send ────────────────────────────────────────────────────
    if (!(await ledger(id, lead.site_id, { step: 'first', state: 'claimed', at: now.toISOString(), to, agent, from: alias.email }))) {
      act({ state: 'retry-later', why: 'ledger write failed' }); continue
    }
    sends++

    const base = PUBLIC_BASE
    const sig = await buildSendSignature({ memberEmail: agent, workspace: 'packaging', siteId: lead.site_id, from: alias.email, base })
    const emailId = newEmailId()
    const finalText = sig.text ? `${mail.text}\n\n${sig.text}` : mail.text
    const finalHtml = `${emailHtml(mail.text)}${sig.html}${openPixelHtml(base, id, emailId)}`

    let sent
    try {
      sent = await sendEmail(agent, cfg, { from: alias.email, to, subject: mail.subject, body: finalText, html: finalHtml })
    } catch (e) {
      const why = e instanceof GmailAuthError ? `${agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
      await ledger(id, lead.site_id, { step: 'first', state: 'failed', at: new Date().toISOString(), why, to, agent })
      act({ state: 'failed', why, ...preview })
      continue
    }

    const at = new Date().toISOString()
    const entry: CrmEmailEntry = {
      id: emailId, sentBy: agent, from: alias.email, to, subject: mail.subject,
      body: finalText, html: finalHtml, snippet: makeSnippet(mail.text), at,
      gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId,
      direction: 'outbound', bot: true,
    }
    await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
    if (!preset) await setAssignment(id, lead.site_id, agent)
    await applyStageChange({ leadId: id, siteId: lead.site_id, stage: 'contacted', previous: 'new', actorEmail: BOT_ACTOR })

    if (mail.complete) {
      const who = lead.name || to
      const task: CrmTaskEntry = {
        id: newTaskId(),
        title: `Send the price quote — ${who} gave size, style and quantity (bot replied)`.slice(0, 200),
        type: 'email',
        due_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
        assignee: agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
      }
      await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
      await sendPushToMember(agent, 'packaging', {
        title: 'Quote ready to price',
        body: `${who} (${siteName.get(lead.site_id) ?? lead.site_id}) sent everything. Send the price.`,
        url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-${id}`,
      }).catch(() => 0)
    }

    await ledger(id, lead.site_id, {
      step: 'first', state: 'sent', at, to, agent, from: alias.email,
      complete: mail.complete, missing, emailId,
    })
    act({ state: 'sent', why: assessment.reason, ...preview })
  }

  return result
}

// Same fold as the pipeline: the newest crm_stage wins, and a legacy
// lead_status row counts only when it is not the mirror of a crm_stage row.
function currentStage(rows: LogRow[]): string {
  const stageAt = new Set(rows.filter((r) => r.role === CRM_STAGE_ROLE).map((r) => r.created_at))
  let stage = 'new'
  for (const r of rows) {
    if (r.role === CRM_STAGE_ROLE) {
      const s = parseCrmStage(r.message); if (s) stage = s.stage
    } else if (r.role === LEAD_STATUS_ROLE && !stageAt.has(r.created_at)) {
      const m = stageFromLeadStatus(parseLeadStatus(r.message)?.status); if (m) stage = m
    }
  }
  return stage
}

function lastAssignment(rows: LogRow[]): string | null {
  let who: string | null = null
  for (const r of rows) if (r.role === ASSIGNMENT_ROLE) who = r.message.trim().toLowerCase() || null
  return who
}

// ── Follow-ups (Step 2) ─────────────────────────────────────────────────────

export interface FollowUpResult {
  ok: boolean
  state: 'sent' | 'stopped' | 'not-due' | 'failed'
  why?: string
  n?: number
  text?: string
  callTask?: boolean
}

/**
 * The next follow-up on one lead the bot first emailed.
 *
 * Stops for good the moment the customer answers (email or WhatsApp) or a
 * person on our side writes, calls or messages them — from then on the lead
 * is a human conversation. `force` skips only the 3-day wait, never those
 * checks; it is how an admin tests the sequence on a lead without waiting.
 */
export async function sendFollowUp(leadId: string, now = new Date(), opts: { force?: boolean } = {}): Promise<FollowUpResult> {
  const id = leadId.startsWith('quote-') ? leadId : `quote-${leadId}`
  const { data } = await supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
    .eq('session_id', id)
    .in('role', [CRM_BOT_ROLE, CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE, CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE])
    .order('created_at', { ascending: true })
  const rows = (data ?? []) as (LogRow & { site_id: string })[]
  const ledgers = rows.filter((r) => r.role === CRM_BOT_ROLE).map((r) => parseBotLedger(r.message)).filter(Boolean) as BotLedger[]
  const first = ledgers.find((e) => e.step === 'first' && e.state === 'sent')
  if (!first || !first.agent || !first.from || !first.to) return { ok: false, state: 'stopped', why: 'the bot never emailed this lead' }
  const siteId = rows[0].site_id
  const firstAt = new Date(first.at).getTime()

  // ── has anyone else spoken since? ────────────────────────────────────────
  const after = rows.filter((r) => new Date(r.created_at).getTime() > firstAt - 1000)
  const customer = after.find((r) => {
    if (r.role === CRM_WA_IN_ROLE) return true
    if (r.role !== CRM_EMAIL_IN_ROLE) return false
    const e = parseCrmEmailIn(r.message)
    return !!e && !isNoiseSender(e.from)
  })
  if (customer) return { ok: true, state: 'stopped', why: 'the customer replied — this is a conversation for a person now' }
  const human = after.find((r) => r.role === CRM_WA_OUT_ROLE || r.role === CRM_CALL_ROLE
    || (r.role === CRM_EMAIL_ROLE && !parseCrmEmail(r.message)?.bot))
  if (human) return { ok: true, state: 'stopped', why: `an agent reached the customer themselves (${human.role})` }

  const sentUps = ledgers.filter((e) => e.step === 'followup' && e.state === 'sent')
  const n = sentUps.length + 1
  const lastAt = Math.max(firstAt, ...sentUps.map((e) => new Date(e.at).getTime()))
  if (!opts.force && now.getTime() - lastAt < FOLLOW_UP_GAP_DAYS * 864e5) {
    return { ok: true, state: 'not-due', n, why: `next one is due ${new Date(lastAt + FOLLOW_UP_GAP_DAYS * 864e5).toISOString()}` }
  }

  // ── what to say ──────────────────────────────────────────────────────────
  const { data: lead } = await supabase.from('leads').select('name, message').eq('id', id.replace(/^quote-/, '')).maybeSingle()
  const assessment = await assessQuote(lead?.message ?? '', lead?.name ?? null)
  if (!assessment) return { ok: false, state: 'failed', why: 'could not read the enquiry (model unavailable)' }
  const missing = (first.missing ?? []) as Missing[]
  const fu = buildFollowUp(assessment, { n, missing, firstName: assessment.firstName, now })

  // Threaded under the first email, in the customer's mail client and ours.
  const sentRows = rows.filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message)).filter(Boolean) as CrmEmailEntry[]
  const original = sentRows.find((e) => e.id === first.emailId) ?? sentRows.find((e) => e.bot)
  if (!original) return { ok: false, state: 'failed', why: 'the first email is missing from the timeline' }
  const thread = await threadContextFor(id, original.gmailId)
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`

  const cfg = googleConfig(PUBLIC_BASE)
  if (!cfg) return { ok: false, state: 'failed', why: 'Google OAuth is not configured' }
  const sig = await buildSendSignature({ memberEmail: first.agent, workspace: 'packaging', siteId, from: first.from, base: PUBLIC_BASE })
  const emailId = newEmailId()
  const finalText = sig.text ? `${fu.text}\n\n${sig.text}` : fu.text
  const finalHtml = `${emailHtml(fu.text)}${sig.html}${openPixelHtml(PUBLIC_BASE, id, emailId)}`

  if (!(await ledger(id, siteId, { step: 'followup', n, state: 'claimed', at: now.toISOString(), to: first.to, agent: first.agent }))) {
    return { ok: false, state: 'failed', why: 'ledger write failed' }
  }
  let sent
  try {
    sent = await sendEmail(first.agent, cfg, {
      from: first.from, to: first.to, subject, body: finalText, html: finalHtml,
      threadId: thread?.threadId, inReplyTo: thread?.inReplyTo, references: thread?.references,
    })
  } catch (e) {
    const why = e instanceof GmailAuthError ? `${first.agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
    await ledger(id, siteId, { step: 'followup', n, state: 'failed', at: new Date().toISOString(), why, to: first.to, agent: first.agent })
    return { ok: false, state: 'failed', n, why }
  }

  const at = new Date().toISOString()
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: first.agent, from: first.from, to: first.to, subject,
    body: finalText, html: finalHtml, snippet: makeSnippet(fu.text), at,
    gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId,
    direction: 'outbound', bot: true,
  }
  await writeControlRow({ sessionId: id, siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })

  // Every third unanswered follow-up, a person picks up the phone.
  const callTask = n % CALL_TASK_EVERY === 0
  if (callTask) {
    const who = lead?.name || first.to
    const task: CrmTaskEntry = {
      id: newTaskId(),
      title: `Call ${who} — ${n} follow-ups and no reply yet (bot)`.slice(0, 200),
      type: 'call', due_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      assignee: first.agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    await sendPushToMember(first.agent, 'packaging', {
      title: 'Call this customer',
      body: `${who} has not answered ${n} follow-ups. A call usually gets the reply.`,
      url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-call-${id}`,
    }).catch(() => 0)
  }

  await ledger(id, siteId, { step: 'followup', n, state: 'sent', at, to: first.to, agent: first.agent, from: first.from, emailId, offer: fu.offer ?? undefined })
  return { ok: true, state: 'sent', n, text: fu.text, callTask }
}
