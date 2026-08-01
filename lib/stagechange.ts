// The ONE place a lead's stage is written.
//
// Extracted so the bulk endpoint cannot drift from the single-lead one. Both
// /api/leads/[id]/stage and /api/pipeline/bulk call applyStageChange, so the
// legacy lead_status dual-write and its shared created_at are guaranteed
// identical whether one lead moves or four hundred do. Changing how a stage is
// recorded means changing this function and nothing else.

import { writeControlRow } from './leadrecord'
import { CRM_STAGE_ROLE, isCrmStage, leadStatusForStage, type CrmStage } from './crm'
import { LEAD_STATUS_ROLE } from './leadstatus'

export interface StageWriteResult {
  ok: boolean
  /** The timestamp BOTH rows were written at. */
  at: string
  error?: string
  /** True when the crm_stage row landed but its billing mirror did not. */
  mirrorFailed?: boolean
}

// Writes TWO rows with an identical created_at: the crm_stage row (the real,
// 7-stage state) and the legacy lead_status row the Billing tab reads, so the
// two views can never disagree. The shared timestamp is what lets the record
// page fold them into one timeline event instead of showing two.
//
// The mirror is best-effort ON PURPOSE: the stage itself is already saved, and
// a failure there must not make the caller report a change that did land as
// failed. It is surfaced as `mirrorFailed` rather than swallowed.
export async function applyStageChange(opts: {
  leadId: string
  siteId: string
  stage: CrmStage
  previous: unknown
  actorEmail: string
  /** Supplied by bulk so every lead in one action shares a timestamp. */
  at?: string
}): Promise<StageWriteResult> {
  const at = opts.at ?? new Date().toISOString()

  const { error } = await writeControlRow({
    sessionId: opts.leadId, siteId: opts.siteId, role: CRM_STAGE_ROLE, at,
    message: JSON.stringify({
      stage: opts.stage,
      previous: isCrmStage(opts.previous) ? opts.previous : null,
      changed_by: opts.actorEmail,
      at,
    }),
  })
  if (error) return { ok: false, at, error }

  const mirror = await writeControlRow({
    sessionId: opts.leadId, siteId: opts.siteId, role: LEAD_STATUS_ROLE, at,
    message: JSON.stringify({ status: leadStatusForStage(opts.stage), by: opts.actorEmail, at }),
  })

  return { ok: true, at, mirrorFailed: !!mirror.error }
}
