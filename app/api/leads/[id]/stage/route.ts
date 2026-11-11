import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { isCrmStage } from '@/lib/crm'
import { applyStageChange } from '@/lib/stagechange'
import { LOST_REASON_REQUIRED, lostReasonRequired, readLostInput, writeLostReason } from '@/lib/lostwrite'

export const dynamic = 'force-dynamic'

// Move one lead through the pipeline.
//
// The write itself lives in lib/stagechange.ts, which /api/pipeline/bulk also
// calls — that is what keeps the two-row write (crm_stage plus the legacy
// lead_status mirror, sharing one created_at) identical whether one lead moves
// or four hundred do.
//
// A packaging lead moved to Lost must say why (2026-11-11): { lostReason,
// lostNote? } is required and written here, in the same request, as a
// crm_lost row + CRM note (lib/lostwrite.ts). Checked BEFORE anything is
// written, so a refused move writes nothing. Bots that move stages call
// applyStageChange directly and never reach this.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const { stage, previous } = body ?? {}
  if (!isCrmStage(stage)) return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })
  const needsReason = stage === 'lost' && lostReasonRequired(access.member.workspace)
  const lost = needsReason ? readLostInput(body) : null
  if (needsReason && !lost) return NextResponse.json({ error: LOST_REASON_REQUIRED }, { status: 400 })

  const res = await applyStageChange({
    leadId: id, siteId: access.siteId, stage, previous, actorEmail: access.member.email,
  })
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })

  if (lost) {
    const w = await writeLostReason({
      leadId: id, siteId: access.siteId, reason: lost.reason, note: lost.note, by: access.member.email, at: res.at,
    })
    // The move landed; say the reason did not, rather than calling it failed.
    if (w.error) return NextResponse.json({ ok: true, at: res.at, reasonFailed: w.error })
  }

  return NextResponse.json({ ok: true, at: res.at })
}
