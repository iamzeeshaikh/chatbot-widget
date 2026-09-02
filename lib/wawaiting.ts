// "A customer wrote on WhatsApp and nobody has answered."
//
// The rule is the one the record and the leads table already use: the LAST
// WhatsApp row on a lead decides. Inbound last → waiting. It needs no
// read-marking and clears itself the moment an agent replies, from any device.
//
// It lives here because it now has TWO callers that must never disagree — the
// leads table, which shows the badge, and the dashboard's badge poll, which
// RINGS. A count that drifts from the badge would have the bell go off for a
// lead that shows nothing, which is worse than no bell at all.

import { supabase } from './supabase'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from './crm'

/** Session ids, within `siteIds`, whose newest WhatsApp message is the
 *  customer's. `only` narrows the answer to sessions the caller cares about. */
export async function waWaitingSessions(siteIds: string[], only?: Set<string>): Promise<Set<string>> {
  const waiting = new Set<string>()
  if (siteIds.length === 0) return waiting
  const { data } = await supabase
    .from('chat_logs')
    .select('session_id, role, created_at')
    .in('site_id', siteIds)
    .in('role', [CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE])
    // Ascending, so the LAST row seen for a session is the newest one — the
    // fold below depends on that order and silently inverts without it.
    .order('created_at', { ascending: true })
    .limit(5000)
  for (const r of data ?? []) {
    if (only && !only.has(r.session_id)) continue
    if (r.role === CRM_WA_IN_ROLE) waiting.add(r.session_id)
    else waiting.delete(r.session_id)
  }
  return waiting
}
