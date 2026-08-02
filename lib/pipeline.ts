// Pipeline aggregation — the data behind /pipeline (kanban + list).
//
// ── What a "lead" is here ────────────────────────────────────────────────────
// Exactly what it is everywhere else in the dashboard: a chat session that
// produced a lead_capture row, or a row in the `leads` table (custom quote /
// checkout email). Email-only leads use the same synthetic `quote-<leadId>` id
// the Billing tab and the record page already use, so a card links straight to
// /leads/<id> with no new identity scheme.
//
// ── Access ───────────────────────────────────────────────────────────────────
// Site scope is applied IN THE QUERIES, not after them. A member physically
// cannot receive a lead for a site they are not assigned to, and the drag-drop
// write goes through the existing /api/leads/[id]/stage endpoint, which runs
// guardLeadAccess again on the server.
//
// ── Load shape ───────────────────────────────────────────────────────────────
// The BROWSER never receives every lead: each column returns a page of cards.
// The server, though, must fold every matching lead to produce honest column
// totals — "12 cards but 240 matching leads" has to say 240. That fold is kept
// affordable by three bounds: site scope, the creation-date window the filter
// bar always supplies, and hard row caps. See CLAUDE.md §6 — this DB has been
// taken down once by an unbounded scan.

import { supabase, fetchAllPages } from './supabase'
import { memberSites, type Member } from './auth'
import { asUtcIso, CONTACT_ROLE, parseContact } from './visitor'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import { ASSIGNMENT_ROLE } from './assignment'
import { quoteSessionId, isCheckoutLeadMessage, isQuoteLeadMessage } from './quoteintake'
import {
  CRM_STAGE_ROLE, CRM_VALUE_ROLE, CRM_STAGES, DEFAULT_CURRENCY,
  CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE,
  parseCrmStage, parseCrmValue, stageFromLeadStatus,
  type CrmStage, type CrmCurrency,
} from './crm'
import { CRM_TASK_ROLE, parseCrmTask, taskBucket } from './tasks'
import { parseCrmEmailIn, parseCrmEmailRead } from './emailreply'
import type { LeadKind } from './leadrecord'

const CONTROL_ROW_CAP = 30000
const LEAD_ROW_CAP = 20000
/** Cards sent per column on the first load. */
export const CARDS_PER_COLUMN = 12

export interface PipelineCard {
  id: string
  name: string
  email: string | null
  siteId: string
  siteName: string
  kind: LeadKind
  stage: CrmStage
  /** The deal number worth showing: won revenue once Won, otherwise estimated. */
  value: number | null
  currency: CrmCurrency
  owner: string | null
  createdAt: string | null
  lastActivityAt: string | null
  openTasks: number
  overdueTasks: number
  /** Customer replies nobody has opened — "this lead is waiting on you". */
  unreadReplies: number
}

/** Per-currency subtotal. Values are NEVER summed across currencies. */
export interface CurrencyTotal {
  currency: CrmCurrency
  total: number
  /** How many leads contributed to this subtotal. */
  leads: number
}

export interface PipelineColumn {
  stage: CrmStage
  /** Every matching lead in this stage — not the number of cards returned. */
  count: number
  totals: CurrencyTotal[]
  /** Leads in this column that carry no value at all. */
  unvalued: number
  cards: PipelineCard[]
  hasMore: boolean
}

export interface PipelineFilters {
  siteId?: string
  owner?: string
  stage?: CrmStage | 'all'
  /** ISO instants bounding lead CREATION. */
  from?: string
  to?: string
}

export interface PipelineResult {
  columns: PipelineColumn[]
  total: number
  options: {
    sites: { siteId: string; name: string }[]
    owners: string[]
  }
  /** True when the row caps were hit — the page says so rather than lying. */
  truncated: boolean
}

interface ControlRow { session_id: string; site_id: string; role: string; message: string; created_at: string }
interface LeadRow {
  id: string; site_id: string; name: string | null; email: string | null
  phone: string | null; message: string | null; created_at: string
}

