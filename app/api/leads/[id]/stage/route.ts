import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { isCrmStage } from '@/lib/crm'
import { applyStageChange } from '@/lib/stagechange'

export const dynamic = 'force-dynamic'

// Move one lead through the pipeline.
//
// The write itself lives in lib/stagechange.ts, which /api/pipeline/bulk also
// calls — that is what keeps the two-row write (crm_stage plus the legacy
// lead_status mirror, sharing one created_at) identical whether one lead moves
// or four hundred do.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { stage, previous } = await req.json().catch(() => ({}))
  if (!isCrmStage(stage)) return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })

  const res = await applyStageChange({
    leadId: id, siteId: access.siteId, stage, previous, actorEmail: access.member.email,
  })
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })

  return NextResponse.json({ ok: true, at: res.at })
}
