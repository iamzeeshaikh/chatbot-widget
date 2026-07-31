import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { CRM_STAGE_ROLE, isCrmStage, leadStatusForStage } from '@/lib/crm'
import { LEAD_STATUS_ROLE } from '@/lib/leadstatus'

export const dynamic = 'force-dynamic'

// Move a lead through the pipeline. Writes TWO rows with an identical
// created_at: the crm_stage row (the real, 7-stage state) and the legacy
// lead_status row the Billing tab reads, so the two views can never disagree.
// The shared timestamp is what lets the record page show them as one event
// instead of two (see lib/leadrecord.ts).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { stage, previous } = await req.json().catch(() => ({}))
  if (!isCrmStage(stage)) return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })

  const at = new Date().toISOString()
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_STAGE_ROLE, at,
    message: JSON.stringify({
      stage,
      previous: isCrmStage(previous) ? previous : null,
      changed_by: access.member.email,
      at,
    }),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })

  // Billing mirror. Best-effort: the stage itself is already saved, and a
  // failure here must not make the UI roll back a change that did land.
  await writeControlRow({
    sessionId: id, siteId: access.siteId, role: LEAD_STATUS_ROLE, at,
    message: JSON.stringify({ status: leadStatusForStage(stage), by: access.member.email, at }),
  })

  return NextResponse.json({ ok: true, at })
}
