// Daily follow-ups — the aggregation behind /followups.
//
// One Karachi day at a time: what went OUT to customers (the bot's follow-ups,
// drafts an agent sent, emails written by hand, WhatsApp, calls), what came
// BACK (customer emails and WhatsApp), who is still waiting for an answer, and
// the same counts for the 14 days ending on that day.
//
// ── Where each number comes from ─────────────────────────────────────────────
//   bot email      crm_bot ledger row, state "sent", carrying an emailId
//                  (steps first / followup / quote_fu / promo / reply)
//   draft sent     crm_bot_draft, status "sent" — the bot wrote it, a person
//                  read it and pressed send
//   by hand        every other crm_email row
//   WhatsApp       crm_wa_out, one per message sid (status updates repeat it)
//   call           crm_call placed by an agent, one per call sid
//   reply          crm_email_in and crm_wa_in
//   task done      crm_task whose newest revision was completed that day
//
// Every row is bucketed by the time the thing HAPPENED (the `at` in its body),
// not by created_at: mail sent from Gmail itself is imported minutes or hours
// later, and filing it under the import time would move a day's work to the
// next day.
//
// Read-only. Nothing here writes a row.

import { supabase, fetchAllPages, inChunks, warnIfCapped } from './supabase'
import { siteScope, type Member } from './auth'
import { asUtcIso } from './visitor'
import { agentDisplayName } from './agentname'
import { pktDayKey, pktCustomRange } from './datetime'
import { CRM_TASK_ROLE, parseCrmTask } from './tasks'
import { isBotWaRow } from './whatsapp'
import { notALeadSessions } from './notalead'
import { isClosingMessage } from './closing'
import { storedMemberNames } from './membername'
import { SITE_DOMAINS } from './sitedomains'
import type { FollowupKind } from './followupkinds'

// The team's own domains beyond the site domains (the same list
// lib/opportunityload.ts keeps): an "inbound" mail from one of these is an
// agent answering from Gmail itself — OUR message, not a customer's reply.
const TEAM_DOMAINS = ['shopcardboardboxes.com', 'zeecustomboxes.com', 'zeeops.dev', 'thecosmeticboxes.com']
const SYSTEM_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|bounces?|calendar-notification|service)@/i

const ROW_CAP = 60_000
export const FOLLOWUP_TREND_DAYS = 14
/** How far back a day can be asked for. The read runs from the start of the
 *  trend to now, so this bounds it. */
export const FOLLOWUP_MAX_BACK_DAYS = 45

export type { FollowupKind } from './followupkinds'

/** The kinds that are a follow-up in the everyday sense: chasing a customer
 *  who has already heard from us. */
const CHASE: ReadonlySet<FollowupKind> = new Set<FollowupKind>(['bot_followup', 'bot_quote_fu', 'bot_promo'])
const BY_BOT: ReadonlySet<FollowupKind> = new Set<FollowupKind>(['bot_first', 'bot_followup', 'bot_quote_fu', 'bot_promo', 'bot_reply', 'whatsapp_bot'])

export interface FollowupItem {
  at: string
  sessionId: string
  siteId: string
  siteName: string
  /** The agent it went out as (bot mail is sent in an agent's name). */
  agent: string
  agentName: string
  kind: FollowupKind
  /** Which follow-up in the sequence, when the bot numbers it. */
  n: number | null
  customer: string
  subject: string
  snippet: string
  /** The customer wrote back after this went out. */
  replied: boolean
  repliedAt: string | null
}

export interface FollowupCounts {
  /** Bot follow-ups: followup + quote follow-up + promo. */
  botFollowups: number
  /** Bot first replies and bot answers to a customer's reply. */
  botOther: number
  draftsSent: number
  emails: number
  whatsapp: number
  calls: number
  /** Everything a person did: drafts sent + emails + WhatsApp + calls. */
  byPeople: number
  /** Everything that went out. */
  sent: number
  /** Customer emails and WhatsApp messages received. */
  replies: number
  /** Distinct leads something went out to. */
  leadsContacted: number
}

export interface FollowupAgentRow extends FollowupCounts {
  agent: string
  name: string
  tasksDone: number
  /** Customers of theirs whose last message that day has no answer yet. */
  waiting: number
}

export interface FollowupDayRow extends FollowupCounts { day: string }

export interface WaitingRow {
  sessionId: string
  siteId: string
  siteName: string
  customer: string
  agent: string
  agentName: string
  at: string
  via: 'email' | 'whatsapp'
  snippet: string
}

