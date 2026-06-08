import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const { sessionId, siteId, message } = await req.json()
  if (!sessionId || !siteId || !message?.trim()) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  const [logRes, modeRes] = await Promise.all([
    supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: 'admin',
      message: message.trim(),
    }),
    supabase.from('conversation_mode').upsert({
      session_id: sessionId,
      mode: 'human',
      pending_reply: message.trim(),
      updated_at: new Date().toISOString(),
    }),
  ])

  if (logRes.error) return NextResponse.json({ error: logRes.error.message }, { status: 500 })
  if (modeRes.error) return NextResponse.json({ error: modeRes.error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
