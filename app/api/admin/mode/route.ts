import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSession, siteOfSession } from '@/lib/auth'
import { getMode, setMode } from '@/lib/mode'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  return NextResponse.json({ mode: await getMode(sessionId) })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, mode } = await req.json()
  if (!sessionId || !['bot', 'human'].includes(mode)) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }
  if (!(await canAccessSession(member, sessionId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const siteId = await siteOfSession(sessionId)
  if (!siteId) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  await setMode(sessionId, siteId, mode)
  return NextResponse.json({ success: true })
}
