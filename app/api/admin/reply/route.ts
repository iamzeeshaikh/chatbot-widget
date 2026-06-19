import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'
import { getMode, setMode } from '@/lib/mode'
import { recordReplyAuthor } from '@/lib/replyauthor'

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
  // no pending_reply column needed. We set created_at explicitly so the
  // companion reply-author row can share the exact same timestamp (no DDL).
  const at = new Date().toISOString()
  const { error: logError } = await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: 'admin',
    message: message.trim(),
    created_at: at,
  })

  if (logError) return NextResponse.json({ error: logError.message }, { status: 500 })

  // Attribute this reply to the member who sent it (powers the Performance
  // dashboard's per-agent stats). Non-blocking and never fatal to the reply.
  await recordReplyAuthor(sessionId, siteId, member, at)

  // Ensure conversation stays in human mode (only write a control row if it
  // isn't already human, to avoid piling up rows).
  if ((await getMode(sessionId)) !== 'human') {
    await setMode(sessionId, siteId, 'human')
  }

  return NextResponse.json({ success: true })
}
