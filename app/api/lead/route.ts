import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function POST(req: NextRequest) {
  try {
    const { siteId, name, email, phone, message } = await req.json()

    if (!siteId) {
      return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: corsHeaders })
    }

    const { error } = await supabase.from('leads').insert([{ site_id: siteId, name, email, phone, message }])

    if (error) {
      console.error('Lead insert error:', error)
      return NextResponse.json({ error: 'Failed to save lead' }, { status: 500, headers: corsHeaders })
    }

    return NextResponse.json({ success: true }, { headers: corsHeaders })
  } catch (err) {
    console.error('Lead error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
