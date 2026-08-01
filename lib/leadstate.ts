// The authoritative current stage + owner for a set of leads.
//
// Lives here rather than in a route because three callers need the same answer:
// the bulk endpoint's "before" (for the timeline's `previous` and for Undo) and
// search's result enrichment. A second copy would be a second chance to get the
// legacy fallback below wrong.
//
// Deliberately mirrors loadPipeline's fold rather than just reading the newest
// crm_stage row: a lead moved before the CRM existed has only a legacy
// lead_status row, and the pipeline shows it as (say) Contacted. Reading
// crm_stage alone would call that lead "new", which would write a false
// `previous` into the timeline and make Undo restore a stage it was never in.
// The stagePairAt guard is the same one loadPipeline uses to ignore the mirror
// row written alongside a real stage change.

import { supabase } from './supabase'
import { chunks } from './bulk'
import { CRM_STAGE_ROLE, isCrmStage, parseCrmStage, stageFromLeadStatus, type CrmStage } from './crm'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import { ASSIGNMENT_ROLE } from './assignment'

export interface LeadState { stage: CrmStage; owner: string | null }

export async function currentStateForIds(ids: string[]): Promise<Map<string, LeadState>> {
  const out = new Map<string, { stage: CrmStage; owner: string | null }>()
  for (const id of ids) out.set(id, { stage: 'new', owner: null })

  for (const chunk of chunks(ids, 200)) {
    const { data } = await supabase
      .from('chat_logs')
      .select('session_id, role, message, created_at')
      .in('session_id', chunk)
      .in('role', [CRM_STAGE_ROLE, LEAD_STATUS_ROLE, ASSIGNMENT_ROLE])
      .order('created_at', { ascending: true })

    const rows = data ?? []
    const stagePairAt = new Set<string>()
    for (const r of rows) if (r.role === CRM_STAGE_ROLE) stagePairAt.add(`${r.session_id}|${r.created_at}`)

    // Ascending, so the last row per session wins — the same fold the pipeline
    // and the conversations list use.
    for (const r of rows) {
      const cur = out.get(r.session_id)
      if (!cur) continue
      if (r.role === CRM_STAGE_ROLE) {
        const s = parseCrmStage(r.message)
        if (s && isCrmStage(s.stage)) cur.stage = s.stage
      } else if (r.role === LEAD_STATUS_ROLE) {
        if (stagePairAt.has(`${r.session_id}|${r.created_at}`)) continue
        const mapped = stageFromLeadStatus(parseLeadStatus(r.message)?.status)
        if (mapped) cur.stage = mapped
      } else {
        const email = (r.message ?? '').trim()
        cur.owner = email || null
      }
    }
  }
  return out
}
