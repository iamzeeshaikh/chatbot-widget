import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { unpackVisitor, asUtcIso } from '@/lib/visitor'
import { findBurstKeys, burstKey } from '@/lib/botfilter'

export const dynamic = 'force-dynamic'

// Zendesk-style visitor history: every widget session of the last HISTORY_DAYS
// (live AND departed), newest first, workspace-scoped. Bot bursts are excluded
// with the same heuristic as the analytics chart, and each visitor carries a
// has_chat flag (did this session ever send a visitor message?) so the
// dashboard can jump straight to the conversation.
const HISTORY_DAYS = 7
const MAX_VISITOR_ROWS = 10000
const MAX_CHAT_ROWS = 20000

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ visitors: [] }, { status: 401 })
  const scope = siteScope(member)
  const allowed = Array.from(scope)
  if (allowed.length === 0) return NextResponse.json({ visitors: [] })

  const startISO = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const [visRows, chatRows, sitesRes] = await Promise.all([
    fetchAllPages<{
      session_id: string; site_id: string; page_url: string | null; user_agent: string | null
      device_type: string | null; browser: string | null; os: string | null
      country: string | null; city: string | null; status: string
      created_at: string; last_seen: string
    }>(
      () => supabase.from('active_visitors').select('*').in('site_id', allowed)
        .gte('created_at', startISO).order('created_at', { ascending: false }),
      MAX_VISITOR_ROWS),
    fetchAllPages<{ session_id: string }>(
      () => supabase.from('chat_logs').select('session_id').in('site_id', allowed)
        .in('role', ['user', 'visitor']).gte('created_at', startISO)
        .order('created_at', { ascending: false }),
      MAX_CHAT_ROWS),
    supabase.from('sites').select('site_id, name, primary_color'),
  ])

  const stamped = visRows.map((v) => ({ v, ms: new Date(asUtcIso(v.created_at) ?? v.created_at).getTime() }))
  const bursts = findBurstKeys(stamped.map((s) => ({ userAgent: s.v.user_agent, tsMs: s.ms })))
  const chatted = new Set(chatRows.map((r) => r.session_id))
  const sites = sitesRes.data ?? []

  // Rows are newest-first; keep the first (most recent) row per session.
  const seen = new Set<string>()
  const visitors = []
  for (const { v, ms } of stamped) {
    if (bursts.has(burstKey(v.user_agent, ms))) continue
    if (seen.has(v.session_id)) continue
    seen.add(v.session_id)
    const site = sites.find((s) => s.site_id === v.site_id)
    const { page_url, page_title, referrer, visits } = unpackVisitor(v.page_url)
    visitors.push({
      ...v,
      created_at: asUtcIso(v.created_at),
      last_seen: asUtcIso(v.last_seen),
      page_url, page_title, referrer, visits,
      site_name: site?.name ?? v.site_id,
      primary_color: site?.primary_color ?? '#2563eb',
      has_chat: chatted.has(v.session_id),
    })
  }

  return NextResponse.json({ visitors })
}
