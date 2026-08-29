import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSession } from '@/lib/auth'
import { canSeeContacts, scrubText } from '@/lib/pii'
import { asUtcIso } from '@/lib/visitor'
import { VISIBLE_CONTROL_ROLES_IN } from '@/lib/controlroles'
import { readTyping, VISITOR_TYPING_KEY } from '@/lib/typing'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from '@/lib/replyauthor'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ messages: [] }, { status: 401 })

  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (!(await canAccessSession(member, sessionId))) {
    return NextResponse.json({ messages: [] }, { status: 403 })
  }

  const [{ data, error }, authorRes, visitorTyping] = await Promise.all([
    supabase
      .from('chat_logs')
      .select('*')
      .eq('session_id', sessionId)
      .not('role', 'in', `(${VISIBLE_CONTROL_ROLES_IN})`) // hide control rows except lead_capture, which renders as a marker
      .order('created_at', { ascending: true }),
    // Reply-author companion rows: each pairs to its admin reply by an identical
    // created_at (see lib/replyauthor.ts), letting us label a reply with the name
    // of the agent who actually sent it instead of a generic "Agent".
    supabase
      .from('chat_logs')
      .select('created_at, message')
      .eq('session_id', sessionId)
      .eq('role', REPLY_AUTHOR_ROLE),
    readTyping(sessionId, VISITOR_TYPING_KEY),
  ])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Map raw (un-normalised) created_at → author email. Must key off the RAW
  // timestamp, before asUtcIso rewrites it, so it matches the reply row exactly.
  const authorByAt: Record<string, string> = {}
  for (const r of authorRes.data ?? []) {
    const a = parseReplyAuthor(r.message)
    if (a?.email) authorByAt[r.created_at] = a.email
  }

  // Normalise naive-UTC timestamps so bubble times / date separators render in
  // the correct timezone (a bare timestamp was misread as local, skewing hours).
  // A transcript is whatever the visitor typed, and visitors type their own
  // address and number into chat all the time — so for a member who may not see
  // contacts the message text is scrubbed, not just the lead's fields.
  const hide = !canSeeContacts(member)
  const messages = (data ?? []).map((m) => ({
    ...m,
    message: hide ? scrubText(m.message) : m.message,
    author: m.role === 'admin' ? (authorByAt[m.created_at] ?? null) : null,
    created_at: asUtcIso(m.created_at),
  }))
  return NextResponse.json({ messages, visitorTyping })
}
