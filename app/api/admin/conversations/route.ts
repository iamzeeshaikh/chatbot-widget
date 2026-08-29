import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages, warnIfCapped } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { canSeeContacts, maskEmail, scrubText } from '@/lib/pii'
import type { Workspace } from '@/lib/workspaces'
import { deriveModes, MODE_ROLE } from '@/lib/mode'
import { deriveAssignments, ASSIGNMENT_ROLE } from '@/lib/assignment'
import { CONTACT_ROLE, TAGS_ROLE, parseTags, parseContact, asUtcIso } from '@/lib/visitor'
import { parseAttachment } from '@/lib/attachment'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, extractEmail } from '@/lib/leadtracking'
import { isControlRole } from '@/lib/controlroles'
import { CRM_ROLES } from '@/lib/crm'
import { isBotEnabledForWorkspace } from '@/lib/botflag'

export const dynamic = 'force-dynamic'

// This endpoint is polled continuously by every agent, so it must stay cheap.
// Older conversations remain available in the Visitors/history views.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

interface SessionSummary {
  session_id: string
  site_id: string
  preview: string
  last_at: string
  message_count: number
  last_role: string
  mode: string
  lead: { name: string | null; email: string | null } | null
  site_name: string
  tags: string[]
  assignedTo: string | null
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ sessions: [] }, { status: 401 })
  const scope = await siteScope(member)
  const SINCE = new Date(Date.now() - WINDOW_MS).toISOString()

  // FAST PATH: a Postgres function aggregates each session's message summary in
  // the DB (one row per session instead of thousands of raw message rows). If
  // the function isn't installed yet, rpc returns an error and we fall back to
  // the legacy full-row scan below — so nothing breaks before the SQL is run.
  // .order + implicit 1000-row cap → the 1000 most-recently-active sessions,
  // which is what the live dashboard needs (older ones live in Visitors/history).
  const summaryRes = await supabase.rpc('session_message_summaries', { since: SINCE })
    .order('last_at', { ascending: false })
  // Both paths go out through the same masking, so a fallback to the legacy
  // scan cannot quietly serve what the fast path hides. The preview is the last
  // thing said in the chat — often the visitor's own address — and the lead
  // badge carries the address outright.
  const hide = !canSeeContacts(member)
  const out = <T extends { sessions: { preview: string; lead: { name: string | null; email: string | null } | null }[] }>(r: T): T => {
    if (!hide) return r
    for (const s of r.sessions) {
      s.preview = scrubText(s.preview) ?? ''
      if (s.lead) s.lead.email = maskEmail(s.lead.email)
    }
    return r
  }

  if (!summaryRes.error && Array.isArray(summaryRes.data)) {
    return NextResponse.json(out(await fastPath(summaryRes.data, scope, SINCE, member.workspace)))
  }
  console.warn('[conversations] session_message_summaries RPC unavailable, using legacy scan:', summaryRes.error?.message)
  return NextResponse.json(out(await legacyPath(scope, SINCE, member.workspace)))
}

// ── Control-row guard for the DB-side summary ────────────────────────────────
// session_message_summaries() filters control rows with its own hardcoded
// DENYLIST inside Postgres, which cannot know about roles added later (verified:
// an unrecognised role comes back as the session's preview/last_role/last_at —
// i.e. raw control JSON rendered as the last message, the exact bug that shipped
// once with reply_author). We have no DDL access to update that function, so the
// summaries are re-checked here against the single source of truth in
// lib/controlroles.ts, and any session it got wrong is re-derived from its real
// messages. A session left with no real messages is dropped, matching the
// legacy path (a session that only ever had control rows never shows up).
async function withoutControlRows<T extends { session_id: string; preview: string | null; last_at: string; last_role: string; message_count: number | string }>(
  summaries: T[],
  since: string,
): Promise<{ summaries: T[]; repaired: Set<string> }> {
  const dirty = summaries.filter((s) => isControlRole(s.last_role))
  if (dirty.length === 0) return { summaries, repaired: new Set() }

  const ids = dirty.map((s) => s.session_id)
  // Same window as the summary itself, so a CRM action on an old lead can't
  // drag its long-finished conversation back into the live list.
  const { data: rows } = await supabase
    .from('chat_logs')
    .select('session_id, role, message, created_at')
    .in('session_id', ids)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(4000)

  const fixed = new Map<string, { preview: string; last_at: string; last_role: string; message_count: number }>()
  for (const r of rows ?? []) {
    if (isControlRole(r.role) || r.message === '(session started)') continue
    const prev = fixed.get(r.session_id)
    const att = parseAttachment(r.message)
    fixed.set(r.session_id, {
      preview: att ? `📎 ${att.name}` : r.message,
      last_at: r.created_at,
      last_role: r.role,
      message_count: (prev?.message_count ?? 0) + 1,
    })
  }

  const out: T[] = []
  for (const s of summaries) {
    if (!isControlRole(s.last_role)) { out.push(s); continue }
    const repair = fixed.get(s.session_id)
    if (repair) out.push({ ...s, ...repair })
  }
  return { summaries: out, repaired: new Set(fixed.keys()) }
}

