import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { CRM_NOT_A_LEAD_ROLE } from '@/lib/crm'

export const dynamic = 'force-dynamic'

// Mark a lead as "not a lead" — or take the mark back off.
//
// Never a delete. The row stays readable, the decision is attributed, and the
// counts subtract it. Any member who can open the lead can mark it: the people
// who spot a supplier pitch are the ones working the list, and the mark is
// reversible by anyone who disagrees.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const spam = body.spam !== false          // default: mark it
  const reason = String(body.reason ?? '').slice(0, 200)

  const { error } = await writeControlRow({
    sessionId: id,
    siteId: access.siteId,
    role: CRM_NOT_A_LEAD_ROLE,
    message: JSON.stringify({ spam, by: access.member.email, at: new Date().toISOString(), reason: reason || undefined }),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, spam })
}
