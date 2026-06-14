import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'

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

  const [visitorsRes, sitesRes] = await Promise.all([
    supabase
      .from('active_visitors')
      .select('*')
      .eq('status', 'active')
      .gt('last_seen', cutoff)
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

  const enriched = visitors.map((v) => {
    const site = sites.find((s) => s.site_id === v.site_id)
    return {
      ...v,
      site_name: site?.name ?? v.site_id,
      primary_color: site?.primary_color ?? '#2563eb',
    }
  })

  return NextResponse.json({ visitors: enriched }, { headers: corsHeaders })
}
