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

import { supabase, fetchAllPagesSerial, warnIfCapped } from './supabase'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from './crm'
import { isBotWaRow } from './whatsapp'

/** Session ids, within `siteIds`, whose newest WhatsApp message is the
 *  customer's. `only` narrows the answer to sessions the caller cares about. */
export async function waWaitingSessions(siteIds: string[], only?: Set<string>): Promise<Set<string>> {
  const waiting = new Set<string>()
  if (siteIds.length === 0) return waiting
  // Read in pages. This asked for 5,000 rows, but the database returns 1,000
  // at most — and oldest-first, so once packaging passed 1,000 WhatsApp rows
  // (13 Nov 2026) the newest messages were never read: a customer who wrote
  // today showed no badge and rang no bell, and one answered since still did.
  const WA_ROW_CAP = 50000
  const data = await fetchAllPagesSerial<{ session_id: string; role: string; message: string; created_at: string }>(() => supabase
    .from('chat_logs')
    .select('session_id, role, message, created_at')
    .in('site_id', siteIds)
    .in('role', [CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE])
    // Ascending, so the LAST row seen for a session is the newest one — the
    // fold below depends on that order and silently inverts without it.
    .order('created_at', { ascending: true }).order('id', { ascending: true }), WA_ROW_CAP)
  warnIfCapped('whatsapp waiting', data.length, WA_ROW_CAP)
  for (const r of data) {
    if (only && !only.has(r.session_id)) continue
    if (r.role === CRM_WA_IN_ROLE) waiting.add(r.session_id)
    // The WhatsApp assistant's reply leaves the customer waiting on a PERSON.
    else if (!isBotWaRow(r.message)) waiting.delete(r.session_id)
  }
  return waiting
}
