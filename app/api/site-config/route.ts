import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { siteWorkspace, isWidgetBlocked } from '@/lib/workspaces'
import { clientIp, lookupCountry } from '@/lib/geo'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function GET(req: NextRequest) {
  const siteId = req.nextUrl.searchParams.get('siteId')

  if (!siteId) {
    return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: corsHeaders })
  }

  const { data, error } = await supabase
    .from('sites')
    .select('site_id, name, bot_name, primary_color')
    .eq('site_id', siteId)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: corsHeaders })
  }

  // Geo-gate: hide the widget for blocked South Asian countries on packaging
  // sites only. The lookup is skipped entirely for sports sites (no latency hit),
  // and any geo failure leaves `blocked` false so we never block on uncertainty.
  let blocked = false
  if (siteWorkspace(siteId) === 'packaging') {
    const { code } = await lookupCountry(clientIp(req.headers))
    blocked = isWidgetBlocked(siteId, code)
  }

  return NextResponse.json({ ...data, blocked }, { headers: corsHeaders })
}
