// The Lost page (/lost): every Lost lead this member can see, newest lost first,
// with what is needed to try and win it back — what they wanted (product, size,
// quantity), why it was lost, who had it, and when we last reached out.
//
// WHY THIS IS NOT loadPipeline WITH stage=lost. The board folds every control
// row of its window (stage, owner, contact, tasks, replies…) under a 30,000-row
// cap in ascending order — and over a year of packaging that cap is reached,
// which drops the NEWEST rows: measured 2026-11-10, the all-time board showed
// 164 Lost cards while the database held 291 Lost leads, and the missing ones
// were exactly the recently lost. Lost is decided by stage rows alone (~6k
// rows all time), so this reads those first, keeps only the sessions whose
// CURRENT stage is Lost, and then reads everything else for just those leads.
//
// It applies the board's rules itself, in the same order: site scope, "not a
// lead" excluded, the lead's own created_at inside the window, the member's
// pool (own + unassigned; admins / team leads everything; own-leads-only just
// their own), one customer = one row (site + email), contacts masked for a
// member who may not see them. The stage fold mirrors loadPipeline's exactly,
// including the legacy lead_status fallback and its stagePairAt guard.
//
// Packaging only (WORKSPACE_FEATURES 'lost'), gated in the API route.

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { chunks } from './bulk'
import { memberSites, type Member } from './auth'
import {
  CRM_STAGE_ROLE, CRM_LOST_ROLE, CRM_CALL_ROLE, CRM_WA_OUT_ROLE, CRM_EMAIL_ROLE,
  parseCrmStage, stageFromLeadStatus, type CrmStage,
} from './crm'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import { ASSIGNMENT_ROLE } from './assignment'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { asUtcIso, CONTACT_ROLE, parseContact } from './visitor'
import { notALeadSessions } from './notalead'
import { canSeeAllLeads, visibleToMember } from './teamlead'
import { isOwnLeadsOnly, ownedSessions } from './ownleads'
import { leadSource } from './quoteintake'
import type { LeadKind } from './leadrecord'
import { orderDetails, parseCrmLost, type LostReason } from './lostreasons'
import { canSeeContacts, scrubText } from './pii'

export interface LostRow {
  id: string
  mergedIds: string[]
  name: string
  siteId: string
  siteName: string
  kind: LeadKind
  owner: string | null
  createdAt: string | null
  /** When it moved to Lost (newest crm_stage → lost row); null when the only
   *  record of it is a legacy lead_status row. */
  lostAt: string | null
  lostBy: string | null
  reason: LostReason | null
  reasonNote: string
  product: string
  size: string
  quantity: string
  /** Our last outreach: a chat reply, email, WhatsApp or call. */
  lastContactAt: string | null
}

export interface LostFilters {
  siteId?: string
  owner?: string
  /** a reason key, or 'none' for leads without one */
  reason?: string
  /** lead created within this many days (the board's window), default 365 */
  days?: number
  /** lost within N days ('7' | '30' | '90') or longer ago ('older') */
  age?: string
}

export interface LostResult {
  rows: LostRow[]
  total: number
  /** before the reason/age filters — what the filter chips count against */
  reasonCounts: Record<string, number>
  options: { sites: { siteId: string; name: string }[]; owners: string[] }
  truncated: boolean
}

const STAGE_ROW_CAP = 60000
const ROW_CAP = 20000
const AGE_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 }

type Row = { session_id: string; site_id: string; role: string; message: string; created_at: string }

