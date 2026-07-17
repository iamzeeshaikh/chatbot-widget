import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, LEAD_TRACKED_SITES } from '@/lib/leadtracking'
import { LEAD_STATUS_ROLE, parseLeadStatus, type LeadStatus } from '@/lib/leadstatus'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from '@/lib/replyauthor'
import { unpackVisitor } from '@/lib/visitor'
import { QUOTE_TAG, stripQuoteTag, quoteSessionId } from '@/lib/quoteintake'

export const dynamic = 'force-dynamic'

// Billing report: captured leads for a date range, scoped to the member's sites
// (so it's workspace-isolated and respects assigned-site access). Reads the
// no-DDL lead_capture control rows from chat_logs.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const scope = siteScope(member)

  const fromParam = req.nextUrl.searchParams.get('from')
  const toParam = req.nextUrl.searchParams.get('to')
  // Default window: the current calendar month in Pakistan time (the client
  // always passes explicit from/to, so this only matters as a defensive
  // fallback — but it must agree with PKT, not the server's own UTC clock).
  const nowPkt = new Date(Date.now() + 5 * 60 * 60 * 1000)
  const y = nowPkt.getUTCFullYear(), m = nowPkt.getUTCMonth()
  const pad = (n: number) => String(n).padStart(2, '0')
  const from = fromParam || new Date(`${y}-${pad(m + 1)}-01T00:00:00+05:00`).toISOString()
  const to = toParam || new Date(`${m === 11 ? y + 1 : y}-${pad(m === 11 ? 1 : m + 2)}-01T00:00:00+05:00`).toISOString()

  const [rowsRes, quoteRowsRes, sitesRes] = await Promise.all([
    supabase
      .from('chat_logs')
      .select('session_id, site_id, message, created_at')
      .eq('role', LEAD_CAPTURE_ROLE)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: false }),
    // Custom-quote leads (WordPress form emails, ingested via the Google Apps
    // Script → /api/quote-intake — see lib/quoteintake.ts). Same `leads`
    // table the bot's own qualification writes to, told apart by the message
    // prefix since there's no separate table/column for it.
    supabase
      .from('leads')
      .select('id, site_id, name, email, phone, message, created_at')
      .ilike('message', `${QUOTE_TAG}%`)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: false }),
    supabase.from('sites').select('site_id, name'),
  ])

  const siteName: Record<string, string> = {}
  for (const s of sitesRes.data ?? []) siteName[s.site_id] = s.name

  // Only sites the member can access (workspace + assigned-site isolation).
  const rows = (rowsRes.data ?? []).filter((r) => scope.has(r.site_id))
  const quoteRows = (quoteRowsRes.data ?? []).filter((r) => scope.has(r.site_id))

  // Enrichment for the period's lead sessions (queried by session id, NOT the
  // date window — a status can be set long after the lead was captured):
  //   status   — latest lead_status control row per session
  //   agent    — the member with the most attributed replies in the session
  //   origin   — country + referrer from the visitor row (where the lead came from)
  // ['-'] placeholder keeps .in() valid when the period has no leads. Quote
  // leads' synthetic session ids are included so a lead_status row set on one
  // (via the same /api/admin/lead-status endpoint chat leads use) is picked up
  // below — author/origin lookups simply find nothing for them, which is
  // correct: a quote lead has no chat session or agent reply attached.
  const quoteSessionIds = quoteRows.map((r) => quoteSessionId(r.id))
  const sessionIds = (rows.length || quoteRows.length)
    ? Array.from(new Set([...rows.map((r) => r.session_id), ...quoteSessionIds])) : ['-']
  const prevFrom = new Date(new Date(from).getTime() - (new Date(to).getTime() - new Date(from).getTime())).toISOString()
  const [statusRes, authorRes, visRes, prevRes, prevQuoteRes] = await Promise.all([
    supabase.from('chat_logs').select('session_id, message, created_at')
      .eq('role', LEAD_STATUS_ROLE).in('session_id', sessionIds)
      .order('created_at', { ascending: true }),
    supabase.from('chat_logs').select('session_id, message')
      .eq('role', REPLY_AUTHOR_ROLE).in('session_id', sessionIds),
    supabase.from('active_visitors').select('session_id, country, page_url')
      .in('session_id', sessionIds),
    // Previous period's lead count, for the month-over-month comparison.
    supabase.from('chat_logs').select('session_id, site_id')
      .eq('role', LEAD_CAPTURE_ROLE).gte('created_at', prevFrom).lt('created_at', from),
    supabase.from('leads').select('site_id')
      .ilike('message', `${QUOTE_TAG}%`).gte('created_at', prevFrom).lt('created_at', from),
  ])

  const statusBySession = new Map<string, LeadStatus>()
  for (const r of statusRes?.data ?? []) {
    const s = parseLeadStatus(r.message)
    if (s) statusBySession.set(r.session_id, s.status) // ascending → last wins
  }
  // Agent = most replies in the session (ties go to the later replier).
  const agentBySession = new Map<string, string>()
  {
    const counts = new Map<string, Map<string, number>>()
    for (const r of authorRes?.data ?? []) {
      const a = parseReplyAuthor(r.message)
      if (!a?.email) continue
      let m = counts.get(r.session_id)
      if (!m) { m = new Map(); counts.set(r.session_id, m) }
      m.set(a.email, (m.get(a.email) ?? 0) + 1)
    }
    for (const [sid, m] of counts) {
      let best = ''; let bestN = -1
      for (const [email, n] of m) if (n >= bestN) { best = email; bestN = n }
      agentBySession.set(sid, best)
    }
  }
  const originBySession = new Map<string, { country: string | null; referrer: string | null }>()
  for (const v of visRes?.data ?? []) {
    const { referrer } = unpackVisitor(v.page_url)
    originBySession.set(v.session_id, { country: v.country ?? null, referrer })
  }
  const prevChatTotal = (prevRes?.data ?? []).filter((r) => scope.has(r.site_id)).length
  const prevQuoteTotal = (prevQuoteRes?.data ?? []).filter((r) => scope.has(r.site_id)).length
  const prevTotal = prevChatTotal + prevQuoteTotal

  const chatLeads = rows.map((r) => {
    const lead = parseLeadCapture(r.message)
    const origin = originBySession.get(r.session_id)
    return {
      session_id: r.session_id,
      site_id: r.site_id,
      site_name: siteName[r.site_id] ?? r.site_id,
      email: lead?.email ?? '',
      name: lead?.name ?? null,
      phone: lead?.phone ?? null,
      // The capture timestamp; fall back to the row time for very old rows.
      captured_at: lead?.at || r.created_at,
      status: statusBySession.get(r.session_id) ?? ('new' as LeadStatus),
      agent: agentBySession.get(r.session_id) ?? null,
      country: origin?.country ?? null,
      referrer: origin?.referrer ?? null,
      source: 'chat' as const,
    }
  }).filter((l) => l.email)

  // Custom-quote leads (WordPress form → Gmail → Apps Script → /api/quote-intake).
  // No chat session, so no agent/country/referrer — but status still works via
  // the same synthetic-session lead_status mechanism as chat leads.
  const quoteLeads = quoteRows.map((r) => {
    const sid = quoteSessionId(r.id)
    return {
      session_id: sid,
      site_id: r.site_id,
      site_name: siteName[r.site_id] ?? r.site_id,
      email: r.email ?? '',
      name: r.name ?? null,
      phone: r.phone ?? null,
      captured_at: r.created_at,
      status: statusBySession.get(sid) ?? ('new' as LeadStatus),
      agent: null as string | null,
      country: null as string | null,
      referrer: null as string | null,
      source: 'quote' as const,
      quote_message: stripQuoteTag(r.message),
    }
  }).filter((l) => l.email)

  const leads = [...chatLeads, ...quoteLeads]
    .sort((a, b) => new Date(b.captured_at).getTime() - new Date(a.captured_at).getTime())

  // Billable count: the same customer sometimes contacts through both the
  // chat widget AND a quote-request email (e.g. fills the form, then also
  // chats minutes later) — that's one customer, and should be charged for
  // once. This dedupes by site + email (case-insensitive) across BOTH
  // sources without touching the Chat/Quote counts shown elsewhere, which
  // stay as raw per-channel totals on purpose.
  const billableKeys = new Set(leads.filter((l) => l.email).map((l) => `${l.site_id}::${l.email.toLowerCase()}`))
  const billable = billableKeys.size

  // Per-site breakdown.
  const bySiteMap: Record<string, number> = {}
  for (const l of leads) bySiteMap[l.site_id] = (bySiteMap[l.site_id] ?? 0) + 1
  const bySite = Object.entries(bySiteMap)
    .map(([site_id, count]) => ({ site_id, site_name: siteName[site_id] ?? site_id, count }))
    .sort((a, b) => b.count - a.count)

  // Tracked sites within the member's scope, for context in the UI.
  const trackedInScope = LEAD_TRACKED_SITES
    .filter((id) => scope.has(id))
    .map((id) => ({ site_id: id, site_name: siteName[id] ?? id }))

  // Pipeline breakdown for the summary chips.
  const byStatus: Record<string, number> = {}
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1

  return NextResponse.json({ from, to, total: leads.length, billable, prevTotal, byStatus, leads, bySite, trackedInScope })
}
