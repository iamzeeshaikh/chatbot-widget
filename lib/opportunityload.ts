// Server side of the Opportunities tab: read the rows, fold them through the
// pure functions in lib/opportunities.ts, and shape the four lists, the top
// strip and the leaderboard. Packaging only (WORKSPACE_FEATURES 'opportunities').
//
// Owner's rule (2026-10-20): everyone sees everything — every agent sees every
// lead, every amount and the whole leaderboard, so there is no per-member
// narrowing beyond the member's own site scope.
//
// Load: the expensive part is email bodies (~3k outbound + ~1.5k inbound rows
// in three months, ~20MB). It is the same for every member of the workspace,
// so the result is cached in memory for a few minutes per site scope, and the
// window is bounded (this month and the two before it). Every query is
// site-scoped and role-filtered in SQL, and every capped read says so
// (CLAUDE.md §6).

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { memberSites, type Member } from './auth'
import { notALeadSessions } from './notalead'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { quoteSessionId } from './quoteintake'
import { pktMonthOf, pktMonthRange } from './datetime'
import { SITE_DOMAINS } from './sitedomains'
import { readSales } from './sales'
import { figures, SALES_OWNERS } from './salescore'
import { storedMemberNames } from './membername'
import { agentDisplayName } from './agentname'
import { canSeeContacts, scrubText } from './pii'
import {
  foldLeads, readHot, readWaiting, readInvoiceDue, readOlder, readNoHuman, agentKey, oneLine, ourAddress, eventAt,
  type OppLead, type OppRow, type OppSale, type OppContext, type LeadState,
} from './opportunities'
import type { CrmStage } from './crm'
import { CRM_BOT_DRAFT_ROLE, foldDrafts } from './botdraft'

const ROW_CAP = 60_000
const LEAD_CAP = 20_000
const CACHE_MS = 3 * 60_000

// The team's own domains beyond the site domains: agent logins and the
// intake mailbox. A reply from any of these is OURS.
const TEAM_DOMAINS = ['shopcardboardboxes.com', 'zeecustomboxes.com', 'zeeops.dev', 'thecosmeticboxes.com']

export interface OppItem {
  id: string
  name: string
  siteId: string
  siteName: string
  stage: CrmStage
  owner: string | null
  ownerName: string
  createdAt: string
  quote: number | null
  quoteAt: string | null
  lastLine: string
  lastLineAt: string | null
  // section specifics
  hours?: number
  /** A bot draft is waiting on this lead for a person to press Send — since when. */
  draftAt?: string
  channel?: 'email' | 'whatsapp'
  reason?: string
  score?: number
  hot?: boolean
  waiting?: boolean
  restricted?: string | null
  invoice?: { label: string; amount: number | null; sentAt: string; customerSaysPaid: boolean; wonNoSale: boolean; partial: boolean }
}

export interface LeaderRow {
  agent: string
  name: string
  wonCount: number
  wonUsd: number
  pipelineUsd: number
  hot: number
  waiting: number
  /** New leads no person has answered yet (bot only). */
  noHuman: number
  /** Bot drafts on their leads nobody has sent yet. */
  drafts: number
}

/** A sale booked this month — what the leaderboard's Won cells open. */
export interface WonItem { saleId: string; leadId: string | null; customer: string; amount: number; currency: string; orderDate: string; reference: string; owner: string | null }

/** Addresses that are never a customer: the owner's own (his test leads) — on
 *  top of every member address and our own domains, which ourAddress() covers. */
const OWNER_ADDRESSES = ['shanzeeshan571@gmail.com', ...SALES_OWNERS]

export interface OpportunitiesResult {
  generatedAt: string
  month: string
  monthLabel: string
  strip: {
    bookedUsd: number; bookedCount: number
    invoicesDueUsd: number; invoicesDueCount: number
    hotUsd: number; hotCount: number
    waitingCount: number; waitingOver24: number
    noHumanCount: number
    draftsCount: number
  }
  leaderboard: LeaderRow[]
  won: WonItem[]
  waiting: OppItem[]
  /** New leads with only the bot's reply so far (lib/opportunities.ts readNoHuman). */
  noHuman: OppItem[]
  /** Leads where the bot drafted the first reply and nobody has sent it (owner, 2026-10-23). */
  drafts: OppItem[]
  invoices: OppItem[]
  hot: OppItem[]
  older: OppItem[]
  excluded: { restricted: number; notALead: number; ownTests: number }
  windowFrom: string
  truncated: boolean
}