export async function loadLost(member: Member, filters: LostFilters): Promise<LostResult> {
  const days = Math.min(3650, Math.max(1, Math.round(filters.days ?? 365)))
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const empty: LostResult = { rows: [], total: 0, reasonCounts: {}, options: { sites: [], owners: [] }, truncated: false }
  const allowed = memberSites(member)
  if (allowed.length === 0) return empty
  // A site filter can only ever NARROW the member's scope, never widen it.
  const sites = filters.siteId && allowed.includes(filters.siteId) ? [filters.siteId] : allowed
  let truncated = false

  // ── 1. which sessions are Lost right now ──────────────────────────────────
  // Stage rows are always written at or after the lead's creation, so the
  // board's window is safe here too.
  const [stageRows, excluded, siteRes] = await Promise.all([
    fetchAllPages<Row>(
      () => supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
        .in('role', [CRM_STAGE_ROLE, LEAD_STATUS_ROLE]).in('site_id', sites)
        .gte('created_at', since).order('created_at', { ascending: true }).order('id', { ascending: true }),
      STAGE_ROW_CAP),
    notALeadSessions(sites),
    supabase.from('sites').select('site_id, name'),
  ])
  if (warnIfCapped('lost stage rows', stageRows.length, STAGE_ROW_CAP)) truncated = true
  const siteName: Record<string, string> = {}
  for (const x of siteRes.data ?? []) siteName[x.site_id] = x.name

  const stagePairAt = new Set<string>()
  for (const r of stageRows) if (r.role === CRM_STAGE_ROLE) stagePairAt.add(`${r.session_id}|${r.created_at}`)
  const stage = new Map<string, CrmStage>()
  const lostAt = new Map<string, { at: string; by: string }>()
  for (const r of stageRows) {
    if (r.role === CRM_STAGE_ROLE) {
      const st = parseCrmStage(r.message)
      if (!st) continue
      stage.set(r.session_id, st.stage)
      if (st.stage === 'lost') lostAt.set(r.session_id, { at: asUtcIso(r.created_at) ?? r.created_at, by: st.changed_by })
    } else {
      if (stagePairAt.has(`${r.session_id}|${r.created_at}`)) continue
      const mapped = stageFromLeadStatus(parseLeadStatus(r.message)?.status)
      if (mapped) stage.set(r.session_id, mapped)
    }
  }
  const lostIds = [...stage].filter(([id, st]) => st === 'lost' && !excluded.has(id)).map(([id]) => id)
  if (lostIds.length === 0) return empty

  // ── 2. everything else, for just those leads ──────────────────────────────
  interface Lead {
    id: string; siteId: string; kind: LeadKind; name: string; email: string | null; createdAt: string | null
    message: string; owner: string | null; reason: { reason: LostReason; note: string; at: string } | null; touch: string | null
  }
  const leads = new Map<string, Lead>()
  const blank = (id: string, siteId: string, kind: LeadKind, createdAt: string | null): Lead => ({
    id, siteId, kind, name: '', email: null, createdAt, message: '', owner: null, reason: null, touch: null,
  })
  const quoteIds = lostIds.filter((id) => id.startsWith('quote-'))
  const chatIds = lostIds.filter((id) => !id.startsWith('quote-'))

  await Promise.all([
    ...chunks(quoteIds, 200).map(async (chunk) => {
      const { data, error } = await supabase.from('leads')
        .select('id, site_id, name, email, phone, message, created_at')
        .in('id', chunk.map((id) => id.slice('quote-'.length)))
      if (error) throw new Error(error.message)
      for (const l of data ?? []) {
        const id = `quote-${l.id}`
        const lead = blank(id, l.site_id, leadSource(l.message), asUtcIso(l.created_at))
        lead.name = (l.name || l.email || l.phone || '').trim()
        lead.email = l.email
        lead.message = l.message ?? ''
        leads.set(id, lead)
      }
    }),
    ...chunks(chatIds, 200).map(async (chunk) => {
      const { data, error } = await supabase.from('chat_logs')
        .select('session_id, site_id, message, created_at')
        .in('session_id', chunk).eq('role', LEAD_CAPTURE_ROLE).order('created_at', { ascending: true })
      if (error) throw new Error(error.message)
      for (const r of data ?? []) {
        const c = parseLeadCapture(r.message)
        const lead = blank(r.session_id, r.site_id, 'chat', asUtcIso(c?.at || r.created_at))
        lead.name = (c?.name || c?.email || c?.phone || '').trim()
        lead.email = c?.email ?? null
        leads.set(r.session_id, lead) // ascending → the newest capture wins
      }
    }),
  ])

  // The board's window is on the LEAD's creation, not on when it was lost.
  for (const [id, l] of leads) if (l.createdAt && l.createdAt < since) leads.delete(id)
  const ids = [...leads.keys()]

  await Promise.all(chunks(ids, 200).map(async (chunk) => {
    const [ctrl, touches] = await Promise.all([
      fetchAllPages<Row>(
        () => supabase.from('chat_logs').select('session_id, site_id, role, message, created_at')
          .in('session_id', chunk).in('role', [ASSIGNMENT_ROLE, CONTACT_ROLE, CRM_LOST_ROLE])
          .order('created_at', { ascending: true }).order('id', { ascending: true }),
        ROW_CAP),
      // Outreach timestamps only — no bodies (an email row carries the whole
      // mail). Newest first, so a cap could only ever cost the OLDEST touches.
      fetchAllPages<{ session_id: string; created_at: string }>(
        () => supabase.from('chat_logs').select('session_id, created_at')
          .in('session_id', chunk).in('role', ['admin', CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE])
          .order('created_at', { ascending: false }),
        ROW_CAP),
    ])
    if (warnIfCapped('lost control rows', ctrl.length, ROW_CAP)) truncated = true
    warnIfCapped('lost outreach rows', touches.length, ROW_CAP)
    for (const r of ctrl) {
      const l = leads.get(r.session_id)
      if (!l) continue
      if (r.role === ASSIGNMENT_ROLE) l.owner = (r.message ?? '').trim().toLowerCase() || null
      else if (r.role === CONTACT_ROLE) {
        const c = parseContact(r.message)
        if (!l.name && (c.name || c.email)) l.name = (c.name || c.email).trim()
        if (!l.email && c.email) l.email = c.email
      } else {
        const x = parseCrmLost(r.message)
        if (x) l.reason = { reason: x.reason, note: x.note, at: asUtcIso(r.created_at) ?? r.created_at }
      }
    }
    for (const r of touches) {
      const l = leads.get(r.session_id)
      const at = asUtcIso(r.created_at)
      if (l && at && (!l.touch || at > l.touch)) l.touch = at
    }
  }))

  // ── 3. whose are they ─────────────────────────────────────────────────────
  let visible = [...leads.values()]
  const seesAll = await canSeeAllLeads(member)
  if (!seesAll) visible = visible.filter((l) => visibleToMember(l.owner, member.email, false, isOwnLeadsOnly(member)))
  if (isOwnLeadsOnly(member)) {
    const mine = await ownedSessions(member)
    visible = visible.filter((l) => mine.has(l.id))
  }

  // ── 4. one customer, one row (the board's rule: site + email) ─────────────
  const groups = new Map<string, Lead[]>()
  const loose: Lead[][] = []
  for (const l of visible) {
    const email = (l.email ?? '').trim().toLowerCase()
    if (!email || l.kind === 'reorder') { loose.push([l]); continue }
    const key = `${l.siteId}|${email}`
    groups.set(key, [...(groups.get(key) ?? []), l])
  }

  const hide = !canSeeContacts(member)
  const safe = (t: string) => (hide ? (scrubText(t) ?? '') : t)

  const all: LostRow[] = [...groups.values(), ...loose].map((g) => {
    // The row opens the most recently lost record; the others ride along so
    // Recover moves every Lost record of this customer together.
    const lostOf = (l: Lead) => lostAt.get(l.id)?.at ?? ''
    g.sort((a, b) => lostOf(b).localeCompare(lostOf(a)) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    const head = g[0]
    const lost = lostAt.get(head.id) ?? null
    // A reason counts only if it was given for THIS time it was lost.
    const floor = lost ? Date.parse(lost.at) - 5 * 60_000 : 0
    const why = g.map((l) => l.reason).filter((r): r is NonNullable<Lead['reason']> => !!r && Date.parse(r.at) >= floor)
      .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
    const touch = g.map((l) => l.touch).filter((t): t is string => !!t).sort().pop() ?? null
    const d = g.map((l) => orderDetails(l.message)).find((x) => x.product || x.size || x.quantity) ?? { product: '', size: '', quantity: '' }
    const rawName = g.map((l) => l.name).find(Boolean) || g.map((l) => l.email).find(Boolean) || 'Unnamed lead'
    const name = hide && (/@/.test(rawName) || /\d{7,}/.test(rawName)) ? (scrubText(rawName) || 'Unnamed lead') : rawName
    return {
      id: head.id, mergedIds: g.map((l) => l.id), name, siteId: head.siteId, siteName: siteName[head.siteId] ?? head.siteId,
      kind: g.find((l) => l.kind !== 'chat')?.kind ?? head.kind,
      owner: g.map((l) => l.owner).find(Boolean) ?? null,
      createdAt: g.map((l) => l.createdAt).filter((t): t is string => !!t).sort()[0] ?? null,
      lostAt: lost?.at ?? null, lostBy: lost?.by || null,
      reason: why?.reason ?? null, reasonNote: safe(why?.note ?? ''),
      product: safe(d.product), size: safe(d.size), quantity: safe(d.quantity),
      lastContactAt: touch,
    }
  })

  // ── 5. filters ────────────────────────────────────────────────────────────
  let scoped = all
  if (filters.owner) {
    scoped = filters.owner === '__unassigned__' ? scoped.filter((r) => !r.owner) : scoped.filter((r) => r.owner === filters.owner!.toLowerCase())
  }
  const reasonCounts: Record<string, number> = {}
  for (const r of scoped) { const k = r.reason ?? 'none'; reasonCounts[k] = (reasonCounts[k] ?? 0) + 1 }

  let rows = scoped
  if (filters.reason) rows = rows.filter((r) => (r.reason ?? 'none') === filters.reason)
  if (filters.age) {
    const now = Date.now()
    const ageOf = (r: LostRow) => now - Date.parse(r.lostAt ?? r.createdAt ?? '')
    rows = filters.age === 'older'
      ? rows.filter((r) => !(ageOf(r) <= 90 * 86_400_000))
      : AGE_DAYS[filters.age] ? rows.filter((r) => ageOf(r) <= AGE_DAYS[filters.age as string] * 86_400_000) : rows
  }
  // Newest lost first; a lead lost only in the legacy status (no stage row)
  // sorts by its creation.
  rows.sort((a, b) => (b.lostAt ?? b.createdAt ?? '').localeCompare(a.lostAt ?? a.createdAt ?? ''))

  const owners = [...new Set(all.map((r) => r.owner).filter((o): o is string => !!o))].sort()
  const siteOptions = [...new Map(all.map((r) => [r.siteId, { siteId: r.siteId, name: r.siteName }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
  return { rows, total: rows.length, reasonCounts, options: { sites: siteOptions, owners }, truncated }
}
