import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { canSeeContacts } from '@/lib/pii'
import { CRM_FIELD_ROLE, isCrmField } from '@/lib/crm'

export const dynamic = 'force-dynamic'

// Override an auto-captured contact field (name / email / phone). The captured
// value is never overwritten — this is a newer control row that wins on read,
// so the original capture stays intact for billing and for the timeline.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { field, value } = await req.json().catch(() => ({}))
  if (!isCrmField(field)) return NextResponse.json({ error: 'Unknown field' }, { status: 400 })
  // A value you are not allowed to READ is one you must not be able to
  // overwrite: an agent could otherwise replace the customer's address with
  // their own and have the CRM send them the correspondence. The UI already
  // renders these read-only; this is the half that actually holds.
  if ((field === 'email' || field === 'phone') && !canSeeContacts(access.member)) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }
  const clean = typeof value === 'string' ? value.trim().slice(0, 200) : ''

  const at = new Date().toISOString()
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_FIELD_ROLE,
    message: JSON.stringify({ field, value: clean, updated_by: access.member.email, at }),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, field, value: clean, at })
}
