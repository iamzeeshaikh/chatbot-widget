import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { unpackVisitor, LIVE_MAX_ON_SITE_MS, asUtcIso } from '@/lib/visitor'
import { filterLiveFlood } from '@/lib/botfilter'

export const dynamic = 'force-dynamic'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ visitors: [] }, { status: 401, headers: corsHeaders })
  const scope = await siteScope(member)

  // "Live" = active within the last 60s. The widget pings every 30s, so 60s
  // tolerates one missed ping without flicker.
  const cutoff = new Date(Date.now() - 60 * 1000).toISOString()
  // A genuinely live session is RECENT. Any row whose session started more than
  // this ago is a stale/carried-over session (e.g. an old tab left open since
  // yesterday still pinging the same sessionId) — never show it as "live", no
  // matter how fresh last_seen is. This is what caps "on site" and stops an
  // "active now" row from opening yesterday's conversation.
  const maxOnSiteStart = new Date(Date.now() - LIVE_MAX_ON_SITE_MS).toISOString()

  const [visitorsRes, sitesRes] = await Promise.all([
    supabase
      .from('active_visitors')
      .select('*')
      .eq('status', 'active')
      .gt('last_seen', cutoff)
      .gt('created_at', maxOnSiteStart)
      .order('last_seen', { ascending: false }),
    supabase.from('sites').select('site_id, name, primary_color'),
  ])

  // Dedupe by session_id (keep the most recent row) so a session can never
  // appear twice, even if stale duplicate rows exist. Rows are already ordered
  // by last_seen desc, so the first occurrence wins.
  const seen = new Set<string>()
  const visitors = (visitorsRes.data ?? []).filter((v) => {
    if (!scope || scope.has(v.site_id)) {
      if (seen.has(v.session_id)) return false
      seen.add(v.session_id)
      return true
    }
    return false
  })
  const sites = sitesRes.data ?? []

  // Redundant client-independent guard: even if a stale row sneaks past the SQL
  // filter, drop anything whose session is older than the on-site cap.
  const liveStart = Date.now() - LIVE_MAX_ON_SITE_MS

  // Bot-flood guard: when many "visitors" with the exact same user-agent are
  // live at once (an automated burst), hide the whole group — otherwise the
  // dashboard shows hundreds of fake visitors and rings nonstop for them.
  const enriched = filterLiveFlood(visitors)
    .filter((v) => {
      const created = asUtcIso(v.created_at)
      return created ? new Date(created).getTime() >= liveStart : true
    })
    .map((v) => {
      const site = sites.find((s) => s.site_id === v.site_id)
      const { page_url, page_title, referrer, visits } = unpackVisitor(v.page_url)
      return {
        ...v,
        // Normalise naive-UTC timestamps so the dashboard computes correct ages.
        created_at: asUtcIso(v.created_at),
        last_seen: asUtcIso(v.last_seen),
        page_url,
        page_title,
        referrer,
        visits,
        site_name: site?.name ?? v.site_id,
        primary_color: site?.primary_color ?? '#2563eb',
      }
    })

  return NextResponse.json({ visitors: enriched }, { headers: corsHeaders })
}
