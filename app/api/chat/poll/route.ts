import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMode } from '@/lib/mode'
import { typingActive, AGENT_TYPING_KEY } from '@/lib/typing'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from '@/lib/replyauthor'
import { agentDisplayName } from '@/lib/agentname'
import { storedMemberNames } from '@/lib/membername'

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

  const [mode, visRes, logsRes] = await Promise.all([
    getMode(sessionId),
    supabase.from('active_visitors').select('page_url').eq('session_id', sessionId).maybeSingle(),
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

  const rawMessages = logsRes.data ?? []

  // WHO the visitor is talking to. An `admin` row is written by a person, and
  // the `reply_author` row written alongside it carries their email at the SAME
  // created_at — that pairing is how the dashboard attributes replies, and it is
  // reused here rather than invented. Bot answers are not `admin` rows at all,
  // so they never pick up a name.
  const authorByAt = new Map<string, string>()
  if (rawMessages.length > 0) {
    // A name an admin chose on the Members page wins over the one derived from
    // the address — that is the whole reason the field exists.
    const chosen = await storedMemberNames()
    const { data: authors } = await supabase
      .from('chat_logs')
      .select('message, created_at')
      .eq('session_id', sessionId)
      .eq('role', REPLY_AUTHOR_ROLE)
      .gte('created_at', rawMessages[0].created_at)
    for (const row of authors ?? []) {
      const a = parseReplyAuthor(row.message)
      if (a?.email) {
        authorByAt.set(row.created_at, chosen.get(a.email.toLowerCase()) || agentDisplayName(a.email))
      }
    }
  }

  const messages = rawMessages.map((m) => ({ ...m, author: authorByAt.get(m.created_at) ?? null }))
  // The name to put on the header while a person is handling this chat — the
  // most recent one to answer.
  const agentName = messages.length > 0
    ? [...messages].reverse().find((m) => m.author)?.author ?? null
    : null
  // Typing indicator: an agent stamped 'aty' within the freshness window.
  const agentTyping = typingActive(visRes.data?.page_url ?? null, AGENT_TYPING_KEY)

  return NextResponse.json({ messages, mode, agentTyping, agentName }, { headers: corsHeaders })
}
