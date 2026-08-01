import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { disconnect } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

// Forget this agent's Gmail credential. Append-only like every control row: a
// revoked marker is written rather than the old row being deleted, so the audit
// trail of who connected what and when survives.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  await disconnect(member.email)
  return NextResponse.json({ ok: true })
}