// ── The lead badge ───────────────────────────────────────────────────────────
// Leads are read here for ONE purpose: putting the lead badge on a conversation
// whose `lead_capture` control row didn't already flag it. The match is by
// site + lowercased email, so only three columns are ever touched.
//
// It used to be `.from('leads').select('*')` with no limit or pagination, which
// PostgREST silently truncates at 1000 rows. With 1,259 leads that returned the
// oldest 1000 and dropped everything from 2026-08-09 on — four days of leads
// showing no badge — and it shipped ~967KB on EVERY conversations poll (every
// 10s, per agent, against the Micro Postgres that has fallen over once).
// Selecting the three real columns takes the same data to ~86KB.
//
// Deliberately NOT windowed by date: a customer who became a lead in 2024 and
// chats again today must still show the badge.
const LEADS_ROW_CAP = 20000
type LeadBadgeRow = { site_id: string; name: string | null; email: string | null }

async function fetchLeadsForBadge(): Promise<LeadBadgeRow[]> {
  const rows = await fetchAllPages<LeadBadgeRow>(
    () => supabase.from('leads').select('site_id, name, email').order('created_at', { ascending: true }),
    LEADS_ROW_CAP)
  warnIfCapped('conversations: leads', rows.length, LEADS_ROW_CAP)
  return rows
}

// ── Fast path ────────────────────────────────────────────────────────────────
// Message summaries come pre-aggregated from the DB. We still fetch the (few)
// control rows — mode / assignment / tags / lead_capture / contact — and derive
// per-session state from them, exactly as the legacy path does.
async function fastPath(
  rawSummaries: { session_id: string; site_id: string; preview: string | null; last_at: string; last_role: string; message_count: number | string }[],
  scope: Set<string> | null,
  since: string,
  ws: Workspace,
) {
  const { summaries, repaired } = await withoutControlRows(rawSummaries, since)
  const [controls, leadsRes, sitesRes] = await Promise.all([
    fetchAllPages<{ session_id: string; site_id: string; role: string; message: string; created_at: string }>(
      () => supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .gte('created_at', since)
        // CRM_ROLES are here only to be SUBTRACTED from the message count
        // below: the DB summary counts them as messages (its denylist predates
        // them), so a lead with three notes would otherwise read as three extra
        // chat messages in the list.
        .in('role', [MODE_ROLE, ASSIGNMENT_ROLE, TAGS_ROLE, LEAD_CAPTURE_ROLE, CONTACT_ROLE, ...CRM_ROLES])
        .order('created_at', { ascending: true }),
      20000),
    fetchLeadsForBadge(),
    supabase.from('sites').select('site_id, name, bot_name, primary_color'),
  ])
  const leads = leadsRes
  const sites = sitesRes.data ?? []

  const sessionMap: Record<string, SessionSummary> = {}
  for (const s of summaries) {
    const site = sites.find((x) => x.site_id === s.site_id)
    const raw = s.preview ?? ''
    const att = parseAttachment(raw)
    sessionMap[s.session_id] = {
      session_id: s.session_id, site_id: s.site_id,
      preview: att ? `📎 ${att.name}` : raw,
      last_at: s.last_at, last_role: s.last_role,
      message_count: Number(s.message_count) || 0,
      mode: 'bot', lead: null, site_name: site?.name ?? s.site_id, tags: [], assignedTo: null,
    }
  }

  // Control rows (ascending → last of each type per session wins). Like the
  // legacy path, these only UPDATE sessions that have a message summary; they
  // never create new entries (a claimed-but-never-messaged session doesn't show,
  // matching prior behaviour). emailToSession is still recorded for every row so
  // the leads-table match below works even for sessions off this page.
  const emailToSession: Record<string, string> = {}
  const crmRoleSet: ReadonlySet<string> = new Set<string>(CRM_ROLES)
  for (const log of controls) {
    const e = sessionMap[log.session_id]
    if (crmRoleSet.has(log.role)) {
      // Sessions rebuilt by withoutControlRows already have an exact count.
      if (e && !repaired.has(log.session_id)) e.message_count = Math.max(0, e.message_count - 1)
      continue
    }
    if (log.role === MODE_ROLE) { if (e) e.mode = log.message === 'human' ? 'human' : 'bot'; continue }
    if (log.role === ASSIGNMENT_ROLE) { if (e) { const em = (log.message ?? '').trim(); e.assignedTo = em || null } continue }
    if (log.role === TAGS_ROLE) { if (e) e.tags = parseTags(log.message); continue }
    if (log.role === LEAD_CAPTURE_ROLE) {
      const cap = parseLeadCapture(log.message)
      if (cap) {
        if (e) e.lead = { name: cap.name, email: cap.email }
        if (cap.email) emailToSession[`${log.site_id}|${cap.email.toLowerCase()}`] = log.session_id
      }
      continue
    }
    if (log.role === CONTACT_ROLE) { const c = parseContact(log.message); if (c.email) emailToSession[`${log.site_id}|${c.email.toLowerCase()}`] = log.session_id; continue }
  }

  // Leads-table match by email+site (only when a lead_capture didn't already flag it).
  for (const l of leads) {
    if (!l.email) continue
    const sid = emailToSession[`${l.site_id}|${String(l.email).toLowerCase()}`]
    if (sid && sessionMap[sid] && !sessionMap[sid].lead) sessionMap[sid].lead = { name: l.name, email: l.email }
  }

  const sessions = Object.values(sessionMap)
    .filter((s) => !scope || scope.has(s.site_id))
    .map((s) => ({ ...s, last_at: asUtcIso(s.last_at) }))
    .sort((a, b) => new Date(b.last_at!).getTime() - new Date(a.last_at!).getTime())

  return { sessions, bot_enabled: isBotEnabledForWorkspace(ws) }
}

