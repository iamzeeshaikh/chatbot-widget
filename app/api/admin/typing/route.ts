import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { stampTyping, AGENT_TYPING_KEY } from '@/lib/typing'

// Dashboard → "an agent is typing". Throttled client-side (one ping / 3s).
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { sessionId } = await req.json()
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  await stampTyping(String(sessionId), AGENT_TYPING_KEY)
  return NextResponse.json({ ok: true })
}
