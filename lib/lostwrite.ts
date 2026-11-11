// Writing WHY a lead was lost — the one helper every human "move to Lost" path
// shares (server only).
//
// Since 2026-11-11 the reason is REQUIRED for a packaging lead (owner: 269 Lost
// leads, none with a reason, because asking after the move let it be skipped).
// /api/leads/[id]/stage and /api/pipeline/bulk refuse a move to Lost without one
// and write it in the same request; /api/lost/reason still sets it afterwards
// for the old reason-less leads. All three write the same two rows through here:
// a `crm_lost` row (what /lost reads) and a "Lost reason: …" CRM note (the
// timeline).
//
// applyStageChange (lib/stagechange.ts) is deliberately NOT changed: the bots
// and syncs that call it never move a lead to Lost, and its contract stays the
// plain stage write.

import { supabase } from './supabase'
import { writeControlRow } from './leadrecord'
import { hasFeature, type Workspace } from './workspaces'
import { CRM_LOST_ROLE, CRM_NOTE_ROLE, type CrmNoteEntry } from './crm'
import {
  isLostReason, lostReasonLabel, parseCrmLost, MAX_LOST_NOTE,
  type CrmLostEntry, type LostReason,
} from './lostreasons'

export const LOST_REASON_REQUIRED = 'Pick why this lead was lost.'

/** Does a move to Lost in this workspace need a reason? (packaging: yes) */
export function lostReasonRequired(workspace: Workspace | string | null | undefined): boolean {
  return !!workspace && hasFeature(workspace as Workspace, 'lost')
}

/** The reason + note off a request body ({ lostReason, lostNote }), or null. */
export function readLostInput(body: { lostReason?: unknown; lostNote?: unknown } | null | undefined):
  { reason: LostReason; note: string } | null {
  if (!body || !isLostReason(body.lostReason)) return null
  const note = typeof body.lostNote === 'string' ? body.lostNote.trim().slice(0, MAX_LOST_NOTE) : ''
  return { reason: body.lostReason, note }
}

/** crm_lost row + CRM note. The crm_lost row is the one that matters; a failed
 *  note is not reported as a failed reason. */
export async function writeLostReason(opts: {
  leadId: string; siteId: string; reason: LostReason; note: string; by: string; at?: string
}): Promise<{ error: string | null }> {
  const at = opts.at ?? new Date().toISOString()
  const entry: CrmLostEntry = { reason: opts.reason, note: opts.note, by: opts.by, at }
  const { error } = await writeControlRow({
    sessionId: opts.leadId, siteId: opts.siteId, role: CRM_LOST_ROLE, at, message: JSON.stringify(entry),
  })
  if (error) return { error }
  const n: CrmNoteEntry = {
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    body: `Lost reason: ${lostReasonLabel(opts.reason)}${opts.note ? ` — ${opts.note}` : ''}`,
    author: opts.by, at,
  }
  await writeControlRow({ sessionId: opts.leadId, siteId: opts.siteId, role: CRM_NOTE_ROLE, at, message: JSON.stringify(n) })
  return { error: null }
}

/**
 * Undo of a bulk move OUT of Lost puts the lead back into Lost. The reason it
 * had is still the right one, but /lost only counts a reason written at/after
 * the newest move to Lost — so copy the newest crm_lost row forward to `at`
 * (no second note: the timeline already says why). Best effort.
 */
export async function carryLostReasonForward(leadId: string, siteId: string, at: string): Promise<void> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', leadId).eq('role', CRM_LOST_ROLE)
    .order('created_at', { ascending: false }).limit(1)
  const prev = parseCrmLost(data?.[0]?.message)
  if (!prev) return
  await writeControlRow({
    sessionId: leadId, siteId, role: CRM_LOST_ROLE, at,
    message: JSON.stringify({ ...prev, at } satisfies CrmLostEntry),
  })
}
