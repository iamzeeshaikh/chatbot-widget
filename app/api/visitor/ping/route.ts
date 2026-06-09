import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function POST(req: NextRequest) {
  try {
    const { sessionId, siteId, pageUrl, userAgent, status } = await req.json()
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders })

    if (status === 'left') {
      await supabase
        .from('active_visitors')
        .update({ status: 'left', last_seen: new Date().toISOString() })
        .eq('session_id', sessionId)
    } else {
      await supabase.from('active_visitors').upsert({
        session_id: sessionId,
        site_id: siteId,
        page_url: pageUrl ?? null,
        user_agent: userAgent ?? null,
        status: 'active',
        last_seen: new Date().toISOString(),
      })
    }

    return NextResponse.json({ ok: true }, { headers: corsHeaders })
  } catch (err) {
    console.error('Visitor ping error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
