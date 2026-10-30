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

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { isUkSite } from './metawa'
import { recentIntakeLags } from './intakelag'
import { workspaceSites, hasFeature } from './workspaces'
import { quoteSessionId, leadSource, isMerchantTestOrder } from './quoteintake'
import { leadRecipient, writeControlRow, markThreadRepliesRead } from './leadrecord'
import { notALeadSessions, parseNotALead } from './notalead'
import { ASSIGNMENT_ROLE, setAssignment } from './assignment'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from './replyauthor'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import {
  CRM_STAGE_ROLE, CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, CRM_TASK_ROLE, CRM_WA_IN_ROLE,
  parseCrmStage, stageFromLeadStatus, CRM_NOT_A_LEAD_ROLE,
} from './crm'
import { applyStageChange } from './stagechange'
import { threadContextFor, isNoiseSender } from './emailsweep'
import { CRM_EMAIL_IN_ROLE, parseCrmEmailIn } from './emailreply'
import { googleConfig, verifiedAliases, sendEmail, fetchThread, GmailAuthError, type SendAsAlias } from './gmail'
import { makeSnippet, newEmailId, isAddress, parseCrmEmail, type CrmEmailEntry } from './crmemail'
import { openPixelHtml } from './emailtrack'
import { lastDraftProblem, draftCustomerEmail } from './quotebotdraft'
import { CRM_BOT_DRAFT_ROLE, newDraftId, type BotDraft } from './botdraft'
import { customerCc } from './customercc'
import { buildSendSignature } from './sendsignature'
import { unsubscribeUrl, unsubscribedSet } from './unsubscribe'
import { newTaskId, type CrmTaskEntry } from './tasks'
import { sendPushToMember } from './push'
import { llmComplete, CLAUDE_CHAT_MODEL } from './llm'
import {
  ASSESS_SYSTEM, BOT_ACTOR, parseAssessment, buildFirstEmail, missingOf, buildFollowUp,
  FOLLOW_UP_GAP_DAYS, CALL_TASK_EVERY, REPLY_SYSTEM, parseReplyDecision, buildReplyAnswer,
  buildQuoteFollowUp, currentOrNextCampaign, buildPromoEmail, promoFooterHtml, type Missing,
  quoteTextForAssessment, emailHtml, type QuoteAssessment, oversizeIn, hasMeasurement, feasibilityIn,
} from './quotebotcore'

export const CRM_BOT_ROLE = 'crm_bot'

/**
 * Owner, 2026-10-22: the bot's customer emails are DRAFTS for a person to send
 * (it was answering wrongly). 'draft' parks the first email and the reply to a
 * customer's answer on the lead for the agent; 'send' is the old behaviour.
 * Follow-ups and quote follow-ups are fixed templates and still go by
 * themselves — but only once the agent has sent the first email.
 */
export const BOT_EMAIL_MODE: 'send' | 'draft' = 'draft'

/** After a price goes out, the first follow-up the NEXT day; then every
 *  FOLLOW_UP_GAP_DAYS (Saifullah, 2026-10-22: "quote sent ko 1st followup next
 *  day laazmi jana chahiye agar response nahi aata"). */
export const QUOTE_FIRST_FU_DAYS = 1
const quoteGapDays = (sentSoFar: number) => (sentSoFar === 0 ? QUOTE_FIRST_FU_DAYS : FOLLOW_UP_GAP_DAYS)

/** The agents the bot writes for. The owner's roster on 2026-10-13. */
/** Team lead with dev@ access: owner of leads that reached the CRM late. */
const LATE_LEAD_OWNER = 'samirkhan@shopcardboardboxes.com'

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

export type BotState = 'claimed' | 'sent' | 'skipped' | 'failed' | 'drafted'

export interface BotLedger {
  step: 'first' | 'followup' | 'reply' | 'quote' | 'quote_fu' | 'promo'
  /** step 'promo': which campaign, e.g. "black-friday-2026". */
  campaign?: string
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
  /** step 'reply': the customer email (Gmail id) this row answered. */
  inboundId?: string
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
  followUps?: { leadId: string; state: string; n?: number; why?: string }[]
  replies?: ({ leadId: string } & ReplyResult)[]
  quotes?: { leadId: string; state: string; n?: number; why?: string }[]
}

export interface ReplyResult { state: 'sent' | 'drafted' | 'handed-over' | 'stood-down' | 'failed' | 'would-send'; why?: string; complete?: boolean; text?: string }

interface LeadRow { id: string; site_id: string; name: string | null; email: string | null; message: string | null; created_at: string }
interface LogRow { session_id: string; role: string; message: string; created_at: string }

/**
 * Everyone the customer copied, as a Cc header value ('' when nobody): the
 * enquiry's own Cc line plus the Cc of every email they have sent on this
 * lead. Owner, 2026-10-22: "bot ko chahie ke CC walon ko bhi email karde."
 */
