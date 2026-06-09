import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function POST(req: NextRequest) {
  const { sessionId, siteId, message } = await req.json()
  if (!sessionId || !siteId || !message?.trim()) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }

  // Save admin reply to chat_logs — delivery detection uses timestamp comparison,
  // no pending_reply column needed
  const { error: logError } = await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: 'admin',
    message: message.trim(),
  })

  if (logError) return NextResponse.json({ error: logError.message }, { status: 500 })

  // Ensure conversation stays in human mode
  await supabase.from('conversation_mode').upsert({
    session_id: sessionId,
    mode: 'human',
    updated_at: new Date().toISOString(),
  })

  return NextResponse.json({ success: true })
}
