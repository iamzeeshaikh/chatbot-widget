import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'
import { getMode, setMode } from '@/lib/mode'

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, siteId, message } = await req.json()
  if (!sessionId || !siteId || !message?.trim()) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  }
  if (!canAccessSite(member, siteId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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

  // Ensure conversation stays in human mode (only write a control row if it
  // isn't already human, to avoid piling up rows).
  if ((await getMode(sessionId)) !== 'human') {
    await setMode(sessionId, siteId, 'human')
  }

  return NextResponse.json({ success: true })
}