// ── Legacy path (fallback) ───────────────────────────────────────────────────
// The original full-row scan, kept verbatim so the dashboard keeps working
// before the aggregation function is installed.
async function legacyPath(scope: Set<string> | null, since: string, ws: Workspace) {
  const [logRows, leadsRes, sitesRes] = await Promise.all([
    fetchAllPages<{ session_id: string; site_id: string; role: string; message: string; created_at: string }>(
      () => supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false }),
      2500),
    fetchLeadsForBadge(),
    supabase.from('sites').select('site_id, name, bot_name, primary_color'),
  ])

  const logs = logRows.reverse()
  const leads = leadsRes
  const modes = deriveModes(logs)
  const assignments = deriveAssignments(logs)
  const sites = sitesRes.data ?? []

  const sessionMap: Record<string, SessionSummary> = {}
  const tagsBySession: Record<string, string[]> = {}
  const leadBySession: Record<string, { name: string | null; email: string | null }> = {}
  const emailToSession: Record<string, string> = {}

  for (const log of logs) {
    if (log.role === TAGS_ROLE) { tagsBySession[log.session_id] = parseTags(log.message); continue }
    if (log.role === LEAD_CAPTURE_ROLE) {
      const cap = parseLeadCapture(log.message)
      if (cap) {
        leadBySession[log.session_id] = { name: cap.name, email: cap.email }
        if (cap.email) emailToSession[`${log.site_id}|${cap.email.toLowerCase()}`] = log.session_id
      }
      continue
    }
    if (log.role === CONTACT_ROLE) {
      const c = parseContact(log.message)
      if (c.email) emailToSession[`${log.site_id}|${c.email.toLowerCase()}`] = log.session_id
      continue
    }
    if (isControlRole(log.role)) continue
    if (!sessionMap[log.session_id]) {
      const site = sites.find((s) => s.site_id === log.site_id)
      sessionMap[log.session_id] = { session_id: log.session_id, site_id: log.site_id, preview: '', last_at: log.created_at, message_count: 0, last_role: '', mode: 'bot', lead: null, site_name: site?.name ?? log.site_id, tags: [], assignedTo: null }
    }
    if (log.message === '(session started)') continue
    const att = parseAttachment(log.message)
    sessionMap[log.session_id].preview = att ? `📎 ${att.name}` : log.message
    sessionMap[log.session_id].last_at = log.created_at
    sessionMap[log.session_id].last_role = log.role
    sessionMap[log.session_id].message_count++
    if (log.role === 'user') {
      const e = extractEmail(log.message)
      if (e) emailToSession[`${log.site_id}|${e.toLowerCase()}`] = log.session_id
    }
  }

  for (const [sessionId, mode] of Object.entries(modes)) if (sessionMap[sessionId]) sessionMap[sessionId].mode = mode
  for (const [sessionId, tags] of Object.entries(tagsBySession)) if (sessionMap[sessionId]) sessionMap[sessionId].tags = tags
  for (const [sessionId, email] of Object.entries(assignments)) if (sessionMap[sessionId]) sessionMap[sessionId].assignedTo = email
  for (const [sessionId, lead] of Object.entries(leadBySession)) if (sessionMap[sessionId]) sessionMap[sessionId].lead = lead
  for (const l of leads) {
    if (!l.email) continue
    const sid = emailToSession[`${l.site_id}|${String(l.email).toLowerCase()}`]
    if (sid && sessionMap[sid] && !sessionMap[sid].lead) sessionMap[sid].lead = { name: l.name, email: l.email }
  }

  const sessions = Object.values(sessionMap)
    .filter((s) => !scope || scope.has(s.site_id))
    .map((s) => ({ ...s, last_at: asUtcIso(s.last_at) }))
    .sort((a, b) => new Date(b.last_at!).getTime() - new Date(a.last_at!).getTime())

  return { sessions, bot_enabled: isBotEnabledForWorkspace(ws) }
}