export interface FollowupData {
  day: string
  workspace: string
  generatedAt: string
  totals: FollowupCounts & {
    tasksDone: number
    /** Of the bot follow-ups sent that day, how many the customer has answered since. */
    followupsAnswered: number
    waiting: number
  }
  agents: FollowupAgentRow[]
  items: FollowupItem[]
  waiting: WaitingRow[]
  trend: FollowupDayRow[]
  /** A read hit its row cap — recent figures may be short. */
  truncated: boolean
}

const emptyCounts = (): FollowupCounts => ({
  botFollowups: 0, botOther: 0, draftsSent: 0, emails: 0, whatsapp: 0, calls: 0, byPeople: 0, sent: 0, replies: 0, leadsContacted: 0,
})

type Row = { session_id: string; site_id: string; role: string; message: string; created_at: string }
type Json = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const parse = (m: string): Json | null => { try { const j = JSON.parse(m); return j && typeof j === 'object' ? j as Json : null } catch { return null } }
const lower = (v: unknown): string => str(v).trim().toLowerCase()
const isBot = (who: string) => !who || who === 'zeeops-bot'

/** "Ray Hicks <ray@x.com>" → "Ray Hicks"; a bare address stays as it is. */
function nameFromAddress(to: string): string {
  const m = to.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return m[1].trim() || m[2].trim()
  return to.trim()
}

function previousDay(day: string, back: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

export function isDayKey(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())
}

/** The day to show: what was asked for, held between the oldest day we can
 *  read and today (Karachi). */
export function resolveFollowupDay(asked: string | null, now: Date = new Date()): string {
  const today = pktDayKey(now)
  if (!asked || !isDayKey(asked) || asked > today) return today
  const oldest = previousDay(today, FOLLOWUP_MAX_BACK_DAYS)
  return asked < oldest ? oldest : asked
}

