// "This isn't a lead."
//
// No pattern catches everything. A supplier pitching their factory, a student
// doing research, a duplicate somebody forwarded by hand — they arrive through
// the same form real customers use, and the ones the intake filter misses land
// in the table and inflate every count the business is judged on.
//
// So the owner can mark one. It is a CONTROL ROW, not a delete:
//   • a wrong call is undone by marking it back, and nothing was destroyed;
//   • the row is still there to read, which is how you find out the filter has
//     a hole;
//   • the audit trail keeps who decided and when.
//
// Marked leads are subtracted wherever leads are COUNTED — the Overview tiles,
// the site cards, Billing and the month-end report — and the counts say how
// many were excluded rather than quietly returning a smaller number.

import { supabase } from './supabase'
import { CRM_NOT_A_LEAD_ROLE } from './crm'
import { quoteSessionId } from './quoteintake'

export interface NotALeadMark { spam: boolean; by: string; at: string; reason?: string }

export function parseNotALead(message: string | null | undefined): NotALeadMark | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.spam !== 'boolean') return null
    return {
      spam: o.spam,
      by: typeof o.by === 'string' ? o.by : '',
      at: typeof o.at === 'string' ? o.at : '',
      reason: typeof o.reason === 'string' ? o.reason : undefined,
    }
  } catch { return null }
}

/**
 * Every session currently marked "not a lead" for these sites.
 *
 * Append-only, so the NEWEST row per session wins — that is what makes
 * un-marking work without deleting anything. Rows are read oldest-first and
 * overwritten as the loop walks forward, the same fold the rest of the CRM uses.
 */
export async function notALeadSessions(siteIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (siteIds.length === 0) return out
  const { data } = await supabase
    .from('chat_logs')
    .select('session_id, message')
    .in('site_id', siteIds)
    .eq('role', CRM_NOT_A_LEAD_ROLE)
    .order('created_at', { ascending: true })
  for (const r of data ?? []) {
    const m = parseNotALead(r.message)
    if (!m) continue
    if (m.spam) out.add(r.session_id)
    else out.delete(r.session_id)
  }
  return out
}

/** The session id a lead row is counted under. Quote/checkout leads have no
 *  chat, so they use the synthetic `quote-<id>` id the rest of the CRM uses. */
export function sessionForLead(lead: { id: string; session_id?: string | null }): string {
  return lead.session_id || quoteSessionId(lead.id)
}
