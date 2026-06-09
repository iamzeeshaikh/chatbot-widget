import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function GET() {
  // Visitors active within last 2 minutes
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()

  const [visitorsRes, sitesRes] = await Promise.all([
    supabase
      .from('active_visitors')
      .select('*')
      .eq('status', 'active')
      .gt('last_seen', cutoff)
      .order('last_seen', { ascending: false }),
    supabase.from('sites').select('site_id, name, primary_color'),
  ])

  const visitors = visitorsRes.data ?? []
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
