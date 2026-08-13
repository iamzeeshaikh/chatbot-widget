import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { loadLeadRecord, guardLeadAccess } from '@/lib/leadrecord'

export const dynamic = 'force-dynamic'

// The full lead record for /leads/[id]. Access is decided here, on the server —
// a member without access to the lead's site gets 403 whether they clicked a
// link or typed the id.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) {
    return NextResponse.json(
      { error: access.status === 401 ? 'Unauthorized' : access.status === 403 ? 'Forbidden' : 'Not found' },
      { status: access.status },
    )
  }

  const record = await loadLeadRecord(access.member, id)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ record })
}