async function ccForLead(sessionId: string, leadText: string | null | undefined, customer: string): Promise<string> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', sessionId).eq('role', CRM_EMAIL_IN_ROLE).limit(200)
  const inbound = (data ?? []).map((r) => parseCrmEmailIn(r.message))
    .filter((e): e is NonNullable<typeof e> => !!e && e.from.toLowerCase() === customer.toLowerCase()).map((e) => e.cc ?? '')
  return customerCc({ customer, leadText, inboundCc: inbound }).join(', ')
}

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
    supabase.from('chat_logs').select('session_id, message').eq('role', CRM_EMAIL_ROLE)
      .gte('created_at', since).ilike('message', needle).limit(200),
    supabase.from('chat_logs').select('session_id, message').eq('role', CRM_BOT_ROLE)
      .gte('created_at', since).ilike('message', needle).limit(200),
  ])
  // A holiday promo is not a reply. Counting it once let a promo that reached
  // a brand-new lead block that lead's first answer (Grace, 26 Oct 2026).
  const promoMail = new Set<string>()
  for (const r of bot.data ?? []) {
    const e = parseBotLedger(r.message)
    if (e?.step === 'promo' && e.emailId) promoMail.add(e.emailId)
  }
  if ((mail.data ?? []).some((r) => !notLeads.has(r.session_id) && !promoMail.has(parseCrmEmail(r.message)?.id ?? ''))) return true
  return (bot.data ?? []).some((r) => {
    if (notLeads.has(r.session_id)) return false
    const e = parseBotLedger(r.message)
    return e?.step !== 'promo' && (e?.state === 'sent' || e?.state === 'claimed')
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

/**
 * How many new leads the bot gave each agent today and this week, so neither
 * inbox gets every one. Today (the agents' day, Pakistan time) is weighed
 * first: balancing on the week alone let one day run 9–4 to Samir and the next
 * 11–7 to Steve as the tally caught up — Steve: "ye assign bhi 50 50 nhi kar
 * rha, kal almost 70-80% mjhe assign ki hain". Each day is now split within
 * one lead; the week count only breaks the tie.
 */
async function weeklyLoad(now: Date): Promise<Map<string, { day: number; week: number }>> {
  const since = new Date(now.getTime() - 7 * 864e5).toISOString()
  const today = agentDay(now)
  // Lease rows (one per run, ~2,000 a week) are left out and the rest paged:
  // PostgREST hands back at most 1000 rows, and with the lease rows in, the
  // week's real first emails fell off the end within a few days.
  const data = await fetchAllPages(
    () => supabase.from('chat_logs').select('message,created_at')
      .eq('role', CRM_BOT_ROLE).neq('session_id', LEASE_SESSION).gte('created_at', since)
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
    50000,
  )
  const load = new Map<string, { day: number; week: number }>(BOT_AGENTS.map((a) => [a, { day: 0, week: 0 }]))
  for (const r of data) {
    const e = parseBotLedger(r.message)
    // New leads only. Counting follow-ups and replies too made one long
    // conversation (a test lead with a dozen follow-ups) push every new lead
    // to the other agent for a week.
    if (e?.step !== 'first' || e.state !== 'sent' || !e.agent || !load.has(e.agent)) continue
    const l = load.get(e.agent)!
    l.week++
    if (agentDay(new Date(e.at ?? r.created_at)) === today) l.day++
  }
  return load
}

/** The calendar day in Pakistan (UTC+5), where both agents sit. */
function agentDay(d: Date): string {
  return new Date(d.getTime() + 5 * 3600e3).toISOString().slice(0, 10)
}

/** The assessment's reason says the sender is selling to us. Tight on purpose:
 *  backtested on every skip since 2026-10-13 (23 pitches matched, none of the
 *  real enquiries — resellers, Veritiv for a client, fulfilment asks, an
 *  existing customer's sign-off — did). */
export function isVendorPitch(reason: string): boolean {
  return /\b(selling|sell|pitch(?:ing)?|soliciting|offering)\b[^.;]{0,70}\bto us\b|\b(supplier|factory|vendor|seo|marketing|trustpilot|logistics|freight|trucking)\b[^.;]{0,30}\b(pitch|pitching|selling|soliciting)\b|\b(sales|marketing|seo|business|supplier) pitch\b|\bsoliciting\b|\bpitching (a |their |its )?(service|services)\b/i.test(reason)
}

export async function assessQuote(message: string, name: string | null): Promise<QuoteAssessment | null> {
  const r = await llmComplete({
    system: ASSESS_SYSTEM,
    messages: [{ role: 'user', content: quoteTextForAssessment(message, name) }],
    maxTokens: 1200, anthropicMaxTokens: 400, temperature: 0,
    model: CLAUDE_CHAT_MODEL, timeoutMs: 25000,
  })
  if (r.error) return null
  const a = parseAssessment(r.text)
  // A container's capacity is a size: "2ml vial", "10 oz tumbler", "750ml
  // bottle" — the box is built around it, and our agents priced from it.
  if (a && !a.hasSize && /\b\d+(\.\d+)?\s?(ml|oz|cl|l)\b/i.test(message) && /vial|bottle|tumbler|cup/i.test(message) && !/candle|jar|\btins?\b/i.test(message)) a.hasSize = true
  if (a && !a.hasSize && /\b(A[3-6]|letter[- ]size|business[- ]card[- ]size)\b/i.test(message)) a.hasSize = true
  // A size word with no measurement anywhere ("Standard", "Medium") is not a
  // size: ask for it rather than promise a quote (hasMeasurement).
  if (a && a.hasSize && !hasMeasurement(message)) a.hasSize = false
  // A size we may not be able to make at all: no price promise, a person
  // checks with production first (oversizeIn, lib/quotebotcore.ts).
  if (a) { const big = oversizeIn(message); if (big) a.oversize = big }
  if (a) { const no = feasibilityIn(message); if (no) a.feasibility = no }
  if (a && /\b(samples?|prototypes?)\b/i.test(message)) a.asksSample = true
  if (a && /shipping|mailer|corrugat/i.test(`${a.product} ${message}`) && /\b(candles?|jars?|tins?|bottles?)\b/i.test(message) && !/(per|each|one) box|multi[- ]?pack|\bsingle\b|\d+\s*(candles|jars|tins|bottles)\s*(per|in each|in one)/i.test(message)) a.askPackCount = true
  return a
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
  if (!leads.length) return withFollowUps(result, now, dryRun, opts.leadIds?.length ? 0 : MAX_SENDS_PER_RUN)

  const sessions = leads.map((l) => quoteSessionId(l.id))
  // Paged: a plain select stops at 1,000 rows. Past that the newest leads'
  // ledger rows were cut off, the bot read them as never handled, and drafted
  // them again every five minutes — 150+ drafts and tasks a lead, each run
  // adding rows that pushed more leads past the cut (25-26 Oct 2026).
  const [logRows, excluded, siteRes] = await Promise.all([
    fetchAllPages<LogRow & { session_id: string }>(() => supabase.from('chat_logs').select('session_id, role, message, created_at')
      .in('session_id', sessions)
      .in('role', [CRM_BOT_ROLE, CRM_STAGE_ROLE, LEAD_STATUS_ROLE, CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, ASSIGNMENT_ROLE])
      .order('created_at', { ascending: true }), 100_000),
    notALeadSessions(sites),
    supabase.from('sites').select('site_id, name'),
  ])
  const bySession = new Map<string, LogRow[]>()
  for (const r of logRows as LogRow[]) {
    const list = bySession.get(r.session_id) ?? []
    list.push(r)
    bySession.set(r.session_id, list)
  }
  const siteName = new Map((siteRes.data ?? []).map((s) => [s.site_id, String(s.name ?? s.site_id)]))
  const cfg = googleConfig(origin)
  // Counted up as this run hands leads out, not just read once — otherwise a
  // run with five new leads gives all five to whoever was lighter at the start.
  let load: Map<string, { day: number; week: number }> | null = null
  let sends = 0
  // Leads that reached the CRM late (lib/intakelag.ts: 45+ minutes after the
  // customer wrote). By then a person may already have answered from Gmail —
  // the form mail also lands in dev@, which Samir works — and a bot email on
  // top reads to the customer as two companies talking at once (owner,
  // 2026-10-15). The bot never writes first to these; Samir gets the lead and
  // a task to check Gmail and carry on from the record.
  const late = new Map((await recentIntakeLags(undefined, 200)).map((l) => [l.leadId, l.minutesLate]))

  for (const lead of leads) {
    const id = quoteSessionId(lead.id)
    const rows = bySession.get(id) ?? []
    const act = (a: Omit<BotAction, 'leadId' | 'siteId'>) => { result.actions.push({ leadId: id, siteId: lead.site_id, ...a }) }

    // ── stand down quietly: these were never the bot's ──────────────────────
    if (rows.some((r) => r.role === CRM_BOT_ROLE)) continue // already handled, once
    // Second line of defence, asked of the database for this one lead: a page
    // that failed above must never turn into a second draft.
    if (!dryRun) {
      const { data: done, error: doneErr } = await supabase.from('chat_logs').select('id').eq('session_id', id).eq('role', CRM_BOT_ROLE).limit(1)
      if (doneErr || done?.length) continue
    }
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

    // A chat lead is ALSO a live chat record — the one the dashboard lists and
    // agents work. Its assignment, its stage and anything an agent did there
    // count too. Before 2026-10-14 the bot looked only at quote-<id>, so it
    // emailed Herman a minute before Steve did from the chat he was in, wrote
    // to Karen as Steve while Samir owned her chat, and its "Contacted" never
    // reached the record the list shows.
    const chat = kind === 'chat' ? await chatSessionFor(lead) : null
    if (chat) {
      const cHuman = chat.rows.find((r) => r.role === CRM_EMAIL_ROLE || r.role === CRM_WA_OUT_ROLE || r.role === CRM_CALL_ROLE)
      if (cHuman) { await skip(`an agent already reached out on the chat (${cHuman.role})`); continue }
      const cStage = currentStage(chat.rows)
      if (cStage !== 'new') { await skip(`chat stage is already ${cStage}`); continue }
      const talker = chat.rows.map((r) => r.role === REPLY_AUTHOR_ROLE ? (parseReplyAuthor(r.message)?.email ?? '').toLowerCase() : '')
        .find((e) => (BOT_AGENTS as readonly string[]).includes(e))
      if (talker) { await skip(`${talker} is already talking to them in the chat`); continue }
    }

    // The bot stands down but the lead must not sit there unowned: Samir gets
    // it with a task and a push, so a person answers instead of nobody.
    const handOver = async (why: string, title: string, push: { title: string; body: string }, tag: string) => {
      await skip(why)
      if (dryRun) return
      await setAssignment(id, lead.site_id, LATE_LEAD_OWNER)
      const task: CrmTaskEntry = {
        id: newTaskId(), title: title.slice(0, 200),
        type: 'email', due_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        assignee: LATE_LEAD_OWNER, status: 'open', created_by: BOT_ACTOR, created_at: now.toISOString(),
      }
      await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
      await sendPushToMember(LATE_LEAD_OWNER, 'packaging', { ...push, url: `/leads/${encodeURIComponent(id)}`, tag: `${tag}-${id}` }).catch(() => 0)
    }
    const who = lead.name || lead.email || 'This customer'

    const lateBy = late.get(lead.id)
    if (lateBy !== undefined) {
      await handOver(
        `reached the CRM ${lateBy} min after the customer wrote — a person may already have answered from Gmail`,
        `${who} reached ZeeOps ${lateBy} min late — check Gmail (dev@) for a reply already sent, then answer from here`,
        { title: 'Late enquiry — check Gmail first', body: `${who}: arrived ${lateBy} min late. The bot did not email them.` },
        'quotebot-late',
      )
      continue
    }

    const to = await leadRecipient(id)
    if (!to) { await skip('no email address on the lead'); continue }
    if (!isAddress(to)) { await skip(`"${to}" is not a valid email address`); continue }
    if (await addressAlreadyContacted(to, now, excluded)) { await skip('this address was already emailed in the last 30 days', { to }); continue }

    const assessment = await assessQuote(lead.message ?? '', lead.name)
    // The model being down is not a decision about the lead: no ledger row, so
    // the next run tries again (until the lead ages out of the window).
    if (!assessment) { act({ state: 'retry-later', why: 'could not read the enquiry (model unavailable)' }); continue }
    if (!assessment.isQuote) {
      await skip(`not a packaging quote: ${assessment.reason}`)
      // Somebody selling TO us — a factory, a supplier, SEO or logistics — is
      // not a lead and must not sit in the counts (owner, 2026-10-30: "factory
      // wali count kiun kar rahe"). Marked, not deleted: the same reversible
      // "not a lead" row the owner sets by hand (lib/notalead.ts).
      if (!dryRun && isVendorPitch(assessment.reason)) {
        const mark = JSON.stringify({ spam: true, by: BOT_ACTOR, at: now.toISOString(), reason: `selling to us: ${assessment.reason}`.slice(0, 200) })
        for (const sid of new Set([id, chat?.sessionId].filter(Boolean) as string[])) {
          await writeControlRow({ sessionId: sid, siteId: lead.site_id, role: CRM_NOT_A_LEAD_ROLE, message: mark })
        }
      }
      continue
    }
    if (!assessment.language.startsWith('en')) { await skip(`customer wrote in "${assessment.language}" — left for a person`); continue }

    // ── whose lead, and which address ───────────────────────────────────────
    const assigned = lastAssignment(rows) ?? (chat ? lastAssignment(chat.rows) : null)
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
    const candidates = preset ? [preset] : [...BOT_AGENTS].sort((a, b) => {
      const x = tally.get(a)!, y = tally.get(b)!
      return (x.day - y.day) || (x.week - y.week)
    })
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
    if (!agent || !alias) {
      // A new site with no send-as alias yet (thecustomfolders.com, 15 Oct
      // 2026: its first two leads would have been skipped in silence).
      const host = siteName.get(lead.site_id) ?? lead.site_id
      await handOver(
        `no verified ${lead.site_id} mailbox for ${candidates.join(' / ')}`,
        `${who} — ${host} has no sending mailbox in ZeeOps yet. Reply from Gmail (dev@) and ask the owner to add a send-as alias for ${lead.site_id}`,
        { title: 'New enquiry — no mailbox for this site yet', body: `${who} (${host}): the bot cannot send from this site. Please reply from Gmail.` },
        'quotebot-nomailbox',
      )
      continue
    }

    const mail = buildFirstEmail(assessment, { siteName: siteName.get(lead.site_id) ?? lead.site_id, fromChat: kind === 'chat' })
    // Written for this customer from what they wrote (lib/quotebotdraft.ts);
    // the template above stays as the fallback and keeps the subject.
    const drafted = await draftCustomerEmail({
      kind: 'first', fromChat: kind === 'chat', enquiry: quoteTextForAssessment(lead.message ?? '', lead.name),
      assessment, siteName: siteName.get(lead.site_id) ?? lead.site_id,
    })
    if (drafted) mail.text = drafted.text
    const missing = missingOf(assessment)
    const preview = { agent, from: alias.email, to, subject: mail.subject, text: mail.text, complete: mail.complete, missing }
    const used = tally.get(agent) ?? { day: 0, week: 0 }
    tally.set(agent, { day: used.day + 1, week: used.week + 1 })

    if (dryRun) { act({ state: 'would-send', why: assessment.reason, ...preview }); continue }
    if (sends >= MAX_SENDS_PER_RUN) { act({ state: 'retry-later', why: 'per-run send cap reached' }); continue }

    const cc = await ccForLead(id, lead.message, to)
    if (BOT_EMAIL_MODE === 'draft') {
      // Park it for the agent (owner, 2026-10-22). The lead is theirs from now
      // on, with a task and a push; nothing reaches the customer until they
      // press Send on the record.
      const at = now.toISOString()
      const draft: BotDraft = {
        id: newDraftId(), step: 'first', status: 'pending', agent, from: alias.email, to,
        subject: mail.subject, text: mail.text, complete: mail.complete, missing, at,
        chatSessionId: chat?.sessionId, cc: cc || undefined,
      }
      if (!(await ledger(id, lead.site_id, { step: 'first', state: 'drafted', at, to, agent, from: alias.email, complete: mail.complete, missing }))) {
        act({ state: 'retry-later', why: 'ledger write failed' }); continue
      }
      await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_BOT_DRAFT_ROLE, message: JSON.stringify(draft) })
      if (!preset) await setAssignment(id, lead.site_id, agent)
      if (chat && !lastAssignment(chat.rows)) await setAssignment(chat.sessionId, lead.site_id, agent)
      const who = lead.name || to
      const task: CrmTaskEntry = {
        id: newTaskId(),
        title: `Review and send the first reply to ${who} — the bot drafted it on the record (${mail.complete ? 'all details given' : 'asks for ' + missing.join(', ')})`.slice(0, 200),
        type: 'email', due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        assignee: agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
      }
      await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
      await sendPushToMember(agent, 'packaging', {
        title: 'New enquiry — draft reply ready',
        body: `${who} (${siteName.get(lead.site_id) ?? lead.site_id}). Read the bot's draft and send it.`,
        url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-draft-${id}`,
      }).catch(() => 0)
      act({ state: 'drafted', why: assessment.reason, ...preview })
      continue
    }

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
      sent = await sendEmail(agent, cfg, { from: alias.email, to, cc: cc || undefined, subject: mail.subject, body: finalText, html: finalHtml })
    } catch (e) {
      const why = e instanceof GmailAuthError ? `${agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
      await ledger(id, lead.site_id, { step: 'first', state: 'failed', at: new Date().toISOString(), why, to, agent })
      act({ state: 'failed', why, ...preview })
      continue
    }

    const at = new Date().toISOString()
    const entry: CrmEmailEntry = {
      id: emailId, sentBy: agent, from: alias.email, to, cc: cc || undefined, subject: mail.subject,
      body: finalText, html: finalHtml, snippet: makeSnippet(mail.text), at,
      gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId,
      direction: 'outbound', bot: true,
    }
    await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
    if (!preset) await setAssignment(id, lead.site_id, agent)
    await applyStageChange({ leadId: id, siteId: lead.site_id, stage: 'contacted', previous: 'new', actorEmail: BOT_ACTOR })
    if (chat) {
      // A chat lead is also its chat conversation — the record the dashboard's
      // Recent Leads and the conversation list show. Same stage and owner
      // there, or it keeps saying New and unassigned after the bot wrote.
      if (!lastAssignment(chat.rows)) await setAssignment(chat.sessionId, lead.site_id, agent)
      await applyStageChange({ leadId: chat.sessionId, siteId: lead.site_id, stage: 'contacted', previous: 'new', actorEmail: BOT_ACTOR })
    }

    if (mail.complete) {
      const who = lead.name || to
      const task: CrmTaskEntry = {
        id: newTaskId(),
        title: (assessment.oversize
          ? `Check with production first — ${who} wants ${assessment.product} at ${assessment.oversize}; the bot said we are confirming the size, then send the price quote or an alternative`
          : `Send the price quote — ${who} gave size and style${assessment.hasQuantity ? ' and quantity' : '; NO quantity yet, so quote 250 / 500 / 1,000 as the bot told them'} (bot replied)`).slice(0, 200),
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

  return withFollowUps(result, now, dryRun, opts.leadIds?.length ? 0 : MAX_SENDS_PER_RUN - sends)
}

/** How far back a bot lead can still be followed up. Long, on purpose: the
 *  owner's rule is "until they reply" — this only bounds the query. */
const FOLLOW_UP_WINDOW_DAYS = 180

// Every lead the bot asked for details and is still waiting on. Leads that
// were complete on arrival are left alone here: the next move there is OUR
// price, and chasing a customer for an answer we owe them reads badly. Their
// follow-ups begin once the price is sent (Step 3).
async function withFollowUps(result: BotRunResult, now: Date, dryRun: boolean, budget: number): Promise<BotRunResult> {
  if (budget <= 0) return result
  // ONE bounded query, and due-ness worked out from the bot's own ledger, so a
  // run touches only leads that are actually due. Checking every bot lead's
  // timeline every five minutes would be hundreds of thousands of queries a
  // day against a database that has fallen over once already (CLAUDE.md §6).
  const since = new Date(now.getTime() - FOLLOW_UP_WINDOW_DAYS * 864e5).toISOString()
  // Paged (fetchAllPages): a plain select stops at 1,000 rows whatever .limit()
  // says, and this ledger is past 10,000 — the newest leads were never seen
  // here, so they got no follow-up and no answer to their replies.
  const data = await fetchAllPages<{ session_id: string; site_id: string; message: string }>(() => supabase.from('chat_logs').select('session_id, site_id, message')
    .eq('role', CRM_BOT_ROLE).neq('session_id', LEASE_SESSION).gte('created_at', since)
    .order('created_at', { ascending: true }), 60000)
  warnIfCapped('follow-up ledger', data.length, 60000)
  const state = new Map<string, { siteId: string; waiting: boolean; stopped: boolean; lastAt: number; anchor: number; handled: Set<string> }>()
  for (const r of data ?? []) {
    const e = parseBotLedger(r.message)
    if (!e) continue
    const cur = state.get(r.session_id) ?? { siteId: r.site_id, waiting: false, stopped: false, lastAt: 0, anchor: 0, handled: new Set<string>() }
    const at = new Date(e.at).getTime()
    if (e.step === 'first' && e.state === 'sent') { cur.waiting = e.complete === false; cur.lastAt = at; cur.anchor = at }
    if (e.step === 'reply' && e.inboundId) cur.handled.add(e.inboundId)
    // A draft waiting on the agent: no follow-up chases the customer meanwhile.
    if (e.state === 'drafted') cur.stopped = true
    if (e.step === 'reply' && e.state === 'sent') { cur.waiting = e.complete === false; cur.lastAt = Math.max(cur.lastAt, at); cur.anchor = Math.max(cur.anchor, at) }
    if (e.step === 'reply' && e.state === 'skipped') cur.stopped = true
    // A failed send counts as an attempt: try again in three days, not in five
    // minutes and then every five minutes after that.
    if (e.step === 'followup' && (e.state === 'sent' || e.state === 'failed')) cur.lastAt = Math.max(cur.lastAt, new Date(e.at).getTime())
    if (e.step === 'followup' && e.state === 'skipped') cur.stopped = true
    state.set(r.session_id, cur)
  }
  // ── first, answer anyone who wrote back ────────────────────────────────
  result.replies = []
  const open = [...state.entries()].filter(([, v]) => v.waiting && !v.stopped)
  const inbound = new Map<string, { gmailId: string; at: number; from: string; body: string }[]>()
  for (let i = 0; i < open.length; i += 100) {
    const { data: inRows } = await supabase.from('chat_logs').select('session_id, message, created_at')
      .eq('role', CRM_EMAIL_IN_ROLE).in('session_id', open.slice(i, i + 100).map(([id]) => id))
      .gte('created_at', since).order('created_at', { ascending: true })
    for (const r of inRows ?? []) {
      const e = parseCrmEmailIn(r.message)
      if (!e || isNoiseSender(e.from)) continue
      const list = inbound.get(r.session_id) ?? []
      list.push({ gmailId: e.gmailId, at: new Date(r.created_at).getTime(), from: e.from, body: e.body })
      inbound.set(r.session_id, list)
    }
  }
  let used = 0
  for (const [id, v] of open) {
    if (used >= budget) break
    const all = inbound.get(id) ?? []
    const fresh = all.filter((m) => m.at > v.anchor - 1000 && !v.handled.has(m.gmailId))
    if (!fresh.length) continue
    const r = await answerReply(id, v.siteId, all, fresh[fresh.length - 1], now, dryRun)
    result.replies.push({ leadId: id, ...r })
    if (r.state === 'sent' || r.state === 'handed-over' || r.state === 'drafted') used++
    if (r.state !== 'failed') v.stopped = true // answered this run: no follow-up on top of it
  }

  const due = [...state.entries()]
    .filter(([, v]) => v.waiting && !v.stopped && now.getTime() - v.lastAt >= FOLLOW_UP_GAP_DAYS * 864e5)
    .sort((a, b) => a[1].lastAt - b[1].lastAt)

  result.followUps = []
  let sent = used
  for (const [id, v] of due) {
    if (sent >= budget) break
    const r = await sendFollowUp(id, now, { dryRun })
    result.followUps.push({ leadId: id, state: r.state, n: r.n, why: r.why })
    if (r.state === 'sent') sent++
    // Stopped is final: a reply, a person, a new stage or a spam mark. Written
    // down so this lead never costs a query again.
    if (r.state === 'stopped' && !dryRun) {
      await ledger(id, v.siteId, { step: 'followup', state: 'skipped', at: now.toISOString(), why: `stopped: ${r.why ?? ''}` })
    }
  }
  return withQuotes(result, now, dryRun, budget - sent)
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

/**
 * The live chat a chat lead came from: the newest lead_capture row on the same
 * site carrying the same address — the same match the dashboard's lead list
 * makes, so the bot and the list agree on which record is the lead.
 */
export async function chatSessionFor(lead: LeadRow): Promise<{ sessionId: string; rows: LogRow[] } | null> {
  const email = (lead.email ?? '').trim().toLowerCase()
  if (!email) return null
  const { data: caps } = await supabase.from('chat_logs').select('session_id, message')
    .eq('role', LEAD_CAPTURE_ROLE).eq('site_id', lead.site_id)
    .ilike('message', `%${email.replace(/%/g, '')}%`)
    .order('created_at', { ascending: false }).limit(20)
  const hit = (caps ?? []).find((r) => (parseLeadCapture(r.message)?.email ?? '').toLowerCase() === email)
  if (!hit) return null
  const { data } = await supabase.from('chat_logs').select('session_id, role, message, created_at')
    .eq('session_id', hit.session_id)
    .in('role', [CRM_STAGE_ROLE, LEAD_STATUS_ROLE, CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, ASSIGNMENT_ROLE, REPLY_AUTHOR_ROLE])
    .order('created_at', { ascending: true }).limit(1000)
  return { sessionId: hit.session_id, rows: (data ?? []) as LogRow[] }
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
export async function sendFollowUp(leadId: string, now = new Date(), opts: { force?: boolean; dryRun?: boolean } = {}): Promise<FollowUpResult> {
  const id = leadId.startsWith('quote-') ? leadId : `quote-${leadId}`
  const { data } = await supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
    .eq('session_id', id)
    .in('role', [CRM_BOT_ROLE, CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE, CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE,
      CRM_STAGE_ROLE, LEAD_STATUS_ROLE, CRM_NOT_A_LEAD_ROLE])
    .order('created_at', { ascending: true })
  const rows = (data ?? []) as (LogRow & { site_id: string })[]
  const notALead = rows.filter((r) => r.role === CRM_NOT_A_LEAD_ROLE).map((r) => parseNotALead(r.message)).filter(Boolean).pop()
  if (notALead?.spam) return { ok: true, state: 'stopped', why: 'marked not a lead' }
  const ledgers = rows.filter((r) => r.role === CRM_BOT_ROLE).map((r) => parseBotLedger(r.message)).filter(Boolean) as BotLedger[]
  const first = ledgers.find((e) => e.step === 'first' && e.state === 'sent')
  if (!first || !first.agent || !first.from || !first.to) return { ok: false, state: 'stopped', why: 'the bot never emailed this lead' }
  const siteId = rows[0].site_id
  const firstAt = new Date(first.at).getTime()

  // The bot's latest word: its first email, or its answer to a reply.
  const replies = ledgers.filter((e) => e.step === 'reply')
  if (replies.some((e) => e.state === 'skipped')) return { ok: true, state: 'stopped', why: 'the bot handed this lead to a person' }
  const answered = replies.filter((e) => e.state === 'sent')
  const latest = answered[answered.length - 1] ?? first
  if (latest.complete) return { ok: true, state: 'stopped', why: 'the customer gave every detail — the price is with a person' }
  const anchor = new Date(latest.at).getTime()
  const handled = new Set(replies.map((e) => e.inboundId).filter(Boolean))

  // ── has anyone else spoken since? ────────────────────────────────────────
  const after = rows.filter((r) => new Date(r.created_at).getTime() > firstAt - 1000)
  if (after.some((r) => r.role === CRM_WA_IN_ROLE)) return { ok: true, state: 'stopped', why: 'the customer answered on WhatsApp — a person carries it on' }
  const pending = after.find((r) => {
    if (r.role !== CRM_EMAIL_IN_ROLE) return false
    const e = parseCrmEmailIn(r.message)
    return !!e && !isNoiseSender(e.from) && !handled.has(e.gmailId) && new Date(r.created_at).getTime() > anchor - 1000
  })
  // Not a stop: the reply pass answers it (or hands it over) on this same run.
  if (pending) return { ok: true, state: 'not-due', why: 'the customer replied — waiting for the reply to be answered' }
  const human = after.find((r) => r.role === CRM_WA_OUT_ROLE || r.role === CRM_CALL_ROLE
    || (r.role === CRM_EMAIL_ROLE && !parseCrmEmail(r.message)?.bot))
  if (human) return { ok: true, state: 'stopped', why: `an agent reached the customer themselves (${human.role})` }
  // Moved on by a person (quote sent, won, lost, on hold...) — not ours to chase.
  const stage = currentStage(rows)
  if (stage !== 'contacted') return { ok: true, state: 'stopped', why: `stage is ${stage}` }

  const sentUps = ledgers.filter((e) => e.step === 'followup' && e.state === 'sent')
  const n = sentUps.length + 1
  const lastAt = Math.max(anchor, ...sentUps.map((e) => new Date(e.at).getTime()))
  if (!opts.force && now.getTime() - lastAt < FOLLOW_UP_GAP_DAYS * 864e5) {
    return { ok: true, state: 'not-due', n, why: `next one is due ${new Date(lastAt + FOLLOW_UP_GAP_DAYS * 864e5).toISOString()}` }
  }

  // ── what to say ──────────────────────────────────────────────────────────
  const { data: lead } = await supabase.from('leads').select('name, message').eq('id', id.replace(/^quote-/, '')).maybeSingle()
  const assessment = await assessQuote(lead?.message ?? '', lead?.name ?? null)
  if (!assessment) return { ok: false, state: 'failed', why: 'could not read the enquiry (model unavailable)' }
  const cc = await ccForLead(id, lead?.message, first.to)
  const missing = (latest.missing ?? []) as Missing[]
  const fu = buildFollowUp(assessment, { n, missing, firstName: assessment.firstName, now, uk: isUkSite(siteId) })

  // Threaded under the first email, in the customer's mail client and ours.
  const sentRows = rows.filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message)).filter(Boolean) as CrmEmailEntry[]
  // Answer the bot's latest email in the thread, so the customer's client
  // stacks the follow-up under the message it follows.
  const original = [...sentRows].reverse().find((e) => e.bot) ?? sentRows.find((e) => e.id === first.emailId)
  if (!original) return { ok: false, state: 'failed', why: 'the first email is missing from the timeline' }
  if (opts.dryRun) return { ok: true, state: 'not-due', n, text: fu.text, why: 'dry run: would send now' }
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
      from: first.from, to: first.to, cc: cc || undefined, subject, body: finalText, html: finalHtml,
      threadId: thread?.threadId, inReplyTo: thread?.inReplyTo, references: thread?.references,
    })
  } catch (e) {
    const why = e instanceof GmailAuthError ? `${first.agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
    await ledger(id, siteId, { step: 'followup', n, state: 'failed', at: new Date().toISOString(), why, to: first.to, agent: first.agent })
    return { ok: false, state: 'failed', n, why }
  }

  const at = new Date().toISOString()
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: first.agent, from: first.from, to: first.to, cc: cc || undefined, subject,
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

// ── Answering a reply ───────────────────────────────────────────────────────
/**
 * The customer wrote back to the bot. If all they did was send details, the
 * bot answers: "thanks, the price is in process" when nothing is missing any
 * more (and the agent gets the task to price it), or a short ask for whatever
 * is still missing. Anything else is handed to the agent with a task.
 */
export async function answerReply(
  id: string, siteId: string,
  all: { gmailId: string; at: number; from: string; body: string }[],
  latest: { gmailId: string; body: string },
  now: Date, dryRun: boolean,
): Promise<ReplyResult> {
  const { data: logRows } = await supabase.from('chat_logs').select('role, message, created_at')
    .eq('session_id', id).in('role', [CRM_BOT_ROLE, CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE]).order('created_at', { ascending: true })
  const ledgers = (logRows ?? []).filter((r) => r.role === CRM_BOT_ROLE).map((r) => parseBotLedger(r.message)).filter(Boolean) as BotLedger[]
  const first = ledgers.find((e) => e.step === 'first' && e.state === 'sent')
  if (!first?.agent || !first.from || !first.to) return { state: 'failed', why: 'no first email on record' }

  // ── has a person already answered? ───────────────────────────────────────
  // Once an agent writes, the conversation is theirs. On 2026-10-14 Steve
  // answered Joel from Gmail at 8:03, Joel said "ok thank you", and the bot
  // wrote again at 8:05 — Steve's Gmail reply reached the record three seconds
  // AFTER the bot had read it. So the record is checked, and then the Gmail
  // thread itself, live, right before anything is sent.
  const standDown = async (why: string): Promise<ReplyResult> => {
    if (!dryRun) await ledger(id, siteId, { step: 'reply', state: 'skipped', at: now.toISOString(), why: `stood down: ${why}`, inboundId: latest.gmailId, agent: first.agent })
    return { state: 'stood-down', why }
  }
  // Row times are stored naive-UTC; read them as UTC whatever the host zone.
  const utcMs = (t: string) => new Date(/(Z|[+-]\d\d:?\d\d)$/.test(t) ? t : `${t}Z`).getTime()
  const firstAt = utcMs(first.at)
  const ours = (logRows ?? []).filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message)).filter(Boolean) as CrmEmailEntry[]
  const person = (logRows ?? []).find((r) => utcMs(r.created_at) > firstAt - 1000 && (
    r.role === CRM_WA_OUT_ROLE || r.role === CRM_CALL_ROLE
    || (r.role === CRM_EMAIL_ROLE && !parseCrmEmail(r.message)?.bot)))
  if (person) return standDown(`an agent already reached the customer (${person.role})`)
  const botThread = ours.find((e) => e.bot && e.threadId)?.threadId
  const gcfg = googleConfig(PUBLIC_BASE)
  if (botThread && gcfg) {
    const botIds = new Set(ours.filter((e) => e.bot).map((e) => e.gmailId))
    let msgs
    try { msgs = await fetchThread(first.agent, gcfg, botThread) } catch (e) {
      // Not knowing is not permission: try again next run.
      return { state: 'failed', why: `could not check Gmail for an agent's reply (${e instanceof Error ? e.message : 'error'})` }
    }
    const theirs = msgs.find((m) => m.labelIds.includes('SENT') && !botIds.has(m.gmailId)
      && utcMs(m.at) > firstAt - 1000)
    if (theirs) return standDown('an agent already replied from Gmail')
  }
  const { data: lead } = await supabase.from('leads').select('name, message').eq('id', id.replace(/^quote-/, '')).maybeSingle()
  const who = lead?.name || first.to
  if (!dryRun) await closeBotCallTasks(id, siteId)

  const decided = await llmComplete({
    system: REPLY_SYSTEM, messages: [{ role: 'user', content: latest.body.slice(0, 4000) || '(empty reply — attachment only)' }],
    maxTokens: 600, anthropicMaxTokens: 150, temperature: 0, model: CLAUDE_CHAT_MODEL, timeoutMs: 25000,
  })
  const decision = decided.error ? null : parseReplyDecision(decided.text)
  if (!decision) return { state: 'failed', why: 'could not read the reply (model unavailable)' }

  if (decision.needsPerson) {
    if (dryRun) return { state: 'would-send', why: `would hand over: ${decision.reason}` }
    const at = new Date().toISOString()
    const task: CrmTaskEntry = {
      // The reason is cut, never the ending: "(bot stepped back)" is what tells
      // the agent why this task exists, and a 200-char cap ate it.
      id: newTaskId(), title: `Reply to ${who} — ${clip(decision.reason, 200 - who.length - 40)} (bot stepped back)`,
      type: 'email', due_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      assignee: first.agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    await sendPushToMember(first.agent, 'packaging', {
      title: 'Customer needs you', body: `${who}: ${decision.reason}`,
      url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-reply-${id}`,
    }).catch(() => 0)
    await ledger(id, siteId, { step: 'reply', state: 'skipped', at, why: `handover: ${decision.reason}`, inboundId: latest.gmailId, agent: first.agent })
    return { state: 'handed-over', why: decision.reason }
  }

  // Read the enquiry and every reply together: the size may be in one email
  // and the quantity in the next.
  const combined = `${lead?.message ?? ''}\n\nThe customer's replies to our questions:\n${all.map((m) => m.body).join('\n---\n')}`
  const assessment = await assessQuote(combined, lead?.name ?? null)
  if (!assessment) return { state: 'failed', why: 'could not read the enquiry (model unavailable)' }
  const answer = buildReplyAnswer(assessment, assessment.firstName)
  const priorBot = (logRows ?? []).filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message))
    .filter((e): e is CrmEmailEntry => !!e && e.bot === true).pop()
  const drafted = await draftCustomerEmail({
    kind: 'reply', fromChat: false, enquiry: quoteTextForAssessment(lead?.message ?? '', lead?.name ?? null),
    weAsked: (priorBot?.body ?? '').split('\n--\n')[0], replies: all.map((m) => m.body),
    assessment, siteName: (await supabase.from('sites').select('name').eq('site_id', siteId).maybeSingle()).data?.name ?? siteId,
  })
  if (drafted) answer.text = drafted.text
  if (dryRun) return { state: 'would-send', complete: answer.complete, text: answer.text }

  const cfg = googleConfig(PUBLIC_BASE)
  if (!cfg) return { state: 'failed', why: 'Google OAuth is not configured' }
  const sentRows = (logRows ?? []).filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message)).filter(Boolean) as CrmEmailEntry[]
  const original = [...sentRows].reverse().find((e) => e.bot)
  const subject = original ? (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`) : 'Your packaging quote'
  const cc = await ccForLead(id, lead?.message, first.to)
  if (BOT_EMAIL_MODE === 'draft') {
    // Same rule as the first email: the agent reads it and sends it.
    const at = now.toISOString()
    const draft: BotDraft = {
      id: newDraftId(), step: 'reply', status: 'pending', agent: first.agent, from: first.from, to: first.to,
      subject, text: answer.text, complete: answer.complete, missing: missingOf(assessment), inboundId: latest.gmailId, at,
      cc: cc || undefined,
    }
    if (!(await ledger(id, siteId, { step: 'reply', state: 'drafted', at, inboundId: latest.gmailId, agent: first.agent, from: first.from, to: first.to, complete: answer.complete, missing: missingOf(assessment) }))) {
      return { state: 'failed', why: 'ledger write failed' }
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_BOT_DRAFT_ROLE, message: JSON.stringify(draft) })
    const task: CrmTaskEntry = {
      id: newTaskId(),
      title: `Review and send the reply to ${who} — the bot drafted it on the record${answer.complete ? ' (all details in; price next)' : ''}`.slice(0, 200),
      type: 'email', due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      assignee: first.agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    await sendPushToMember(first.agent, 'packaging', {
      title: 'Customer replied — draft answer ready', body: `${who}: read the bot's draft and send it.`,
      url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-draft-${id}`,
    }).catch(() => 0)
    return { state: 'drafted', complete: answer.complete, text: answer.text }
  }
  const thread = await threadContextFor(id, latest.gmailId)
  if (!(await ledger(id, siteId, { step: 'reply', state: 'claimed', at: now.toISOString(), inboundId: latest.gmailId, agent: first.agent }))) {
    return { state: 'failed', why: 'ledger write failed' }
  }
  const sig = await buildSendSignature({ memberEmail: first.agent, workspace: 'packaging', siteId, from: first.from, base: PUBLIC_BASE })
  const emailId = newEmailId()
  const finalText = sig.text ? `${answer.text}\n\n${sig.text}` : answer.text
  const finalHtml = `${emailHtml(answer.text)}${sig.html}${openPixelHtml(PUBLIC_BASE, id, emailId)}`
  let sent
  try {
    sent = await sendEmail(first.agent, cfg, {
      from: first.from, to: first.to, cc: cc || undefined, subject, body: finalText, html: finalHtml,
      threadId: thread?.threadId, inReplyTo: thread?.inReplyTo, references: thread?.references,
    })
  } catch (e) {
    const why = e instanceof GmailAuthError ? `${first.agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
    await ledger(id, siteId, { step: 'reply', state: 'failed', at: new Date().toISOString(), why, inboundId: latest.gmailId, agent: first.agent })
    return { state: 'failed', why }
  }
  const at = new Date().toISOString()
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: first.agent, from: first.from, to: first.to, cc: cc || undefined, subject,
    body: finalText, html: finalHtml, snippet: makeSnippet(answer.text), at,
    gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId,
    direction: 'outbound', bot: true,
  }
  await writeControlRow({ sessionId: id, siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
  // The bot answered it, so it is not "waiting on you" any more. When the
  // answer means work for the agent, the task below is what says so.
  await markThreadRepliesRead(id, siteId, sent.threadId, BOT_ACTOR)

  if (answer.complete) {
    const task: CrmTaskEntry = {
      id: newTaskId(),
      title: `Send the price quote — ${who} has now given the missing details (bot replied)`.slice(0, 200),
      type: 'email', due_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      assignee: first.agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    await sendPushToMember(first.agent, 'packaging', {
      title: 'Quote ready to price', body: `${who} sent the last details. Send the price.`,
      url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-${id}`,
    }).catch(() => 0)
  }
  await ledger(id, siteId, {
    step: 'reply', state: 'sent', at, inboundId: latest.gmailId, agent: first.agent, from: first.from, to: first.to,
    complete: answer.complete, missing: missingOf(assessment), emailId,
  })
  return { state: 'sent', complete: answer.complete, text: answer.text }
}

/**
 * The customer answered, so the bot's "call them — no reply yet" tasks are
 * no longer true. Closed with a new revision, the way a person completes a
 * task, so the trail still shows they existed. Tasks a PERSON created are
 * never touched.
 */
async function closeBotCallTasks(id: string, siteId: string): Promise<void> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', id).eq('role', CRM_TASK_ROLE).order('created_at', { ascending: true })
  const latest = new Map<string, CrmTaskEntry>()
  for (const r of data ?? []) {
    try { const t = JSON.parse(r.message) as CrmTaskEntry; if (t?.id) latest.set(t.id, t) } catch { /* not a task */ }
  }
  const at = new Date().toISOString()
  for (const t of latest.values()) {
    if (t.status !== 'open' || t.deleted || t.type !== 'call' || t.created_by !== BOT_ACTOR) continue
    await writeControlRow({
      sessionId: id, siteId, role: CRM_TASK_ROLE,
      message: JSON.stringify({ ...t, status: 'done', completed_by: BOT_ACTOR, completed_at: at, updated_by: BOT_ACTOR, updated_at: at }),
    })
  }
}

// ── After the price (Step 3) ────────────────────────────────────────────────
// A lead counts as quoted when a person sets the stage to Quote Sent (the
// "Price sent" button does exactly that). The bot then closes its own "send
// the price" task and follows the quote up every 3 days until the customer
// answers. Only quotes from BOT_START on — a quote_sent lead from
// September must not wake up to a stranger's follow-up.

async function withQuotes(result: BotRunResult, now: Date, dryRun: boolean, budget: number): Promise<BotRunResult> {
  result.quotes = []
  const sites = workspaceSites('packaging')
  const since = new Date(Math.max(new Date(BOT_START).getTime(), now.getTime() - FOLLOW_UP_WINDOW_DAYS * 864e5)).toISOString()
  // Paged for the same reason as withFollowUps: past 1,000 rows the newest
  // quotes were invisible and their skips were written again every run.
  const ledgerRows = await fetchAllPages<{ session_id: string; site_id: string; message: string }>(() => supabase.from('chat_logs').select('session_id, site_id, message')
    .eq('role', CRM_BOT_ROLE).neq('session_id', LEASE_SESSION).gte('created_at', since)
    .order('created_at', { ascending: true }), 60000)
  warnIfCapped('quote follow-up ledger', ledgerRows.length, 60000)
  interface Q { siteId: string; awaitingPrice: number | null; quotedAt: number | null; lastAt: number; stopped: boolean; ups?: number }
  const st = new Map<string, Q>()
  for (const r of ledgerRows ?? []) {
    const e = parseBotLedger(r.message)
    if (!e) continue
    const q: Q = st.get(r.session_id) ?? { siteId: r.site_id, awaitingPrice: null, quotedAt: null, lastAt: 0, stopped: false }
    const at = new Date(e.at).getTime()
    if ((e.step === 'first' || e.step === 'reply') && e.state === 'sent' && e.complete) q.awaitingPrice = at
    if (e.step === 'quote' && e.state === 'sent') { q.quotedAt = at; q.lastAt = Math.max(q.lastAt, at) }
    if (e.step === 'quote_fu' && (e.state === 'sent' || e.state === 'failed')) { q.lastAt = Math.max(q.lastAt, at); if (e.state === 'sent') q.ups = (q.ups ?? 0) + 1 }
    if (e.step === 'quote_fu' && e.state === 'skipped') q.stopped = true
    st.set(r.session_id, q)
  }

  // ── 1. a person marked the quote sent ───────────────────────────────────
  // The agent who sent the price moves the stage (the owner's rule, 2026-10-13:
  // "stage Steve change karni chahie kiunke quote usne bheji hai") — by the
  // dropdown or the Price sent button. The bot never moves it on their behalf.
  const stageRows = await fetchAllPages<{ session_id: string; site_id: string; message: string; created_at: string }>(() => supabase.from('chat_logs').select('session_id, site_id, message, created_at')
    .eq('role', CRM_STAGE_ROLE).in('site_id', sites).gte('created_at', new Date(BOT_START).toISOString())
    .ilike('message', '%"stage":"quote_sent"%').order('created_at', { ascending: true }), 20000)
  for (const r of stageRows ?? []) {
    const s = parseCrmStage(r.message)
    if (!s || s.changed_by === BOT_ACTOR) continue
    const q = st.get(r.session_id) ?? { siteId: r.site_id, awaitingPrice: null, quotedAt: null, lastAt: 0, stopped: false }
    if (q.quotedAt) continue
    const at = new Date(r.created_at).getTime()
    await markQuoted(r.session_id, r.site_id, at, undefined, `${s.changed_by} set Quote Sent`, dryRun)
    result.quotes.push({ leadId: r.session_id, state: 'quoted', why: `${s.changed_by} set Quote Sent` })
    q.quotedAt = at; q.lastAt = at
    st.set(r.session_id, q)
  }

  // ── 2. an answer to a quote ends the bot's part at once ──────────────────
  // Checked every run, in one batched query, not only when the next follow-up
  // falls due: "let's start with 500" must reach the agent now, and the bot's
  // "no reply yet — call them" task must not sit open for three days after a
  // reply that says the opposite.
  const live = [...st.entries()].filter(([, q]) => q.quotedAt && !q.stopped)
  for (let i = 0; i < live.length; i += 100) {
    const chunk = live.slice(i, i + 100)
    const { data: inRows } = await supabase.from('chat_logs').select('session_id, role, message, created_at')
      .in('role', [CRM_EMAIL_IN_ROLE, CRM_WA_IN_ROLE]).in('session_id', chunk.map(([id]) => id))
      .gte('created_at', since).order('created_at', { ascending: true })
    for (const r of inRows ?? []) {
      const q = st.get(r.session_id)!
      if (q.stopped || new Date(r.created_at).getTime() <= (q.quotedAt ?? 0) + 60 * 1000) continue
      if (r.role === CRM_EMAIL_IN_ROLE && isNoiseSender(parseCrmEmailIn(r.message)?.from ?? '')) continue
      q.stopped = true
      result.quotes.push({ leadId: r.session_id, state: 'answered', why: 'the customer answered the quote' })
      if (dryRun) continue
      await closeBotCallTasks(r.session_id, q.siteId)
      const { data: lead } = await supabase.from('leads').select('name, email').eq('id', r.session_id.replace(/^quote-/, '')).maybeSingle()
      const { data: own } = await supabase.from('chat_logs').select('message').eq('session_id', r.session_id)
        .eq('role', ASSIGNMENT_ROLE).order('created_at', { ascending: false }).limit(1).maybeSingle()
      const agent = own?.message?.trim().toLowerCase() || ''
      const who = lead?.name || lead?.email || 'The customer'
      const at = new Date().toISOString()
      if (agent) {
        const task: CrmTaskEntry = {
          id: newTaskId(), title: `${who} answered the quote — reply now (bot stopped its follow-ups)`.slice(0, 200),
          type: 'email', due_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          assignee: agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
        }
        await writeControlRow({ sessionId: r.session_id, siteId: q.siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
        await sendPushToMember(agent, 'packaging', {
          title: 'Customer answered the quote', body: `${who} replied to the quote. Over to you.`,
          url: `/leads/${encodeURIComponent(r.session_id)}`, tag: `quotebot-answer-${r.session_id}`,
        }).catch(() => 0)
      }
      await ledger(r.session_id, q.siteId, { step: 'quote_fu', state: 'skipped', at, why: 'stopped: the customer answered the quote' })
    }
  }

  // ── 3. follow the quotes up ─────────────────────────────────────────────
  if (budget <= 0) return result
  const due = [...st.entries()]
    .filter(([, q]) => q.quotedAt && !q.stopped && now.getTime() - q.lastAt >= quoteGapDays(q.ups ?? 0) * 864e5)
    .sort((a, b) => a[1].lastAt - b[1].lastAt)
  let sent = 0
  for (const [id, q] of due) {
    if (sent >= budget) break
    const r = await sendQuoteFollowUp(id, now, { dryRun })
    result.quotes.push({ leadId: id, state: r.state, n: r.n, why: r.why })
    if (r.state === 'sent') sent++
    if (r.state === 'stopped' && !dryRun) {
      await ledger(id, q.siteId, { step: 'quote_fu', state: 'skipped', at: now.toISOString(), why: `stopped: ${r.why ?? ''}` })
    }
  }
  return result
}

/** The bot's "send the price" task closed, and the quote noted. The stage is the agent's. */
async function markQuoted(id: string, siteId: string, atMs: number, emailId: string | undefined, why: string, dryRun: boolean): Promise<void> {
  if (dryRun) return
  const { data } = await supabase.from('chat_logs').select('role, message, created_at')
    .eq('session_id', id).eq('role', CRM_TASK_ROLE).order('created_at', { ascending: true })
  const rows = (data ?? []) as LogRow[]
  const latest = new Map<string, CrmTaskEntry>()
  for (const r of rows) if (r.role === CRM_TASK_ROLE) { try { const t = JSON.parse(r.message) as CrmTaskEntry; if (t?.id) latest.set(t.id, t) } catch { /* skip */ } }
  const now = new Date().toISOString()
  for (const t of latest.values()) {
    if (t.status !== 'open' || t.deleted || t.created_by !== BOT_ACTOR || !t.title.startsWith('Send the price quote')) continue
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE,
      message: JSON.stringify({ ...t, status: 'done', completed_by: BOT_ACTOR, completed_at: now, updated_by: BOT_ACTOR, updated_at: now }) })
  }
  await ledger(id, siteId, { step: 'quote', state: 'sent', at: new Date(atMs).toISOString(), why, emailId })
}

/**
 * The next follow-up on a quote. Stops for good when the customer answers,
 * when a person writes or calls them after the quote, when the stage moves on
 * from Quote Sent, or when the lead is marked not a lead.
 */
export async function sendQuoteFollowUp(leadId: string, now = new Date(), opts: { force?: boolean; dryRun?: boolean } = {}): Promise<FollowUpResult> {
  const id = leadId.startsWith('quote-') ? leadId : `quote-${leadId}`
  const { data } = await supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
    .eq('session_id', id)
    .in('role', [CRM_BOT_ROLE, CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE, CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE,
      CRM_STAGE_ROLE, LEAD_STATUS_ROLE, CRM_NOT_A_LEAD_ROLE, ASSIGNMENT_ROLE])
    .order('created_at', { ascending: true })
  const rows = (data ?? []) as (LogRow & { site_id: string })[]
  if (!rows.length) return { ok: false, state: 'stopped', why: 'no such lead' }
  const siteId = rows[0].site_id
  const spam = rows.filter((r) => r.role === CRM_NOT_A_LEAD_ROLE).map((r) => parseNotALead(r.message)).filter(Boolean).pop()
  if (spam?.spam) return { ok: true, state: 'stopped', why: 'marked not a lead' }
  const ledgers = rows.filter((r) => r.role === CRM_BOT_ROLE).map((r) => parseBotLedger(r.message)).filter(Boolean) as BotLedger[]
  const quote = [...ledgers].reverse().find((e) => e.step === 'quote' && e.state === 'sent')
  if (!quote) return { ok: false, state: 'stopped', why: 'no quote on record' }
  const anchor = new Date(quote.at).getTime()
  if (currentStage(rows) !== 'quote_sent') return { ok: true, state: 'stopped', why: `stage is ${currentStage(rows)}` }

  const after = rows.filter((r) => new Date(r.created_at).getTime() > anchor + 60 * 1000)
  // The agent may set the stage first and send the priced email a few minutes
  // later; that email is the quote, not the agent taking over the follow-ups.
  const afterGrace = after.filter((r) => new Date(r.created_at).getTime() > anchor + 30 * 60 * 1000)
  const replied = after.find((r) => r.role === CRM_WA_IN_ROLE || (r.role === CRM_EMAIL_IN_ROLE && !isNoiseSender(parseCrmEmailIn(r.message)?.from ?? '')))
  if (replied) {
    if (!opts.dryRun) await closeBotCallTasks(id, siteId)
    return { ok: true, state: 'stopped', why: 'the customer answered the quote — over to the agent' }
  }
  const human = afterGrace.find((r) => r.role === CRM_WA_OUT_ROLE || r.role === CRM_CALL_ROLE
    || (r.role === CRM_EMAIL_ROLE && !parseCrmEmail(r.message)?.bot))
  if (human) return { ok: true, state: 'stopped', why: `the agent is following up themselves (${human.role})` }

  // Written in the name of whoever owns the lead, from the address the
  // conversation is already on.
  const sentRows = rows.filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message)).filter(Boolean) as CrmEmailEntry[]
  const owner = lastAssignment(rows)
  const agent = owner && (BOT_AGENTS as readonly string[]).includes(owner) ? owner : null
  if (!agent) return { ok: true, state: 'stopped', why: `owner ${owner ?? '(none)'} is not one the bot writes for` }
  const lastMine = [...sentRows].reverse().find((e) => e.sentBy.toLowerCase() === agent)
  if (!lastMine) return { ok: true, state: 'stopped', why: `${agent} has not emailed this customer from the CRM` }
  const to = await leadRecipient(id)
  if (!to || !isAddress(to)) return { ok: true, state: 'stopped', why: 'no valid email address' }

  const ups = ledgers.filter((e) => e.step === 'quote_fu' && e.state === 'sent')
  const n = ups.length + 1
  const lastAt = Math.max(anchor, ...ups.map((e) => new Date(e.at).getTime()))
  const gap = quoteGapDays(ups.length)
  if (!opts.force && now.getTime() - lastAt < gap * 864e5) {
    return { ok: true, state: 'not-due', n, why: `next one is due ${new Date(lastAt + gap * 864e5).toISOString()}` }
  }

  const { data: lead } = await supabase.from('leads').select('name, message').eq('id', id.replace(/^quote-/, '')).maybeSingle()
  const assessment = await assessQuote(lead?.message ?? '', lead?.name ?? null)
  const fu = buildQuoteFollowUp({ n, firstName: assessment?.firstName ?? null, product: assessment?.product ?? 'packaging', now, uk: isUkSite(siteId) })
  // Whoever the agent copied on the price, else everyone the customer copied.
  const cc = lastMine.cc || await ccForLead(id, lead?.message, to)
  if (opts.dryRun) return { ok: true, state: 'not-due', n, text: fu.text, why: 'dry run: would send now' }

  const cfg = googleConfig(PUBLIC_BASE)
  if (!cfg) return { ok: false, state: 'failed', why: 'Google OAuth is not configured' }
  const latestMsg = sentRows[sentRows.length - 1]
  const thread = await threadContextFor(id, latestMsg.gmailId)
  const subject = /^re:/i.test(latestMsg.subject) ? latestMsg.subject : `Re: ${latestMsg.subject}`
  if (!(await ledger(id, siteId, { step: 'quote_fu', n, state: 'claimed', at: now.toISOString(), to, agent }))) {
    return { ok: false, state: 'failed', why: 'ledger write failed' }
  }
  const sig = await buildSendSignature({ memberEmail: agent, workspace: 'packaging', siteId, from: lastMine.from, base: PUBLIC_BASE })
  const emailId = newEmailId()
  const finalText = sig.text ? `${fu.text}\n\n${sig.text}` : fu.text
  const finalHtml = `${emailHtml(fu.text)}${sig.html}${openPixelHtml(PUBLIC_BASE, id, emailId)}`
  let sent
  try {
    sent = await sendEmail(agent, cfg, {
      from: lastMine.from, to, cc: cc || undefined, subject, body: finalText, html: finalHtml,
      threadId: thread?.threadId, inReplyTo: thread?.inReplyTo, references: thread?.references,
    })
  } catch (e) {
    const why = e instanceof GmailAuthError ? `${agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
    await ledger(id, siteId, { step: 'quote_fu', n, state: 'failed', at: new Date().toISOString(), why, to, agent })
    return { ok: false, state: 'failed', n, why }
  }
  const at = new Date().toISOString()
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: agent, from: lastMine.from, to, cc: cc || undefined, subject,
    body: finalText, html: finalHtml, snippet: makeSnippet(fu.text), at,
    gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId,
    direction: 'outbound', bot: true,
  }
  await writeControlRow({ sessionId: id, siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
  const callTask = n % CALL_TASK_EVERY === 0
  if (callTask) {
    const who = lead?.name || to
    const task: CrmTaskEntry = {
      id: newTaskId(), title: `Call ${who} about the quote — ${n} follow-ups and no reply yet (bot)`.slice(0, 200),
      type: 'call', due_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      assignee: agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    await sendPushToMember(agent, 'packaging', {
      title: 'Call about the quote', body: `${who} has not answered ${n} follow-ups on the quote.`,
      url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-qcall-${id}`,
    }).catch(() => 0)
  }
  await ledger(id, siteId, { step: 'quote_fu', n, state: 'sent', at, to, agent, from: lastMine.from, emailId, offer: fu.offer ?? undefined })
  return { ok: true, state: 'sent', n, text: fu.text, callTask }
}

// ── Holiday promotions (Step 4) ─────────────────────────────────────────────
// Only the single-lead send exists so far, for the owner to see one before any
// campaign runs on its own. It goes from the agent who last wrote to the
// customer, on the site's own domain, and carries an unsubscribe link plus the
// one-click List-Unsubscribe header Gmail shows as its own button.

export async function sendPromo(leadId: string, now = new Date()): Promise<{ ok: boolean; why?: string; subject?: string; text?: string; campaign?: string; from?: string }> {
  const id = leadId.startsWith('quote-') ? leadId : `quote-${leadId}`
  const { data: lead } = await supabase.from('leads').select('site_id, name, product, message').eq('id', id.replace(/^quote-/, '')).maybeSingle()
  if (!lead) return { ok: false, why: 'no such lead' }
  const to = await leadRecipient(id)
  if (!to || !isAddress(to)) return { ok: false, why: 'no valid email address' }
  if ((await unsubscribedSet()).has(to.toLowerCase())) return { ok: false, why: `${to} unsubscribed from offers` }

  const { data } = await supabase.from('chat_logs').select('role, message, created_at')
    .eq('session_id', id).in('role', [CRM_EMAIL_ROLE, ASSIGNMENT_ROLE]).order('created_at', { ascending: true })
  const rows = (data ?? []) as LogRow[]
  const sent = rows.filter((r) => r.role === CRM_EMAIL_ROLE).map((r) => parseCrmEmail(r.message)).filter(Boolean) as CrmEmailEntry[]
  const owner = lastAssignment(rows)
  const lastByBotAgent = [...sent].reverse().find((e) => (BOT_AGENTS as readonly string[]).includes(e.sentBy.toLowerCase()))
  const cfg = googleConfig(PUBLIC_BASE)
  if (!cfg) return { ok: false, why: 'Google OAuth is not configured' }
  const { data: site } = await supabase.from('sites').select('name').eq('site_id', lead.site_id).maybeSingle()
  const siteName = String(site?.name ?? lead.site_id)
  // Who writes it: the agent who last wrote to them, else the owner, else —
  // an old lead whose owner has left — one of today's agents, picked by the
  // address so the same customer always hears from the same person.
  let agent: string | null = lastByBotAgent?.sentBy.toLowerCase() ?? (owner && (BOT_AGENTS as readonly string[]).includes(owner) ? owner : null)
  let alias: { email: string } | null = lastByBotAgent?.from ? { email: lastByBotAgent.from } : null
  const order = agent ? [agent] : [...BOT_AGENTS].sort((a, b) => hashOf(`${to}${a}`) - hashOf(`${to}${b}`))
  if (!alias) {
    for (const a of order) {
      const hit = siteAlias(await verifiedAliases(a, cfg), lead.site_id, siteName)
      if (hit) { agent = a; alias = hit; break }
    }
  }
  if (!agent || !alias) return { ok: false, why: `no verified ${lead.site_id} mailbox for ${order.join(' or ')}` }

  const { campaign } = currentOrNextCampaign(now)
  const assessment = await assessQuote(lead.message ?? '', lead.name ?? null)
  const unsub = unsubscribeUrl(PUBLIC_BASE, to)
  const promo = buildPromoEmail({
    campaign, firstName: assessment?.firstName ?? null,
    product: assessment?.isQuote ? assessment.product : null, siteName, unsubscribeUrl: unsub,
  })
  const sig = await buildSendSignature({ memberEmail: agent, workspace: 'packaging', siteId: lead.site_id, from: alias.email, base: PUBLIC_BASE })
  const emailId = newEmailId()
  // The footer goes under the signature: the offer reads as the agent's note,
  // the unsubscribe line as the fine print it is.
  const [bodyText, footer] = promo.text.split('\n\nYou\'re receiving this')
  const finalText = `${bodyText}${sig.text ? `\n\n${sig.text}` : ''}\n\nYou're receiving this${footer}`
  const finalHtml = `${promo.html}${sig.html}${promoFooterHtml(siteName, unsub)}${openPixelHtml(PUBLIC_BASE, id, emailId)}`

  if (!(await ledger(id, lead.site_id, { step: 'promo', campaign: campaign.key, state: 'claimed', at: now.toISOString(), to, agent }))) {
    return { ok: false, why: 'ledger write failed' }
  }
  let res
  try {
    // A new conversation, not a reply in the old quote thread: it is a new
    // offer, and burying it under a months-old exchange hides it.
    res = await sendEmail(agent, cfg, {
      from: alias.email, to, subject: promo.subject, body: finalText, html: finalHtml,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    })
  } catch (e) {
    const why = e instanceof GmailAuthError ? `${agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
    await ledger(id, lead.site_id, { step: 'promo', campaign: campaign.key, state: 'failed', at: new Date().toISOString(), why, to, agent })
    return { ok: false, why }
  }
  const at = new Date().toISOString()
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: agent, from: alias.email, to, subject: promo.subject,
    body: finalText, html: finalHtml, snippet: makeSnippet(bodyText), at,
    gmailId: res.id, threadId: res.threadId, messageId: res.messageId,
    direction: 'outbound', bot: true,
  }
  await writeControlRow({ sessionId: id, siteId: lead.site_id, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
  await ledger(id, lead.site_id, { step: 'promo', campaign: campaign.key, state: 'sent', at, to, agent, from: alias.email, emailId, offer: campaign.discount })
  return { ok: true, subject: promo.subject, text: finalText, campaign: campaign.key, from: alias.email }
}

// ── The holiday drip (Step 4, owner OK 2026-10-14: "15-20 start kardo") ─────
// Slow on purpose: a burst of promotional mail from a site's domain is how it
// lands on a blocklist, and that would take the quote replies down with it.
//   • at most PROMO_DAILY_CAP a day across all sites, one per run, spaced
//     PROMO_GAP_MIN apart, Monday–Friday 9am–4pm US Eastern;
//   • one promo per address per PROMO_ADDRESS_GAP_DAYS (campaigns overlap:
//     Christmas opens on Nov 20 while Black Friday is still running);
//   • never: unsubscribed, bounced, marked not-a-lead, a merchant test order,
//     a system sender, or anyone being worked right now (any email, call,
//     WhatsApp, stage or owner change in the last PROMO_QUIET_DAYS — their
//     follow-ups carry the offer);
//   • at most PROMO_SITE_DAILY_CAP a day from any one site's domain — sites
//     take turns; within a site, buyers (checkout leads) first, then newest.
// Runs for the campaign in progress, or one opening within PROMO_LEAD_DAYS —
// the owner started Black Friday on 14 Oct rather than wait for the 20th.
export const PROMO_DAILY_CAP = 20
/** Per site domain, per day: twenty from one domain in a day is the burst to avoid. */
const PROMO_SITE_DAILY_CAP = 3
const PROMO_GAP_MIN = 20
const PROMO_ADDRESS_GAP_DAYS = 30
const PROMO_QUIET_DAYS = 21
const PROMO_LEAD_DAYS = 7

function hashOf(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h >>> 0
}

function easternParts(d: Date): { day: string; hour: number; key: string } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]))
  return { day: p.weekday, hour: Number(p.hour), key: `${p.year}-${p.month}-${p.day}` }
}

export interface PromoDripResult {
  campaign: string
  state: 'sent' | 'waiting' | 'done' | 'off' | 'failed'
  why?: string
  sentToday: number
  remaining: number
  sent?: { leadId: string; to: string; from?: string }
  next?: { leadId: string; to: string; siteId: string }[]
}

export async function runPromoDrip(now = new Date(), opts: { dryRun?: boolean } = {}): Promise<PromoDripResult> {
  const { campaign, running } = currentOrNextCampaign(now)
  const opensSoon = !running && +campaign.start - +now <= PROMO_LEAD_DAYS * 864e5
  const base = { campaign: campaign.key, sentToday: 0, remaining: 0 }
  if (!running && !opensSoon) return { ...base, state: 'off', why: `next campaign ${campaign.key} opens ${campaign.start.toISOString().slice(0, 10)}` }
  const sites = workspaceSites('packaging')

  // Every promo the bot has ever written down.
  const ledgerRows = await fetchAllPages<{ session_id: string; site_id: string; message: string; created_at: string }>(
    // Bounded by time so the created_at index does the work: chat_logs has no
    // role index, and an unbounded role filter walks the whole table.
    () => supabase.from('chat_logs').select('session_id, site_id, message, created_at').eq('role', CRM_BOT_ROLE)
      .gte('created_at', new Date(Math.min(+campaign.start, +now) - (PROMO_ADDRESS_GAP_DAYS + 1) * 864e5).toISOString())
      .ilike('message', '%"step":"promo"%').order('created_at', { ascending: true }), 20000)
  warnIfCapped('promo ledger', ledgerRows.length, 20000)
  const doneSessions = new Set<string>()
  const recentAddrs = new Set<string>()
  let sentToday = 0
  let lastSentAt = 0
  const siteToday = new Map<string, number>()
  const today = easternParts(now).key
  for (const r of ledgerRows) {
    const e = parseBotLedger(r.message)
    if (!e || e.step !== 'promo') continue
    if (e.campaign === campaign.key) doneSessions.add(r.session_id)
    const at = new Date(e.at).getTime()
    if (e.state === 'sent' || e.state === 'claimed') {
      if (e.to && now.getTime() - at < PROMO_ADDRESS_GAP_DAYS * 864e5) recentAddrs.add(e.to.toLowerCase())
      if (easternParts(new Date(at)).key === today) { sentToday++; siteToday.set(r.site_id, (siteToday.get(r.site_id) ?? 0) + 1) }
      lastSentAt = Math.max(lastSentAt, at)
    }
  }

  // Cheap gates FIRST. Everything below reads thousands of rows; run every
  // five minutes around the clock it pinned the database (14 Oct 2026, pings
  // of 30-130s until the drip was paused). Now the heavy part runs only when
  // a send is actually due — at most PROMO_DAILY_CAP times a day.
  const et = easternParts(now)
  const preview = !!opts.dryRun
  if (!preview) {
    if (sentToday >= PROMO_DAILY_CAP) return { ...base, state: 'waiting', sentToday, why: `today's ${PROMO_DAILY_CAP} are sent` }
    if (et.day === 'Sat' || et.day === 'Sun' || et.hour < 9 || et.hour >= 16) return { ...base, state: 'waiting', sentToday, why: 'outside US business hours (Mon–Fri 9am–4pm Eastern)' }
    if (now.getTime() - lastSentAt < PROMO_GAP_MIN * 60 * 1000) return { ...base, state: 'waiting', sentToday, why: `spacing: next one ${PROMO_GAP_MIN} min after the last` }
  }

  // Who is in a conversation right now, and who bounced.
  const since = new Date(now.getTime() - PROMO_QUIET_DAYS * 864e5).toISOString()
  const recent = await fetchAllPages<{ session_id: string }>(
    () => supabase.from('chat_logs').select('session_id').in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE, CRM_STAGE_ROLE, CRM_CALL_ROLE, CRM_WA_OUT_ROLE, CRM_WA_IN_ROLE])
      .in('site_id', sites).gte('created_at', since).order('created_at', { ascending: true }), 20000)
  warnIfCapped('promo recent mail', recent.length, 20000)
  const active = new Set(recent.map((r) => r.session_id))
  const [unsub, notALead] = await Promise.all([unsubscribedSet(), notALeadSessions(sites)])

  const leads = await fetchAllPages<{ id: string; site_id: string; email: string | null; created_at: string }>(
    () => supabase.from('leads').select('id, site_id, email, created_at').in('site_id', sites).not('email', 'is', null)
      .order('created_at', { ascending: false }), 20000)
  warnIfCapped('promo leads', leads.length, 20000)
  const buyerRows = await fetchAllPages<{ id: string }>(
    () => supabase.from('leads').select('id').in('site_id', sites).ilike('message', '[Checkout]%').order('created_at', { ascending: false }), 5000)
  const buyers = new Set(buyerRows.map((r) => r.id))
  const seenAddr = new Set<string>()
  const pool: { leadId: string; to: string; siteId: string; buyer: boolean; at: string }[] = []
  for (const l of leads) {
    const to = (l.email ?? '').trim().toLowerCase()
    const id = quoteSessionId(l.id)
    if (!isAddress(to) || seenAddr.has(to)) continue
    seenAddr.add(to)  // newest lead per address only: one customer, one email
    // The campaigns are American holidays (Thanksgiving, July 4th…): a UK
    // site's customer is never sent one (three were, 23-26 Oct 2026).
    if (isUkSite(l.site_id)) continue
    // Never a new lead. The newest enquiry from this address is still being
    // worked (or should be): the promo is for customers who went quiet, and
    // 39 of the first 85 went to leads under three weeks old — some the same
    // hour they wrote in (Grace and Shaun, 26 Oct 2026).
    if (now.getTime() - new Date(l.created_at).getTime() < PROMO_QUIET_DAYS * 864e5) continue
    if (doneSessions.has(id) || recentAddrs.has(to) || unsub.has(to) || notALead.has(id) || active.has(id)) continue
    if (isNoiseSender(to) || isMerchantTestOrder(to)) continue
    const local = to.split('@')[0]
    if (/^(dmarc|no-?reply|donotreply|do-not-reply|postmaster|mailer-?daemon|bounce)/.test(local) || /^(notifications?|reports?|abuse)$/.test(local)) continue
    // Our own and test addresses, and the "search-<oursite>.com" spam that
    // fills contact forms: a promo to either only costs reputation.
    const domain = to.split('@')[1] ?? ''
    if (sites.some((sid) => domain.replace(/[^a-z]/g, '').includes(sid.toLowerCase()))) continue
    pool.push({ leadId: id, to, siteId: l.site_id, buyer: buyers.has(l.id), at: l.created_at })
  }
  // Sites take turns: each site's queue is buyers-then-newest, and the pool is
  // dealt one from each site in rotation, skipping any site at today's cap.
  const bySite = new Map<string, typeof pool>()
  for (const c of pool) { if (!bySite.has(c.siteId)) bySite.set(c.siteId, []); bySite.get(c.siteId)!.push(c) }
  for (const q of bySite.values()) q.sort((a, b) => Number(b.buyer) - Number(a.buyer) || b.at.localeCompare(a.at))
  const order = [...bySite.keys()].sort((a, b) => (siteToday.get(a) ?? 0) - (siteToday.get(b) ?? 0) || a.localeCompare(b))
  const dealt: typeof pool = []
  const quota = new Map(order.map((k) => [k, Math.max(0, PROMO_SITE_DAILY_CAP - (siteToday.get(k) ?? 0))]))
  for (let round = 0; dealt.length < PROMO_DAILY_CAP && round < PROMO_SITE_DAILY_CAP; round++) {
    for (const k of order) {
      if ((quota.get(k) ?? 0) <= 0) continue
      const c = bySite.get(k)![round]
      if (!c) continue
      dealt.push(c); quota.set(k, (quota.get(k) ?? 0) - 1)
      if (dealt.length >= PROMO_DAILY_CAP) break
    }
  }
  const out: PromoDripResult = { ...base, state: 'waiting', sentToday, remaining: pool.length, next: dealt.slice(0, PROMO_DAILY_CAP - Math.min(sentToday, PROMO_DAILY_CAP)).map(({ leadId, to, siteId }) => ({ leadId, to, siteId })) }
  if (!pool.length) return { ...out, state: 'done', why: 'everyone eligible has had this campaign' }
  if (!dealt.length) return { ...out, why: `every site has had its ${PROMO_SITE_DAILY_CAP} today` }
  if (preview) return { ...out, why: 'dry run: would send the first of next' }

  // One send per run; a lead that cannot be sent (no mailbox for its site)
  // is written down by sendPromo as failed and not tried again this campaign.
  for (const c of dealt.slice(0, 5)) {
    // Bounced before? Checked for this one customer only — a scan of every
    // inbound email's text was the other heavy query.
    const { data: bounce } = await supabase.from('chat_logs').select('id').eq('session_id', c.leadId).eq('role', CRM_EMAIL_IN_ROLE)
      .or('message.ilike.%mailer-daemon%,message.ilike.%postmaster@%').limit(1)
    if (bounce?.length) {
      await ledger(c.leadId, c.siteId, { step: 'promo', campaign: campaign.key, state: 'skipped', at: now.toISOString(), why: 'an earlier email to this address bounced', to: c.to })
      continue
    }
    let r: Awaited<ReturnType<typeof sendPromo>>
    try { r = await sendPromo(c.leadId, now) } catch (e) { r = { ok: false, why: e instanceof Error ? e.message : 'send failed' } }
    if (r.ok) return { ...out, state: 'sent', sentToday: sentToday + 1, remaining: pool.length - 1, sent: { leadId: c.leadId, to: c.to, from: r.from } }
    if (!(await hasPromoLedger(c.leadId, campaign.key))) {
      await ledger(c.leadId, c.siteId, { step: 'promo', campaign: campaign.key, state: 'failed', at: now.toISOString(), why: r.why, to: c.to })
    }
  }
  return { ...out, state: 'failed', why: 'the next five candidates could not be sent — see their ledger rows' }
}

async function hasPromoLedger(sessionId: string, key: string): Promise<boolean> {
  const { data } = await supabase.from('chat_logs').select('id').eq('session_id', sessionId).eq('role', CRM_BOT_ROLE)
    .ilike('message', `%"campaign":"${key}"%`).limit(1)
  return !!data?.length
}

/** Shorten to a word boundary with an ellipsis. */
function clip(text: string, max: number): string {
  const t = text.trim().replace(/\.$/, '')
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(20, max - 1)).replace(/\s+\S*$/, '')}…`
}

// ── Chat twins ──────────────────────────────────────────────────────────────
/** The chat conversations that captured this same customer on this site. */
export async function chatTwins(siteId: string, email: string, createdAt: string): Promise<string[]> {
  const t = new Date(createdAt).getTime()
  const { data } = await supabase.from('chat_logs').select('session_id, created_at')
    .eq('role', LEAD_CAPTURE_ROLE).eq('site_id', siteId)
    .gte('created_at', new Date(t - 2 * 864e5).toISOString()).lte('created_at', new Date(t + 864e5).toISOString())
    .ilike('message', `%${email.trim().replace(/%/g, '')}%`).limit(10)
  return [...new Set((data ?? []).map((r) => r.session_id).filter((s) => !s.startsWith('quote-')))]
}

/** Stage → Contacted and owner → the agent, on each twin that is still untouched. */
export async function mirrorToChatTwins(siteId: string, email: string, createdAt: string, agent: string): Promise<string[]> {
  const twins = await chatTwins(siteId, email, createdAt)
  for (const sid of twins) {
    const { data } = await supabase.from('chat_logs').select('role, message, created_at')
      .eq('session_id', sid).in('role', [CRM_STAGE_ROLE, LEAD_STATUS_ROLE, ASSIGNMENT_ROLE]).order('created_at', { ascending: true })
    const rows = (data ?? []) as LogRow[]
    const stage = currentStage(rows)
    if (stage === 'new') await applyStageChange({ leadId: sid, siteId, stage: 'contacted', previous: 'new', actorEmail: BOT_ACTOR })
    // Only an unowned chat gets an owner. A chat a person already holds (the
    // chat agent who answered it) keeps them.
    if (!lastAssignment(rows)) await setAssignment(sid, siteId, agent)
  }
  return twins
}

/**
 * ADMIN PREVIEW: what the bot's first email to this lead would say TODAY,
 * whatever it already sent. Writes nothing and sends nothing — used to check
 * the bot against the agents' review of real emails (Saifullah, 2026-10-23).
 */
export async function redraftFirst(leadId: string): Promise<{ id: string; name?: string | null; site?: string; assessment?: QuoteAssessment | null; text?: string; drafted?: boolean; error?: string }> {
  const id = leadId.replace(/^quote-/, '')
  const { data: lead } = await supabase.from('leads').select('id, site_id, name, message').eq('id', id).maybeSingle()
  if (!lead) return { id: leadId, error: 'no such lead' }
  const message = String(lead.message ?? '')
  const fromChat = /^\s*(\[[^\]]+\]\s*)?(user|assistant):/m.test(message)
  const assessment = await assessQuote(message, lead.name)
  if (!assessment) return { id: leadId, name: lead.name, site: lead.site_id, error: 'assessment failed' }
  const mail = buildFirstEmail(assessment, { siteName: lead.site_id, fromChat })
  const drafted = await draftCustomerEmail({ kind: 'first', fromChat, enquiry: quoteTextForAssessment(message, lead.name), assessment, siteName: lead.site_id })
  return { id: leadId, name: lead.name, site: lead.site_id, assessment, text: drafted?.text ?? mail.text, drafted: !!drafted, ...(drafted ? {} : { error: `template used — draft rejected: ${lastDraftProblem}` }) }
}
