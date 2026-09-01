// Month-end performance report — the aggregation behind /reports.
//
// ── Definitions are BORROWED, never redefined ────────────────────────────────
// Every rule here is the one the dashboard already uses, imported rather than
// reimplemented: control rows are skipped with isControlRole (the single source
// of truth), visitor bot-bursts with findBurstKeys, closing pleasantries with
// isClosingMessage,
// response outliers with RESPONSE_OUTLIER_CAP_MS, and billable leads with the
// same site+email dedupe that excludes checkout. scratch/report-crosscheck.test.mjs
// asserts the totals equal the live /api/admin/performance and
// /api/admin/leads-billing endpoints for the same range — if a definition ever
// drifts, that test fails.
//
// ── Vocabulary ───────────────────────────────────────────────────────────────
//   clicks     widget sessions (active_visitors rows, bot bursts removed).
//              "Clicks" is what the client calls a visitor landing on the widget.
//   chats      sessions where the VISITOR actually typed.
//   picked     sessions an agent replied in (or opened proactively).
//   notPicked  clicks − picked, exactly as the existing daily table computes it.
//   leads      every captured lead: chat + custom quote + checkout.
//   checkout   the WooCommerce-order subset of leads. Counted in leads, never
//              in billable — see CLAUDE.md §8.
//   billable   leads deduped by site+email across chat and quote, checkout
//              removed. Identical key to app/api/admin/leads-billing.

import { supabase, fetchAllPages } from './supabase'
import { siteScope, HARDCODED_ACCOUNTS, type Member } from './auth'
import { MODE_ROLE } from './mode'
import { asUtcIso } from './visitor'
import { isControlRole } from './controlroles'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { REPLY_AUTHOR_ROLE, RESPONSE_SLA_MS, RESPONSE_OUTLIER_CAP_MS, parseReplyAuthor, type ReplyAuthor } from './replyauthor'
import { findBurstKeys, burstKey } from './botfilter'
import { isClosingMessage } from './closing'
import { QUOTE_TAG, CHECKOUT_TAG, quoteSessionId, stripQuoteTag } from './quoteintake'
import { pktDayKey, pktDaysInRange, describeRange, type ReportRange } from './datetime'
import { notALeadSessions } from './notalead'

const ROW_CAP = 60000

export interface Metrics {
  clicks: number
  chats: number
  picked: number
  notPicked: number
  leads: number
  checkout: number
  billable: number
  /** leads ÷ chats, as a fraction. null when there were no chats to convert. */
  conversionRate: number | null
  /** picked ÷ clicks, as a fraction. null when nobody landed. */
  pickupRate: number | null
  /** Mean first-response time, outliers past the cap excluded. */
  avgResponseMs: number | null
}

export interface AgentRow {
  email: string
  /** Distinct sessions this agent replied in. */
  chats: number
  replies: number
  leads: number
  avgResponseMs: number | null
  slowReplies: number
  measuredReplies: number
  active: boolean
}

export interface SiteRow extends Metrics {
  siteId: string
  siteName: string
}

export interface DayRow extends Metrics {
  date: string
}

/** One captured lead, as it appears on the client-facing leads report. */
export interface LeadDetail {
  capturedAt: string
  name: string | null
  email: string | null
  phone: string | null
  siteId: string
  siteName: string
  source: 'chat' | 'quote' | 'checkout'
  /** True for the row that carries the charge. */
  billable: boolean
  /** Why a row is not billable — shown so the client can see nothing was hidden. */
  reason: 'checkout order' | 'duplicate of an earlier lead' | null
  /** The customer's own words, for quote and checkout leads. */
  enquiry: string | null
}

export interface ReportData {
  range: ReportRange
  periodLabel: string
  workspace: string
  workspaceLabel: string
  generatedAt: string
  totals: Metrics
  agents: AgentRow[]
  agentTotals: Pick<AgentRow, 'chats' | 'replies' | 'leads' | 'slowReplies' | 'measuredReplies'>
  sites: SiteRow[]
  days: DayRow[]
  /** Every captured lead in the period, newest first. */
  leadDetail: LeadDetail[]
  /** Replies with no reply_author row (predates attribution). */
  unattributedReplies: number
  truncated: boolean
}

