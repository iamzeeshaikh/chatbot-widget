// A TEAM LEAD: sees every lead in the workspace, without being an admin.
//
// WHY NOT JUST MAKE THEM AN ADMIN: admin here means members, passwords,
// billing and the blocklist. A team lead needs none of that — they need to see
// the whole board so nothing sits unworked. Handing over password control to
// grant visibility is the kind of over-permission nobody revisits.
//
// WHY NOT A NEW `role` VALUE: `members.role` is a database column and there is
// no DDL access (CLAUDE.md §3), so a third value cannot be added to whatever
// constraint guards it. This is a control row instead — the same pattern
// reminders and signatures use — on the reserved `zeeops-crm` site, where it
// cannot reach a conversation list.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'
import type { Member } from './auth'

export const CRM_TEAM_LEAD_ROLE = 'crm_team_lead'
export const TEAM_LEAD_SESSION = 'zeeops-crm-team-leads'

/** Every email currently marked a team lead. Newest row per email wins, so
 *  removing somebody is another row rather than a delete. */
export async function teamLeads(): Promise<Set<string>> {
  const { data } = await supabase.from('chat_logs')
    .select('message, created_at')
    .eq('site_id', REMINDER_SITE).eq('session_id', TEAM_LEAD_SESSION).eq('role', CRM_TEAM_LEAD_ROLE)
    .order('created_at', { ascending: true }).limit(500)
  const out = new Set<string>()
  for (const r of data ?? []) {
    try {
      const o = JSON.parse(r.message ?? '')
      const email = String(o?.email ?? '').trim().toLowerCase()
      if (!email) continue
      if (o?.lead === false) out.delete(email)
      else out.add(email)
    } catch { /* malformed row — ignore */ }
  }
  return out
}

export async function setTeamLead(email: string, lead: boolean, by: string): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE, session_id: TEAM_LEAD_SESSION, role: CRM_TEAM_LEAD_ROLE,
    message: JSON.stringify({ email: email.trim().toLowerCase(), lead, by, at: new Date().toISOString() }),
  })
}

/**
 * May this member see leads that are not theirs?
 *
 * Admins and team leads: yes. Everyone else sees their OWN leads plus the
 * UNASSIGNED pool — and the unassigned half is not a nicety. Most leads arrive
 * with no owner, so "only what is assigned to me" would hide almost everything
 * from almost everyone and new work would sit unseen until a lead handed it
 * out one at a time.
 */
export async function canSeeAllLeads(member: Member): Promise<boolean> {
  if (member.role === 'admin') return true
  return (await teamLeads()).has(member.email.trim().toLowerCase())
}

/** The filter itself, so every list applies the same rule. */
export function visibleToMember(
  assignee: string | null | undefined, memberEmail: string, seesAll: boolean,
): boolean {
  if (seesAll) return true
  const owner = (assignee ?? '').trim().toLowerCase()
  return !owner || owner === memberEmail.trim().toLowerCase()
}
