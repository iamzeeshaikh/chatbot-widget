import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { CRM_FIELD_ROLE, isCrmField } from '@/lib/crm'

export const dynamic = 'force-dynamic'

// Override an auto-captured contact field (name / email / phone). The captured
// value is never overwritten — this is a newer control row that wins on read,
// so the original capture stays intact for billing and for the timeline.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { field, value } = await req.json().catch(() => ({}))
  if (!isCrmField(field)) return NextResponse.json({ error: 'Unknown field' }, { status: 400 })
  const clean = typeof value === 'string' ? value.trim().slice(0, 200) : ''

  const at = new Date().toISOString()
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_FIELD_ROLE,
    message: JSON.stringify({ field, value: clean, updated_by: access.member.email, at }),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, field, value: clean, at })
}