const emptyMetrics = (): Metrics => ({
  clicks: 0, chats: 0, picked: 0, notPicked: 0, leads: 0, checkout: 0, billable: 0,
  conversionRate: null, pickupRate: null, avgResponseMs: null,
})

/** Derived rates, applied once a bucket's raw counts are final. */
function finalise(m: Metrics, respSum: number, respCount: number): Metrics {
  m.notPicked = Math.max(0, m.clicks - m.picked)
  m.conversionRate = m.chats > 0 ? m.leads / m.chats : null
  m.pickupRate = m.clicks > 0 ? m.picked / m.clicks : null
  m.avgResponseMs = respCount > 0 ? Math.round(respSum / respCount) : null
  return m
}

export async function buildReport(member: Member, range: ReportRange): Promise<ReportData> {
  const scope = siteScope(member)
  const allowed = Array.from(scope)
  const { from, to } = range

  const base: ReportData = {
    range, periodLabel: describeRange(range),
    workspace: member.workspace,
    workspaceLabel: member.workspace === 'packaging' ? 'ZeeOps Packaging' : 'ZeeOps Sports',
    generatedAt: new Date().toISOString(),
    totals: emptyMetrics(), agents: [], sites: [], days: [], leadDetail: [],
    agentTotals: { chats: 0, replies: 0, leads: 0, slowReplies: 0, measuredReplies: 0 },
    unattributedReplies: 0, truncated: false,
  }
  if (allowed.length === 0) return base

  const [rows, visitorRows, quoteRows, checkoutRows, sitesRes, memberRows] = await Promise.all([
    fetchAllPages<{ session_id: string; site_id: string; role: string; message: string; created_at: string }>(
      () => supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .in('site_id', allowed).gte('created_at', from).lt('created_at', to)
        .order('created_at', { ascending: true }),
      ROW_CAP),
    fetchAllPages<{ session_id: string; site_id: string; user_agent: string | null; created_at: string }>(
      () => supabase.from('active_visitors')
        .select('session_id, site_id, user_agent, created_at')
        .in('site_id', allowed).gte('created_at', from).lt('created_at', to)
        .order('created_at', { ascending: true }),
      ROW_CAP),
    supabase.from('leads').select('id, site_id, name, email, phone, message, created_at')
      .ilike('message', `${QUOTE_TAG}%`).gte('created_at', from).lt('created_at', to),
    supabase.from('leads').select('id, site_id, name, email, phone, message, created_at')
      .ilike('message', `${CHECKOUT_TAG}%`).gte('created_at', from).lt('created_at', to),
    supabase.from('sites').select('site_id, name'),
    supabase.from('members').select('id, email').eq('workspace', member.workspace),
  ])
  base.truncated = rows.length >= ROW_CAP || visitorRows.length >= ROW_CAP

  const siteName: Record<string, string> = {}
  for (const s of sitesRes.data ?? []) siteName[s.site_id] = s.name

  // ── agent roster (built-ins + workspace members), so idle agents still show ─
  const roster = new Map<string, string>()
  for (const a of HARDCODED_ACCOUNTS.filter((x) => x.workspace === member.workspace)) roster.set(`builtin:${a.email}`, a.email)
  for (const m of memberRows.data ?? []) roster.set(m.id, m.email)

  const t = (ts: string) => new Date(asUtcIso(ts) as string).getTime()

  const authorByKey = new Map<string, ReplyAuthor>()
  const idToEmail = new Map<string, string>()
  for (const r of rows) {
    if (r.role === REPLY_AUTHOR_ROLE) {
      const a = parseReplyAuthor(r.message)
      if (a) { authorByKey.set(`${r.session_id}|${r.created_at}`, a); if (a.email) idToEmail.set(a.id, a.email) }
    }
  }

  type Agg = { handled: Set<string>; replies: number; respSum: number; respCount: number; respExcluded: number; slow: number; leads: number }
  const agg = new Map<string, Agg>()
  const ensure = (id: string): Agg => {
    let a = agg.get(id)
    if (!a) { a = { handled: new Set(), replies: 0, respSum: 0, respCount: 0, respExcluded: 0, slow: 0, leads: 0 }; agg.set(id, a) }
    return a
  }

  const chatted = new Set<string>()
  const answered = new Set<string>()
  const conversations = new Set<string>()
  const leadSessions = new Set<string>()
  const sessionSite = new Map<string, string>()
  let totalReplies = 0, attributedReplies = 0

  // Response time is accumulated per bucket so a site row and a day row each get
  // their own honest average rather than the workspace one.
  const respBySite = new Map<string, { sum: number; count: number }>()
  const respByDay = new Map<string, { sum: number; count: number }>()
  let wsRespSum = 0, wsRespCount = 0
  const addResp = (siteId: string, day: string, dt: number) => {
    wsRespSum += dt; wsRespCount++
    const s = respBySite.get(siteId) ?? { sum: 0, count: 0 }; s.sum += dt; s.count++; respBySite.set(siteId, s)
    const d = respByDay.get(day) ?? { sum: 0, count: 0 }; d.sum += dt; d.count++; respByDay.set(day, d)
  }

  const bySession = new Map<string, typeof rows>()
  for (const r of rows) {
    sessionSite.set(r.session_id, r.site_id)
    if (r.role === LEAD_CAPTURE_ROLE) leadSessions.add(r.session_id)
    let list = bySession.get(r.session_id)
    if (!list) { list = []; bySession.set(r.session_id, list) }
    list.push(r)
  }

  // ── walk each conversation, mirroring the performance route exactly ─────────
  for (const [sid, evs] of bySession) {
    let pendingUserTs: number | null = null
    let hasRealMsg = false
    let adminCount = 0

    for (const ev of evs) {
      // mode rows only matter to the missed-chat rule, which this report does
      // not carry — skipped like any other control row.
      if (ev.role === MODE_ROLE) continue
      if (isControlRole(ev.role)) continue
      if (ev.message === '(session started)') continue

      hasRealMsg = true
      const ts = t(ev.created_at)

      if (ev.role === 'user') {
        chatted.add(sid)
        if (adminCount > 0 && pendingUserTs === null && isClosingMessage(ev.message)) continue
        // The bot-off state is what the performance page uses to decide a
        // "missed" chat. This report does not carry a missed column, so the
        // state is not tracked here — it is computed there, from the same rule.
        if (pendingUserTs === null) pendingUserTs = ts
      } else if (ev.role === 'assistant') {
        pendingUserTs = null
      } else if (ev.role === 'admin') {
        adminCount++
        totalReplies++
        const author = authorByKey.get(`${sid}|${ev.created_at}`)
        if (author) {
          attributedReplies++
          const a = ensure(author.id)
          a.replies++
          a.handled.add(sid)
        }
        if (pendingUserTs !== null) {
          const dt = ts - pendingUserTs
          if (dt >= 0) {
            const isOutlier = dt > RESPONSE_OUTLIER_CAP_MS
            if (isOutlier) {
              if (author) ensure(author.id).respExcluded++
            } else {
              addResp(ev.site_id, pktDayKey(ev.created_at), dt)
              if (author) { const a = ensure(author.id); a.respSum += dt; a.respCount++ }
            }
            if (author && dt > RESPONSE_SLA_MS) ensure(author.id).slow++
          }
          pendingUserTs = null
        }
      }
    }

    if (hasRealMsg) conversations.add(sid)
    if (hasRealMsg && adminCount > 0) answered.add(sid)
    // Lead credit: every agent who replied in a lead-capturing conversation,
    // the same rule the performance page uses.
    if (leadSessions.has(sid)) {
      for (const [id, a] of agg) if (a.handled.has(sid)) ensure(id).leads++
    }
  }

  // ── clicks / picked / chats per site and per day (bot bursts removed) ───────
  const stamped = visitorRows.map((v) => ({ v, ms: new Date(asUtcIso(v.created_at) ?? v.created_at).getTime() }))
  const bursts = findBurstKeys(stamped.map((s) => ({ userAgent: s.v.user_agent, tsMs: s.ms })))
  const seenVisitor = new Set<string>()

  const siteM = new Map<string, Metrics>()
  const dayM = new Map<string, Metrics>()
  const siteOf = (id: string) => { let m = siteM.get(id); if (!m) { m = emptyMetrics(); siteM.set(id, m) } return m }
  const dayOf = (d: string) => { let m = dayM.get(d); if (!m) { m = emptyMetrics(); dayM.set(d, m) } return m }

  for (const { v, ms } of stamped) {
    if (bursts.has(burstKey(v.user_agent, ms))) continue
    if (seenVisitor.has(v.session_id)) continue
    seenVisitor.add(v.session_id)
    const day = pktDayKey(v.created_at)
    const s = siteOf(v.site_id), d = dayOf(day)
    s.clicks++; d.clicks++; base.totals.clicks++
    if (chatted.has(v.session_id)) { s.chats++; d.chats++; base.totals.chats++ }
    if (answered.has(v.session_id)) { s.picked++; d.picked++; base.totals.picked++ }
  }

  // ── leads: chat captures + quote + checkout ────────────────────────────────
  // Shaped like the billing route so the billable key is computed identically.
  interface LeadLike {
    site_id: string; email: string; session_id: string; created_at: string
    source: 'chat' | 'quote' | 'checkout'
    name: string | null; phone: string | null; enquiry: string | null
  }
  const leads: LeadLike[] = []
  for (const r of rows) {
    if (r.role !== LEAD_CAPTURE_ROLE) continue
    const c = parseLeadCapture(r.message)
    leads.push({
      site_id: r.site_id, email: c?.email ?? '', session_id: r.session_id,
      created_at: c?.at || r.created_at, source: 'chat',
      name: c?.name ?? null, phone: c?.phone ?? null, enquiry: null,
    })
  }
  for (const r of quoteRows.data ?? []) {
    if (!scope.has(r.site_id) || !r.email) continue
    leads.push({
      site_id: r.site_id, email: r.email, session_id: quoteSessionId(r.id),
      created_at: r.created_at, source: 'quote',
      name: r.name ?? null, phone: r.phone ?? null, enquiry: stripQuoteTag(r.message),
    })
  }
  for (const r of checkoutRows.data ?? []) {
    if (!scope.has(r.site_id) || !r.email) continue
    leads.push({
      site_id: r.site_id, email: r.email, session_id: quoteSessionId(r.id),
      created_at: r.created_at, source: 'checkout',
      name: r.name ?? null, phone: r.phone ?? null, enquiry: stripQuoteTag(r.message),
    })
  }

  // Billable is deduped GLOBALLY for the totals, and again within each site and
  // each day — a customer who appears twice in one day is one billable lead
  // that day, which is what a per-day invoice line has to mean.
  const billableKey = (l: LeadLike) => (l.email ? `${l.site_id}::${l.email.toLowerCase()}` : `manual::${l.session_id}`)
  const globalBillable = new Set<string>()
  const siteBillable = new Map<string, Set<string>>()
  const dayBillable = new Map<string, Set<string>>()

  // Oldest first, so the FIRST time a customer appears is the row that carries
  // the charge and any later repeat is the one marked as a duplicate. That
  // matches how a client reads an invoice line.
  // Anything marked "not a lead" — a supplier pitch that reached the quote
  // form, a duplicate, a mistake — is dropped before anything is counted, so
  // the report's totals match what the dashboard shows.
  const excluded = await notALeadSessions(Array.from(scope))
  const realLeads = excluded.size === 0 ? leads : leads.filter((l) => !excluded.has(l.session_id))

  const chronological = [...realLeads].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const charged = new Set<string>()
  const detail: LeadDetail[] = []

  for (const l of chronological) {
    const day = pktDayKey(l.created_at)
    const s = siteOf(l.site_id), d = dayOf(day)
    s.leads++; d.leads++; base.totals.leads++

    let billable = false
    let reason: LeadDetail['reason'] = null
    if (l.source === 'checkout') {
      s.checkout++; d.checkout++; base.totals.checkout++
      reason = 'checkout order'
    } else {
      const k = billableKey(l)
      globalBillable.add(k)
      let ss = siteBillable.get(l.site_id); if (!ss) { ss = new Set(); siteBillable.set(l.site_id, ss) } ss.add(k)
      let dd = dayBillable.get(day); if (!dd) { dd = new Set(); dayBillable.set(day, dd) } dd.add(k)
      if (charged.has(k)) reason = 'duplicate of an earlier lead'
      else { charged.add(k); billable = true }
    }

    detail.push({
      capturedAt: asUtcIso(l.created_at) ?? l.created_at,
      name: l.name, email: l.email || null, phone: l.phone,
      siteId: l.site_id, siteName: siteName[l.site_id] ?? l.site_id,
      source: l.source, billable, reason,
      enquiry: l.enquiry ? l.enquiry.replace(/\s+/g, ' ').trim() : null,
    })
  }
  // Newest first for reading; the billable flags were decided oldest-first above.
  base.leadDetail = detail.reverse()
  base.totals.billable = globalBillable.size

  // ── assemble rows ──────────────────────────────────────────────────────────
  // Every site in scope appears, even with no activity at all.
  for (const id of allowed) siteOf(id)
  base.sites = allowed
    .map((id) => {
      const m = siteM.get(id) ?? emptyMetrics()
      m.billable = siteBillable.get(id)?.size ?? 0
      const r = respBySite.get(id)
      return { siteId: id, siteName: siteName[id] ?? id, ...finalise(m, r?.sum ?? 0, r?.count ?? 0) }
    })
    .sort((a, b) => b.leads - a.leads || b.clicks - a.clicks || a.siteName.localeCompare(b.siteName))

  // Every Karachi day in the range, including silent ones.
  base.days = pktDaysInRange(range).map((date) => {
    const m = dayM.get(date) ?? emptyMetrics()
    m.billable = dayBillable.get(date)?.size ?? 0
    const r = respByDay.get(date)
    return { date, ...finalise(m, r?.sum ?? 0, r?.count ?? 0) }
  })

  finalise(base.totals, wsRespSum, wsRespCount)

  // Agents: the whole roster, plus anyone with replies who has since left.
  const seenAgent = new Set<string>()
  const agentRows: AgentRow[] = []
  const push = (id: string, email: string) => {
    const a = agg.get(id)
    agentRows.push({
      email,
      chats: a ? a.handled.size : 0,
      replies: a ? a.replies : 0,
      leads: a ? a.leads : 0,
      avgResponseMs: a && a.respCount ? Math.round(a.respSum / a.respCount) : null,
      slowReplies: a ? a.slow : 0,
      measuredReplies: a ? a.respCount + a.respExcluded : 0,
      active: !!a && a.replies > 0,
    })
    seenAgent.add(id)
  }
  for (const [id, email] of roster) push(id, email)
  for (const [id] of agg) if (!seenAgent.has(id)) push(id, idToEmail.get(id) ?? 'former member')

  agentRows.sort((x, y) => (y.replies - x.replies) || x.email.localeCompare(y.email))
  base.agents = agentRows
  base.agentTotals = agentRows.reduce((acc, r) => ({
    chats: acc.chats + r.chats,
    replies: acc.replies + r.replies,
    leads: acc.leads + r.leads,
    slowReplies: acc.slowReplies + r.slowReplies,
    measuredReplies: acc.measuredReplies + r.measuredReplies,
  }), { chats: 0, replies: 0, leads: 0, slowReplies: 0, measuredReplies: 0 })

  base.unattributedReplies = totalReplies - attributedReplies
  return base
}

// ── formatting shared by the screen, the CSVs and the PDF ────────────────────
export const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

export function durationLabel(ms: number | null): string {
  if (ms === null) return '—'
  const mins = ms / 60000
  if (mins < 1) return `${Math.round(ms / 1000)}s`
  if (mins < 60) return `${mins.toFixed(1)} min`
  return `${(mins / 60).toFixed(1)} h`
}
