import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, LEAD_TRACKED_SITES } from '@/lib/leadtracking'

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
  // Default window: the current calendar month.
  const now = new Date()
  const from = fromParam || new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const to = toParam || new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

  const [rowsRes, sitesRes] = await Promise.all([
    supabase
      .from('chat_logs')
      .select('session_id, site_id, message, created_at')
      .eq('role', LEAD_CAPTURE_ROLE)
      .gte('created_at', from)
      .lt('created_at', to)
      .order('created_at', { ascending: false }),
    supabase.from('sites').select('site_id, name'),
  ])

  const siteName: Record<string, string> = {}
  for (const s of sitesRes.data ?? []) siteName[s.site_id] = s.name

  // Only sites the member can access (workspace + assigned-site isolation).
  const rows = (rowsRes.data ?? []).filter((r) => scope.has(r.site_id))

  const leads = rows.map((r) => {
    const lead = parseLeadCapture(r.message)
    return {
      session_id: r.session_id,
      site_id: r.site_id,
      site_name: siteName[r.site_id] ?? r.site_id,
      email: lead?.email ?? '',
      name: lead?.name ?? null,
      phone: lead?.phone ?? null,
      // The capture timestamp; fall back to the row time for very old rows.
      captured_at: lead?.at || r.created_at,
    }
  }).filter((l) => l.email)

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

  return NextResponse.json({ from, to, total: leads.length, leads, bySite, trackedInScope })
}