const cache = new Map<string, { at: number; data: OpportunitiesResult }>()

export async function loadOpportunities(member: Member, opts: { fresh?: boolean } = {}): Promise<OpportunitiesResult> {
  const sites = memberSites(member).slice().sort()
  const key = `${member.workspace}|${sites.join(',')}|${canSeeContacts(member) ? 'c' : 'n'}`
  const hit = cache.get(key)
  // A forced refresh still reuses a result under 30 seconds old, so a button
  // pressed repeatedly cannot turn into a stream of 20MB reads.
  if (hit && Date.now() - hit.at < (opts.fresh ? 30_000 : CACHE_MS)) return hit.data
  const data = await build(member, sites)
  cache.set(key, { at: Date.now(), data })
  return data
}

async function build(member: Member, sites: string[]): Promise<OpportunitiesResult> {
  const now = new Date()
  const { year, month } = pktMonthOf(now)
  const monthRange = pktMonthRange(year, month)
  const startY = month <= 2 ? year - 1 : year
  const startM = ((month - 3 + 12) % 12) + 1
  const windowFrom = pktMonthRange(startY, startM).from

  const empty: OpportunitiesResult = {
    generatedAt: now.toISOString(), month: `${year}-${String(month).padStart(2, '0')}`, monthLabel: monthName(year, month),
    strip: { bookedUsd: 0, bookedCount: 0, invoicesDueUsd: 0, invoicesDueCount: 0, hotUsd: 0, hotCount: 0, waitingCount: 0, waitingOver24: 0, noHumanCount: 0, draftsCount: 0 },
    leaderboard: [], won: [], waiting: [], noHuman: [], drafts: [], invoices: [], hot: [], older: [], excluded: { restricted: 0, notALead: 0, ownTests: 0 }, windowFrom, truncated: false,
  }
  if (sites.length === 0) return empty

  const [captureRows, leadRows, rows, siteRes, notLeads, sales, names, members, draftRows] = await Promise.all([
    fetchAllPages<OppRow>(
      () => supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
        .eq('role', LEAD_CAPTURE_ROLE).in('site_id', sites).gte('created_at', windowFrom)
        .order('created_at', { ascending: true }),
      LEAD_CAP),
    fetchAllPages<{ id: string; site_id: string; name: string | null; email: string | null; phone: string | null; message: string | null; created_at: string }>(
      () => supabase.from('leads').select('id, site_id, name, email, phone, message, created_at')
        .in('site_id', sites).gte('created_at', windowFrom)
        .order('created_at', { ascending: true }),
      LEAD_CAP),
    fetchAllPages<OppRow>(
      () => supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
        .in('role', ['crm_email', 'crm_email_in', 'crm_wa_in', 'crm_wa_out', 'crm_stage', 'lead_status', 'crm_value', 'assignment', 'crm_pay_link', 'crm_invoice_doc'])
        .in('site_id', sites).gte('created_at', windowFrom)
        .order('created_at', { ascending: true }),
      ROW_CAP),
    supabase.from('sites').select('site_id, name'),
    notALeadSessions(sites),
    member.workspace === 'packaging' ? readSales('packaging') : Promise.resolve([]),
    storedMemberNames(),
    supabase.from('members').select('email, workspace'),
    fetchAllPages<{ session_id: string; role: string; message: string; created_at: string }>(
      () => supabase.from('chat_logs').select('session_id, role, message, created_at')
        .eq('role', CRM_BOT_DRAFT_ROLE).in('site_id', sites).gte('created_at', windowFrom)
        .order('created_at', { ascending: true }),
      LEAD_CAP),
  ])
  // Pending bot drafts per lead: the newest revision of each draft decides.
  const pendingDraft = new Map<string, string>()
  {
    const bySession = new Map<string, { role: string; message: string }[]>()
    for (const d of draftRows) { const l = bySession.get(d.session_id) ?? []; l.push(d); bySession.set(d.session_id, l) }
    for (const [sid, list] of bySession) {
      const pend = foldDrafts(list).filter((d) => d.status === 'pending')
      if (pend.length) pendingDraft.set(sid, String((pend[pend.length - 1] as { at?: string }).at ?? ''))
    }
  }
  const truncated = warnIfCapped('opportunities rows', rows.length, ROW_CAP)
    || warnIfCapped('opportunities leads', leadRows.length, LEAD_CAP)
    || warnIfCapped('opportunities captures', captureRows.length, LEAD_CAP)

  const siteName: Record<string, string> = {}
  for (const s of siteRes.data ?? []) siteName[s.site_id] = s.name

  const ourAddresses = new Set<string>(OWNER_ADDRESSES.map((e) => e.toLowerCase()))
  for (const m of members.data ?? []) if (m.email) ourAddresses.add(String(m.email).toLowerCase())
  const ctx: OppContext = {
    now, monthStart: monthRange.from,
    ourDomains: new Set([...Object.values(SITE_DOMAINS), ...TEAM_DOMAINS]),
    ourAddresses,
  }
  // A lead whose address is ours — the owner testing a form, an agent writing
  // to themselves — is not a customer and never reaches a list or a total.
  let ownTests = 0
  const isOurs = (email: string | null | undefined) => !!email && ourAddress(email, ctx)

  const leads: OppLead[] = []
  let notALead = 0
  for (const l of leadRows) {
    const id = quoteSessionId(l.id)
    if (notLeads.has(id)) { notALead++; continue }
    if (isOurs(l.email)) { ownTests++; continue }
    leads.push({ id, siteId: l.site_id, name: (l.name || '').trim(), email: l.email, phone: l.phone, createdAt: l.created_at, text: l.message || '' })
  }
  for (const r of captureRows) {
    if (notLeads.has(r.session_id)) { notALead++; continue }
    const c = parseLeadCapture(r.message)
    if (isOurs(c?.email)) { ownTests++; continue }
    leads.push({ id: r.session_id, siteId: r.site_id, name: (c?.name || '').trim(), email: c?.email ?? null, phone: c?.phone ?? null, createdAt: c?.at || r.created_at, text: '' })
  }

  const states = foldLeads(leads, rows, ctx)

  // People answering in the live chat ('admin' rows) and calls are read only
  // for the leads that still look untouched — reading every chat reply in the
  // window would be tens of thousands of rows for a handful of answers.
  const untouched = states.filter((s) => readNoHuman(s, now))
  const untouchedIds = untouched.flatMap((s) => s.ids)
  const stateOf = new Map<string, LeadState>()
  for (const s of untouched) for (const id of s.ids) stateOf.set(id, s)
  for (let i = 0; i < untouchedIds.length; i += 100) {
    const { data: extra } = await supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
      .in('role', ['admin', 'crm_call']).in('session_id', untouchedIds.slice(i, i + 100))
    for (const r of (extra ?? []) as OppRow[]) {
      const st = stateOf.get(r.session_id)
      if (!st) continue
      let o: Record<string, unknown> | null = null
      try { o = JSON.parse(r.message) } catch { o = null }
      const at = r.role === 'admin' ? r.created_at : eventAt(r, o)
      if (!at) continue
      const answered = r.role === 'admin'
        || (!!o && typeof o.by === 'string' && !!o.by && /^(completed|in-progress|answered)$/i.test(String(o.status ?? '')))
      if (answered && (!st.humanAt || at < st.humanAt)) st.humanAt = at
    }
  }

  // ── names ──
  const nameByKey = new Map<string, string>()
  for (const [email, n] of names) nameByKey.set(agentKey(email), n)
  const nameOf = (k: string | null) => (k ? nameByKey.get(k) || agentDisplayName(k) : 'Unassigned')
  const keyByName = new Map<string, string>()
  for (const [k, n] of nameByKey) keyByName.set(n.trim().toLowerCase(), k)

  // ── the Sales ledger, Model Town direct only (the partner stream is Hamdan's) ──
  const oppSales: OppSale[] = []
  const direct = sales.filter((s) => s.stream === 'pk_direct')
  for (const s of direct) {
    const f = figures(s, null)
    oppSales.push({
      id: s.id, leadId: s.leadId, reference: s.reference, notes: s.notes, customer: s.customer, email: s.email,
      orderDate: s.orderDate, orderAmount: s.orderAmount, currency: s.currency, status: f.status, outstanding: f.outstanding,
      salesPerson: s.salesPerson, stream: s.stream,
    })
  }

  const contacts = canSeeContacts(member)
  const displayName = (s: LeadState) => {
    const n = s.name || s.email || 'Unnamed lead'
    return contacts ? n : (scrubText(n) || 'Unnamed lead')
  }
  const base = (s: LeadState): OppItem => ({
    id: s.id, name: displayName(s), siteId: s.siteId, siteName: siteName[s.siteId] ?? s.siteId, stage: s.stage,
    owner: s.owner, ownerName: nameOf(s.owner), createdAt: s.createdAt,
    quote: s.quote?.amount ?? s.estimated ?? null, quoteAt: s.quote?.at ?? s.quoteSentAt,
    lastLine: '', lastLineAt: null, restricted: s.restricted,
  })
  const line = (t: string) => {
    const l = oneLine(t, 240)
    return contacts ? l : (scrubText(l) ?? '')
  }

  const waiting: OppItem[] = []
  const noHuman: OppItem[] = []
  const drafts: OppItem[] = []
  const invoices: OppItem[] = []
  const hot: OppItem[] = []
  const older: OppItem[] = []
  let restricted = 0
  const ownerOfLead = new Map<string, string | null>()

  for (const s of states) {
    for (const id of s.ids) ownerOfLead.set(id, s.owner)
    if (s.restricted) restricted++
    const w = readWaiting(s, now)
    const nh = readNoHuman(s, now)
    // A person already reached the customer: the draft is stale, not a job (Laurie Chassé, 28 Oct 2026).
    const draftAt = s.humanAt ? undefined : s.ids.map((id) => pendingDraft.get(id)).find((x) => x !== undefined)
    if (nh) noHuman.push({ ...base(s), hours: nh.hours, lastLine: line(s.customer[s.customer.length - 1]?.text || s.leadText), lastLineAt: nh.since, waiting: !!w, ...(draftAt !== undefined ? { draftAt } : {}) })
    if (draftAt !== undefined) {
      const since = draftAt || s.createdAt
      drafts.push({ ...base(s), hours: Math.max(0, Math.round((now.getTime() - Date.parse(since)) / 36e5 * 10) / 10), draftAt: since, lastLine: line(s.customer[s.customer.length - 1]?.text || s.leadText), lastLineAt: since, waiting: !!w })
    }
    const h = readHot(s, now)
    const inv = readInvoiceDue(s, oppSales, now)
    if (w) waiting.push({ ...base(s), hours: w.hours, channel: w.channel, lastLine: line(w.lastLine), lastLineAt: w.since, hot: h.hot })
    if (inv) {
      invoices.push({
        ...base(s), lastLine: line(s.customer[s.customer.length - 1]?.text ?? ''), lastLineAt: s.customer[s.customer.length - 1]?.at ?? null,
        invoice: { label: inv.label, amount: inv.amount, sentAt: inv.sentAt, customerSaysPaid: inv.customerSaysPaid, wonNoSale: inv.wonNoSale, partial: inv.outstanding !== null },
        waiting: !!w,
      })
      continue // an invoiced deal is past "can close" — it is collecting
    }
    if (h.hot) {
      hot.push({ ...base(s), score: h.score, reason: h.signal.reason, lastLine: line(h.lastLine), lastLineAt: h.lastLineAt, waiting: !!w })
      continue
    }
    const o = readOlder(s, monthRange.from)
    if (o) older.push({ ...base(s), lastLine: line(o.lastLine), lastLineAt: o.lastCustomerAt, waiting: !!w, score: h.score })
  }

  waiting.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))
  noHuman.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))
  drafts.sort((a, b) => (b.hours ?? 0) - (a.hours ?? 0))
  invoices.sort((a, b) => (b.invoice?.sentAt ?? '').localeCompare(a.invoice?.sentAt ?? ''))
  hot.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.lastLineAt ?? '').localeCompare(a.lastLineAt ?? ''))
  older.sort((a, b) => (b.quote ?? 0) - (a.quote ?? 0) || (b.lastLineAt ?? '').localeCompare(a.lastLineAt ?? ''))

  // ── this month's booked sales ──
  const monthKey = empty.month
  const booked = oppSales.filter((s) => s.orderDate.startsWith(monthKey) && s.status !== 'refunded' && s.status !== 'cancelled')
  const usd = (s: OppSale) => (s.currency === 'USD' ? s.orderAmount : 0)
  // Who booked it: the sales person on the sale (an address or a display
  // name), else the owner of the lead it was won from.
  const agentOfSale = (sale: OppSale): string | null => {
    const sp = sale.salesPerson.trim()
    if (sp.includes('@')) return agentKey(sp)
    return keyByName.get(sp.toLowerCase()) ?? (sale.leadId ? ownerOfLead.get(sale.leadId) ?? null : null)
  }

  const won: WonItem[] = booked.map((sale) => ({
    saleId: sale.id, leadId: sale.leadId, customer: sale.customer, amount: sale.orderAmount, currency: sale.currency,
    orderDate: sale.orderDate, reference: sale.reference, owner: agentOfSale(sale),
  }))

  // ── leaderboard ──
  const board = new Map<string, LeaderRow>()
  const row = (k: string | null) => {
    const agent = k ?? ''
    let r = board.get(agent)
    if (!r) { r = { agent, name: nameOf(k), wonCount: 0, wonUsd: 0, pipelineUsd: 0, hot: 0, waiting: 0, noHuman: 0, drafts: 0 }; board.set(agent, r) }
    return r
  }
  // Every packaging agent appears, even with nothing on their name yet.
  for (const m of members.data ?? []) {
    if (m.workspace !== member.workspace) continue
    const e = String(m.email || '').toLowerCase()
    if (!e.endsWith('@shopcardboardboxes.com')) continue
    row(agentKey(e))
  }
  for (const w of won) {
    const r = row(w.owner)
    r.wonCount++
    r.wonUsd += w.currency === 'USD' ? w.amount : 0
  }
  for (const i of hot) { const r = row(i.owner); r.hot++; r.pipelineUsd += i.quote ?? 0 }
  for (const i of invoices) row(i.owner).pipelineUsd += i.invoice?.amount ?? 0
  for (const i of waiting) row(i.owner).waiting++
  for (const i of noHuman) row(i.owner).noHuman++
  for (const i of drafts) row(i.owner).drafts++
  const leaderboard = [...board.values()]
    .map((r) => ({ ...r, wonUsd: Math.round(r.wonUsd), pipelineUsd: Math.round(r.pipelineUsd) }))
    .sort((a, b) => b.wonUsd - a.wonUsd || b.pipelineUsd - a.pipelineUsd || a.name.localeCompare(b.name))

  return {
    ...empty,
    strip: {
      bookedUsd: Math.round(booked.reduce((a, s) => a + usd(s), 0)),
      bookedCount: booked.length,
      invoicesDueUsd: Math.round(invoices.reduce((a, i) => a + (i.invoice?.amount ?? 0), 0)),
      invoicesDueCount: invoices.length,
      hotUsd: Math.round(hot.reduce((a, i) => a + (i.quote ?? 0), 0)),
      hotCount: hot.length,
      waitingCount: waiting.length,
      waitingOver24: waiting.filter((w) => (w.hours ?? 0) >= 24).length,
      noHumanCount: noHuman.length,
      draftsCount: drafts.length,
    },
    leaderboard,
    won,
    waiting, noHuman, drafts, invoices, hot,
    older: older.slice(0, 150),
    excluded: { restricted, notALead, ownTests },
    truncated,
  }
}

function monthName(y: number, m: number): string {
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`
}