// ── Load ─────────────────────────────────────────────────────────────────────
export async function loadPipeline(
  member: Member,
  filters: PipelineFilters,
  opts: { perColumn?: number; offsets?: Partial<Record<CrmStage, number>> } = {},
): Promise<PipelineResult> {
  const allowed = memberSites(member)
  const empty = (): PipelineResult => ({
    columns: CRM_STAGES.map((stage) => ({ stage, count: 0, totals: [], unvalued: 0, cards: [], hasMore: false })),
    total: 0, options: { sites: [], owners: [] }, truncated: false,
  })
  if (allowed.length === 0) return empty()

  // A site filter can only ever NARROW the member's scope, never widen it.
  const sites = filters.siteId && allowed.includes(filters.siteId) ? [filters.siteId] : allowed
  const since = filters.from ?? new Date(Date.now() - 90 * 86_400_000).toISOString()
  const until = filters.to ?? null

  const [captureRows, leadRows, controlRows, siteRes] = await Promise.all([
    // Chat leads: one lead_capture row per captured session.
    fetchAllPages<ControlRow>(
      () => supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .eq('role', LEAD_CAPTURE_ROLE).in('site_id', sites)
        .gte('created_at', since).order('created_at', { ascending: true }),
      LEAD_ROW_CAP),
    // Email-only leads.
    fetchAllPages<LeadRow>(
      () => supabase.from('leads')
        .select('id, site_id, name, email, phone, message, created_at')
        .in('site_id', sites).gte('created_at', since)
        .order('created_at', { ascending: true }),
      LEAD_ROW_CAP),
    // Everything that decides a card's state. Control rows are always written
    // at or after the lead's creation, so the same window is safe.
    fetchAllPages<ControlRow>(
      () => supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .in('role', [CRM_STAGE_ROLE, LEAD_STATUS_ROLE, CRM_VALUE_ROLE, ASSIGNMENT_ROLE, CONTACT_ROLE, CRM_TASK_ROLE, CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE])
        .in('site_id', sites)
        .gte('created_at', since).order('created_at', { ascending: true }),
      CONTROL_ROW_CAP),
    supabase.from('sites').select('site_id, name'),
  ])

  const truncated = captureRows.length >= LEAD_ROW_CAP || controlRows.length >= CONTROL_ROW_CAP

  const siteName: Record<string, string> = {}
  for (const s of siteRes.data ?? []) siteName[s.site_id] = s.name

  // ── seed one card per lead ─────────────────────────────────────────────────
  const cards = new Map<string, PipelineCard>()

  const blank = (id: string, siteId: string, kind: LeadKind, createdAt: string | null): PipelineCard => ({
    id, name: '', email: null, siteId, siteName: siteName[siteId] ?? siteId, kind,
    stage: 'new', value: null, currency: DEFAULT_CURRENCY, owner: null,
    createdAt, lastActivityAt: createdAt, openTasks: 0, overdueTasks: 0, unreadReplies: 0,
  })

  for (const r of captureRows) {
    const c = parseLeadCapture(r.message)
    const card = blank(r.session_id, r.site_id, 'chat', asUtcIso(c?.at || r.created_at))
    card.name = (c?.name || c?.email || c?.phone || '').trim()
    card.email = c?.email ?? null
    cards.set(r.session_id, card) // ascending → the newest capture wins
  }

  for (const l of leadRows) {
    const id = quoteSessionId(l.id)
    const kind: LeadKind = isCheckoutLeadMessage(l.message) ? 'checkout' : isQuoteLeadMessage(l.message) ? 'quote' : 'chat'
    const card = blank(id, l.site_id, kind, asUtcIso(l.created_at))
    card.name = (l.name || l.email || l.phone || '').trim()
    card.email = l.email
    cards.set(id, card)
  }

  // ── fold control rows onto the cards ───────────────────────────────────────
  // A crm_stage row and its paired legacy lead_status row share one created_at
  // (see the stage endpoint). Collect those instants first so the legacy row —
  // which maps back to a coarser 5-value status — can never overwrite the real
  // 7-stage value it was written alongside.
  const stagePairAt = new Set<string>()
  for (const r of controlRows) if (r.role === CRM_STAGE_ROLE) stagePairAt.add(`${r.session_id}|${r.created_at}`)

  const now = new Date()
  const taskState = new Map<string, Map<string, { due: string; status: string; deleted: boolean }>>()
  const replyState = new Map<string, { seen: Set<string>; read: Set<string> }>()
  const money = new Map<string, { estimated: number | null; won: number | null; currency: CrmCurrency }>()

  for (const r of controlRows) {
    const card = cards.get(r.session_id)
    if (!card) continue // a control row on a session that is not a lead
    const at = asUtcIso(r.created_at)
    if (at && (!card.lastActivityAt || at > card.lastActivityAt)) card.lastActivityAt = at

    switch (r.role) {
      case CRM_STAGE_ROLE: {
        const s = parseCrmStage(r.message)
        if (s) card.stage = s.stage
        break
      }
      case LEAD_STATUS_ROLE: {
        if (stagePairAt.has(`${r.session_id}|${r.created_at}`)) break
        const mapped = stageFromLeadStatus(parseLeadStatus(r.message)?.status)
        if (mapped) card.stage = mapped
        break
      }
      case CRM_VALUE_ROLE: {
        const v = parseCrmValue(r.message)
        if (v) {
          // Both numbers are kept and the choice is made AFTER the fold: the
          // stage may still change on a later row, and a Won deal whose stage
          // row lands after its value row must not be left showing the estimate.
          money.set(r.session_id, { estimated: v.estimated, won: v.won, currency: v.currency })
        }
        break
      }
      case ASSIGNMENT_ROLE:
        card.owner = (r.message ?? '').trim() || null
        break
      case CONTACT_ROLE: {
        const c = parseContact(r.message)
        if (!card.name && (c.name || c.email)) card.name = (c.name || c.email).trim()
        if (!card.email && c.email) card.email = c.email
        break
      }
      case CRM_TASK_ROLE: {
        const t = parseCrmTask(r.message)
        if (!t) break
        let per = taskState.get(r.session_id)
        if (!per) { per = new Map(); taskState.set(r.session_id, per) }
        per.set(t.id, { due: t.due_at, status: t.status, deleted: t.deleted === true })
        break
      }
      // Inbound replies and their read marks are folded the same way tasks are:
      // collect per session first, subtract after, so a read row that arrives
      // before its reply (possible, since both are appended) still counts.
      case CRM_EMAIL_IN_ROLE: {
        const e = parseCrmEmailIn(r.message)
        if (!e) break
        let per = replyState.get(r.session_id)
        if (!per) { per = { seen: new Set(), read: new Set() }; replyState.set(r.session_id, per) }
        per.seen.add(e.gmailId)
        break
      }
      case CRM_EMAIL_READ_ROLE: {
        const e = parseCrmEmailRead(r.message)
        if (!e) break
        let per = replyState.get(r.session_id)
        if (!per) { per = { seen: new Set(), read: new Set() }; replyState.set(r.session_id, per) }
        per.read.add(e.gmailId)
        break
      }
    }
  }

  for (const [sessionId, st] of replyState) {
    const card = cards.get(sessionId)
    if (!card) continue
    let unread = 0
    for (const id of st.seen) if (!st.read.has(id)) unread++
    card.unreadReplies = unread
  }

  // Now that every stage row has been seen, pick the number to show: won
  // revenue on a Won deal, the estimate everywhere else.
  for (const [sessionId, m] of money) {
    const card = cards.get(sessionId)
    if (!card) continue
    card.value = card.stage === 'won' && m.won !== null ? m.won : m.estimated
    card.currency = m.currency
  }

  for (const [sessionId, per] of taskState) {
    const card = cards.get(sessionId)
    if (!card) continue
    for (const t of per.values()) {
      if (t.deleted || t.status !== 'open') continue
      card.openTasks++
      if (taskBucket(t.due, now) === 'overdue') card.overdueTasks++
    }
  }

  // ── filters that can only be applied once a card is whole ──────────────────
  let list = Array.from(cards.values())
  if (until) list = list.filter((c) => !c.createdAt || c.createdAt <= until)
  if (filters.owner) {
    list = filters.owner === '__unassigned__'
      ? list.filter((c) => !c.owner)
      : list.filter((c) => c.owner === filters.owner)
  }
  if (filters.stage && filters.stage !== 'all') list = list.filter((c) => c.stage === filters.stage)

  for (const c of list) if (!c.name) c.name = c.email || 'Unnamed lead'

  // ── columns: exact aggregates over EVERY matching lead ─────────────────────
  const perColumn = opts.perColumn ?? CARDS_PER_COLUMN
  const columns: PipelineColumn[] = CRM_STAGES.map((stage) => {
    const inStage = list.filter((c) => c.stage === stage)
    // Newest first — the freshest work belongs at the top of a column.
    inStage.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))

    const byCurrency = new Map<CrmCurrency, { total: number; leads: number }>()
    let unvalued = 0
    for (const c of inStage) {
      if (c.value === null) { unvalued++; continue }
      const cur = byCurrency.get(c.currency) ?? { total: 0, leads: 0 }
      cur.total += c.value
      cur.leads++
      byCurrency.set(c.currency, cur)
    }
    // Ordered by LEAD COUNT, never by amount. Ranking currencies by magnitude
    // would itself be a cross-currency comparison: PKR 480,000 (~$1,700) sorts
    // above USD 15,700 purely because rupees carry bigger numbers, and the
    // column would headline the smaller pile of money. Lead count is
    // currency-neutral, so the headline is the currency most of this column is
    // actually denominated in. Ties break on the currency code for stability.
    const totals: CurrencyTotal[] = Array.from(byCurrency.entries())
      .map(([currency, v]) => ({ currency, total: v.total, leads: v.leads }))
      .sort((a, b) => b.leads - a.leads || a.currency.localeCompare(b.currency))

    const offset = opts.offsets?.[stage] ?? 0
    return {
      stage,
      count: inStage.length,
      totals,
      unvalued,
      cards: inStage.slice(offset, offset + perColumn),
      hasMore: inStage.length > offset + perColumn,
    }
  })

  const owners = Array.from(new Set(list.map((c) => c.owner).filter((o): o is string => !!o))).sort()
  const siteOptions = Array.from(new Set(list.map((c) => c.siteId)))
    .map((id) => ({ siteId: id, name: siteName[id] ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return { columns, total: list.length, options: { sites: siteOptions, owners }, truncated }
}

// ── Display helpers (client-safe) ────────────────────────────────────────────
// Kept here so the board header and the list footer describe a column the same
// way, and so the multi-currency rule lives in exactly one place.
export const DATE_PRESETS = [
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
  { key: '1y', label: 'Last year', days: 365 },
  { key: 'all', label: 'All time', days: 3650 },
] as const

export type DatePresetKey = (typeof DATE_PRESETS)[number]['key']

export function presetSince(key: DatePresetKey): string {
  const p = DATE_PRESETS.find((d) => d.key === key) ?? DATE_PRESETS[1]
  return new Date(Date.now() - p.days * 86_400_000).toISOString()
}
