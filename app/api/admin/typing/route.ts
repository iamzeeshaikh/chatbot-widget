import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSession } from '@/lib/auth'
import { stampTyping, AGENT_TYPING_KEY } from '@/lib/typing'

// Dashboard → "an agent is typing". Throttled client-side (one ping / 3s).
//
// The session is access-checked like every other conversation endpoint. It used
// to take any session id from any signed-in member, which made this the one
// write that reached across a workspace boundary — harmless in effect (a typing
// dot) but the check costs one indexed lookup and the rule in CLAUDE.md §3 has
// no exception for cheap writes.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { sessionId } = await req.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (!(await canAccessSession(member, String(sessionId)))) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }
  await stampTyping(String(sessionId), AGENT_TYPING_KEY)
  return NextResponse.json({ ok: true })
}
