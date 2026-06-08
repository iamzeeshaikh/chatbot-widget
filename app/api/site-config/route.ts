import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

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
    return NextResponse.json({ error: 'Site not found', debug: error?.message, code: error?.code }, { status: 404, headers: corsHeaders })
  }

  return NextResponse.json(data, { headers: corsHeaders })
}
