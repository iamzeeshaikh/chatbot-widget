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
  const { searchParams } = req.nextUrl
  const sessionId = searchParams.get('sessionId')
  const siteId = searchParams.get('siteId')
  const since = searchParams.get('since') // ISO timestamp of last seen message

  if (!sessionId || !siteId) {
    return NextResponse.json({ error: 'Missing params' }, { status: 400, headers: corsHeaders })
  }

  const [modeRes, logsRes] = await Promise.all([
    supabase.from('conversation_mode').select('mode').eq('session_id', sessionId).single(),
    since
      ? supabase
          .from('chat_logs')
          .select('id, role, message, created_at')
          .eq('session_id', sessionId)
          .eq('role', 'admin')
          .gt('created_at', since)
          .order('created_at', { ascending: true })
      : supabase
          .from('chat_logs')
          .select('id, role, message, created_at')
          .eq('session_id', sessionId)
          .eq('role', 'admin')
          .order('created_at', { ascending: true })
          .limit(0), // no since = return nothing (widget sets since on open)
  ])

  const mode = modeRes.data?.mode ?? 'bot'
  const messages = logsRes.data ?? []

  return NextResponse.json({ messages, mode }, { headers: corsHeaders })
}