export async function buildFollowups(member: Member, day: string): Promise<FollowupData> {
  const allowed = Array.from(siteScope(member))
  const trendDays: string[] = []
  for (let i = FOLLOWUP_TREND_DAYS - 1; i >= 0; i--) trendDays.push(previousDay(day, i))

  const base: FollowupData = {
    day, workspace: member.workspace, generatedAt: new Date().toISOString(),
    totals: { ...emptyCounts(), tasksDone: 0, followupsAnswered: 0, waiting: 0 },
    agents: [], items: [], waiting: [],
    trend: trendDays.map((d) => ({ day: d, ...emptyCounts() })),
    truncated: false,
  }
  const range = pktCustomRange(trendDays[0], day)
  if (allowed.length === 0 || !range) return base

  // From the first trend day to NOW (not to the end of `day`): whether a
  // customer answered a follow-up is only knowable from what came in after it.
  const from = range.from
  const read = (roles: string[], like?: string) => fetchAllPages<Row>(
    () => {
      let q = supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .in('site_id', allowed).in('role', roles).gte('created_at', from)
      if (like) q = q.like('message', like)
      return q.order('created_at', { ascending: true }).order('id', { ascending: true })
    },
    ROW_CAP)

  const [botRows, draftRows, mailRows, inRows, waRows, callRows, taskRows, sitesRes, notLead, memberNames] = await Promise.all([
    read(['crm_bot'], '%"state":"sent"%'),
    read(['crm_bot_draft'], '%"status":"sent"%'),
    read(['crm_email']),
    read(['crm_email_in', 'crm_wa_in']),
    read(['crm_wa_out']),
    read(['crm_call']),
    read([CRM_TASK_ROLE]),
    supabase.from('sites').select('site_id, name'),
    notALeadSessions(allowed),
    storedMemberNames(),
  ])
  for (const [what, rows] of [['followups bot', botRows], ['followups drafts', draftRows], ['followups mail', mailRows], ['followups replies', inRows], ['followups whatsapp', waRows], ['followups calls', callRows], ['followups tasks', taskRows]] as const) {
    if (warnIfCapped(what, rows.length, ROW_CAP)) base.truncated = true
  }

  const siteName: Record<string, string> = {}
  for (const s of sitesRes.data ?? []) siteName[s.site_id] = s.name
  const at = (r: Row, j: Json): string => {
    const v = str(j.at)
    return v && !Number.isNaN(new Date(v).getTime()) ? new Date(v).toISOString() : (asUtcIso(r.created_at) as string)
  }

  // ── what went out ──────────────────────────────────────────────────────────
  type Out = Omit<FollowupItem, 'siteName' | 'agentName' | 'replied' | 'repliedAt'>
  const outs: Out[] = []

  // Bot mail, by the id of the email it sent.
  const botMail = new Map<string, { kind: FollowupKind; n: number | null; agent: string }>()
  const STEP_KIND: Record<string, FollowupKind> = {
    first: 'bot_first', followup: 'bot_followup', quote_fu: 'bot_quote_fu', promo: 'bot_promo', reply: 'bot_reply',
  }
  for (const r of botRows) {
    const j = parse(r.message)
    const kind = j ? STEP_KIND[str(j.step)] : undefined
    const emailId = j ? str(j.emailId) : ''
    if (!j || !kind || !emailId) continue
    botMail.set(emailId, { kind, n: typeof j.n === 'number' ? j.n : null, agent: lower(j.agent) })
  }
  const draftMail = new Set<string>()
  for (const r of draftRows) {
    const j = parse(r.message)
    const id = j ? str(j.sentEmailId) : ''
    if (id) draftMail.add(id)
  }

  const seenMail = new Set<string>()
  const sentGmail = new Set<string>()
  for (const r of mailRows) {
    const j = parse(r.message)
    if (!j) continue
    const id = str(j.id) || str(j.gmailId)
    if (!id || seenMail.has(id)) continue
    seenMail.add(id)
    if (str(j.gmailId)) sentGmail.add(str(j.gmailId))
    const bot = botMail.get(str(j.id))
    // A draft the bot wrote and a person sent is the person's work, whatever
    // the ledger says about the step.
    const kind: FollowupKind = draftMail.has(str(j.id)) ? 'draft_sent' : bot ? bot.kind : j.bot === true ? 'bot_reply' : 'email'
    outs.push({
      at: at(r, j), sessionId: r.session_id, siteId: r.site_id,
      agent: lower(j.sentBy) || bot?.agent || '', kind, n: bot?.n ?? null,
      customer: nameFromAddress(str(j.to)), subject: str(j.subject), snippet: str(j.snippet).slice(0, 220),
    })
  }

  // WhatsApp: the same message is stored again on every delivery update.
  const seenWa = new Set<string>()
  for (const r of waRows) {
    const j = parse(r.message)
    const sid = j ? str(j.sid) : ''
    if (!j || !sid || seenWa.has(sid)) continue
    seenWa.add(sid)
    const who = lower(j.sentBy)
    outs.push({
      at: at(r, j), sessionId: r.session_id, siteId: r.site_id,
      agent: isBot(who) ? '' : who, kind: isBotWaRow(r.message) || isBot(who) ? 'whatsapp_bot' : 'whatsapp', n: null,
      customer: str(j.to), subject: '', snippet: str(j.body).slice(0, 220),
    })
  }

  // Calls an agent placed. A call is several rows (ringing, completed, a
  // recording); the first one with a time and a caller is the call.
  const seenCall = new Set<string>()
  for (const r of callRows) {
    const j = parse(r.message)
    const sid = j ? str(j.sid) : ''
    const by = j ? lower(j.by) : ''
    if (!j || !sid || !by || !str(j.at) || str(j.status) === 'inbound' || seenCall.has(sid)) continue
    seenCall.add(sid)
    outs.push({
      at: at(r, j), sessionId: r.session_id, siteId: r.site_id,
      agent: by, kind: 'call', n: null, customer: '', subject: '', snippet: '',
    })
  }

  // ── what came back ─────────────────────────────────────────────────────────
  type In = { at: string; sessionId: string; siteId: string; via: 'email' | 'whatsapp'; from: string; snippet: string }
  const ins: In[] = []
  const seenIn = new Set<string>()
  const ourDomains = new Set<string>([...Object.values(SITE_DOMAINS), ...TEAM_DOMAINS].map((d) => d.toLowerCase()))
  // An agent's login by the part before the @, so stevehayes@<any site> is
  // counted under the one Steve.
  const loginByLocal = new Map<string, string>()
  for (const o of outs) if (o.agent) loginByLocal.set(o.agent.split('@')[0], o.agent)
  for (const b of botMail.values()) if (b.agent) loginByLocal.set(b.agent.split('@')[0], b.agent)
  for (const r of inRows) {
    const j = parse(r.message)
    if (!j) continue
    const id = str(j.gmailId) || str(j.sid) || `${r.session_id}|${r.created_at}`
    if (seenIn.has(id)) continue
    seenIn.add(id)
    // A supplier's or SEO seller's pitch is not a customer reply.
    if (notLead.has(r.session_id)) continue
    // The same Gmail message already counted as mail we sent.
    if (str(j.gmailId) && sentGmail.has(str(j.gmailId))) continue
    const email = r.role === 'crm_email_in'
    if (email) {
      const addr = (str(j.from).match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? '').toLowerCase()
      if (SYSTEM_SENDER.test(addr)) continue
      if (ourDomains.has(addr.split('@')[1] ?? '')) {
        const toAddr = (str(j.to).match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? '').toLowerCase()
        // Ours to ours is not outreach. A "-all" group address is the one
        // exception: Google rewrites a customer's From to the group when it
        // relays their mail, so that IS the customer writing.
        if (ourDomains.has(toAddr.split('@')[1] ?? '')) {
          if (!/-all@/.test(addr)) continue
        } else {
        // Answered from Gmail rather than from ZeeOps: still the agent's email.
        outs.push({
          at: at(r, j), sessionId: r.session_id, siteId: r.site_id,
          agent: loginByLocal.get(addr.split('@')[0]) ?? addr, kind: 'email', n: null,
          customer: nameFromAddress(str(j.to)), subject: str(j.subject), snippet: (str(j.snippet) || str(j.body)).slice(0, 220),
        })
        continue
        }
      }
    }
    ins.push({
      at: at(r, j), sessionId: r.session_id, siteId: r.site_id, via: email ? 'email' : 'whatsapp',
      from: email ? (str(j.fromName) || str(j.from)) : str(j.from),
      snippet: (str(j.snippet) || str(j.body)).slice(0, 220),
    })
  }

  outs.sort((a, b) => a.at.localeCompare(b.at))
  ins.sort((a, b) => a.at.localeCompare(b.at))
  const insBySession = new Map<string, In[]>()
  for (const i of ins) { const l = insBySession.get(i.sessionId) ?? []; l.push(i); insBySession.set(i.sessionId, l) }
  const outsBySession = new Map<string, Out[]>()
  for (const o of outs) { const l = outsBySession.get(o.sessionId) ?? []; l.push(o); outsBySession.set(o.sessionId, l) }

  /** Who a customer's message is for: whoever last wrote to them. */
  const ownerAt = (sessionId: string, when: string): string => {
    const list = outsBySession.get(sessionId) ?? []
    let owner = ''
    for (const o of list) { if (o.agent && o.at <= when) owner = o.agent }
    if (!owner) owner = list.find((o) => o.agent)?.agent ?? ''
    return owner
  }

  // ── counts ─────────────────────────────────────────────────────────────────
  const count = (c: FollowupCounts, kind: FollowupKind) => {
    c.sent++
    if (CHASE.has(kind)) c.botFollowups++
    else if (BY_BOT.has(kind)) c.botOther++
    else {
      c.byPeople++
      if (kind === 'draft_sent') c.draftsSent++
      else if (kind === 'email') c.emails++
      else if (kind === 'whatsapp') c.whatsapp++
      else if (kind === 'call') c.calls++
    }
  }

  const trendByDay = new Map(base.trend.map((t) => [t.day, t]))
  const trendLeads = new Map<string, Set<string>>()
  for (const o of outs) {
    const d = pktDayKey(o.at)
    const t = trendByDay.get(d)
    if (!t) continue
    count(t, o.kind)
    const s = trendLeads.get(d) ?? new Set<string>(); s.add(o.sessionId); trendLeads.set(d, s)
  }
  for (const i of ins) { const t = trendByDay.get(pktDayKey(i.at)); if (t) t.replies++ }
  for (const t of base.trend) t.leadsContacted = trendLeads.get(t.day)?.size ?? 0

  const agentRows = new Map<string, FollowupAgentRow>()
  const agentLeads = new Map<string, Set<string>>()
  const nameOfAgent = (email: string): string => memberNames.get(email) || agentDisplayName(email)
  /** `agent` is a login, or '' — and '' means the bot for something sent, but
   *  nobody at all for a reply that arrived on a lead no one has written to. */
  const ensure = (agent: string, fallback: 'bot' | 'unassigned' = 'bot'): FollowupAgentRow => {
    const key = agent || fallback
    let a = agentRows.get(key)
    if (!a) {
      a = { agent: key, name: agent ? nameOfAgent(agent) : fallback === 'bot' ? 'Bot (WhatsApp assistant)' : 'No agent yet', ...emptyCounts(), tasksDone: 0, waiting: 0 }
      agentRows.set(key, a)
    }
    return a
  }

  const dayOuts = outs.filter((o) => pktDayKey(o.at) === day)
  const dayIns = ins.filter((i) => pktDayKey(i.at) === day)

  for (const o of dayOuts) {
    const a = ensure(o.agent)
    count(a, o.kind)
    const s = agentLeads.get(a.agent) ?? new Set<string>(); s.add(o.sessionId); agentLeads.set(a.agent, s)
    const firstReply = (insBySession.get(o.sessionId) ?? []).find((i) => i.at > o.at)
    base.items.push({
      ...o, siteName: siteName[o.siteId] ?? o.siteId, agentName: o.agent ? nameOfAgent(o.agent) : 'Bot',
      replied: !!firstReply, repliedAt: firstReply?.at ?? null,
    })
  }
  for (const a of agentRows.values()) a.leadsContacted = agentLeads.get(a.agent)?.size ?? 0
  for (const i of dayIns) ensure(ownerAt(i.sessionId, i.at), 'unassigned').replies++

  // Tasks completed that day — the newest revision of each task decides.
  const taskLatest = new Map<string, ReturnType<typeof parseCrmTask>>()
  for (const r of taskRows) { const t = parseCrmTask(r.message); if (t?.id) taskLatest.set(t.id, t) }
  for (const t of taskLatest.values()) {
    if (!t || t.deleted || t.status !== 'done' || !t.completed_at || pktDayKey(t.completed_at) !== day) continue
    const by = lower(t.completed_by)
    if (isBot(by)) continue
    ensure(by).tasksDone++
    base.totals.tasksDone++
  }

  // Still waiting: the customer's last message of the day has nothing after it.
  const lastInOfDay = new Map<string, In>()
  for (const i of dayIns) lastInOfDay.set(i.sessionId, i)
  for (const i of lastInOfDay.values()) {
    const answered = (outsBySession.get(i.sessionId) ?? []).some((o) => o.at > i.at)
    const later = (insBySession.get(i.sessionId) ?? []).some((x) => x.at > i.at)
    if (answered || later) continue
    // "Thank you!" needs no answer.
    if (isClosingMessage(i.snippet.split(/\n|-{5,}|On (Mon|Tue|Wed|Thu|Fri|Sat|Sun), /)[0])) continue
    const owner = ownerAt(i.sessionId, i.at)
    ensure(owner, 'unassigned').waiting++
    base.waiting.push({
      sessionId: i.sessionId, siteId: i.siteId, siteName: siteName[i.siteId] ?? i.siteId,
      customer: i.from, agent: owner, agentName: owner ? nameOfAgent(owner) : 'No agent yet',
      at: i.at, via: i.via, snippet: i.snippet,
    })
  }
  base.waiting.sort((a, b) => a.at.localeCompare(b.at))

  // ── customer names: the lead's own name beats an email address ────────────
  const quoteIds = Array.from(new Set(
    [...base.items.map((x) => x.sessionId), ...base.waiting.map((x) => x.sessionId)]
      .filter((s) => s.startsWith('quote-')).map((s) => s.slice(6)),
  ))
  if (quoteIds.length > 0) {
    const { data: leads } = await inChunks<{ id: string; name: string | null; email: string | null }>(
      quoteIds, (chunk) => supabase.from('leads').select('id, name, email').in('id', chunk),
    )
    const nameOf = new Map<string, string>()
    for (const l of leads) { const n = (l.name ?? '').trim() || (l.email ?? '').trim(); if (n) nameOf.set(`quote-${l.id}`, n) }
    for (const x of base.items) { const n = nameOf.get(x.sessionId); if (n) x.customer = n }
    for (const x of base.waiting) { const n = nameOf.get(x.sessionId); if (n && !x.customer) x.customer = n }
  }
  // A call row carries no name; borrow it from anything else sent to that lead.
  const anyName = new Map<string, string>()
  for (const o of outs) if (o.customer && !anyName.has(o.sessionId)) anyName.set(o.sessionId, o.customer)
  for (const x of base.items) if (!x.customer) x.customer = anyName.get(x.sessionId) ?? 'Customer'
  for (const x of base.waiting) if (!x.customer) x.customer = anyName.get(x.sessionId) ?? 'Customer'

  // ── totals ─────────────────────────────────────────────────────────────────
  const today = trendByDay.get(day)
  if (today) Object.assign(base.totals, today)
  base.totals.followupsAnswered = base.items.filter((x) => CHASE.has(x.kind) && x.replied).length
  base.totals.waiting = base.waiting.length
  base.items.sort((a, b) => b.at.localeCompare(a.at))
  base.agents = Array.from(agentRows.values())
    .sort((a, b) => (a.agent.includes('@') ? 0 : 1) - (b.agent.includes('@') ? 0 : 1) || b.sent - a.sent || a.name.localeCompare(b.name))
  return base
}
