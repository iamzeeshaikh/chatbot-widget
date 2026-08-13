import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { CRM_EMAIL_READ_ROLE } from '@/lib/emailreply'

export const dynamic = 'force-dynamic'

// Mark a captured reply as read.
//
// Append-only like everything else: a crm_email_read row per gmailId, so "who
// saw this and when" is part of the audit trail rather than a flag being
// flipped. Re-marking is harmless.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const ids: string[] = Array.isArray(body.gmailIds)
    ? body.gmailIds.filter((v: unknown) => typeof v === 'string' && v).slice(0, 100)
    : []
  if (ids.length === 0) return NextResponse.json({ error: 'Nothing to mark' }, { status: 400 })

  const at = new Date().toISOString()
  for (const gmailId of ids) {
    await writeControlRow({
      sessionId: id, siteId: access.siteId, role: CRM_EMAIL_READ_ROLE, at,
      message: JSON.stringify({ gmailId, by: access.member.email, at }),
    })
  }
  return NextResponse.json({ ok: true, marked: ids.length })
}
