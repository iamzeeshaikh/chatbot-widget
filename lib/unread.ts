// Leads waiting on a reply from this member.
//
// "Unread" means a captured customer reply with no crm_email_read row against
// its Gmail id. Scoped to the member's sites, and to leads they OWN — an
// unassigned lead's reply is surfaced to whoever it landed with, which is what
// the notification does; the badge is about your own queue, not the team's.
//
// Deliberately one bounded query set, folded in Node: it rides on the 60s nav
// poll that already exists for the task badge, so it adds no new polling.

import { supabase } from './supabase'
import { memberSites, type Member } from './auth'
import { CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, parseCrmEmailIn, parseCrmEmailRead } from './emailreply'
import { ASSIGNMENT_ROLE } from './assignment'

/** How far back an unanswered reply still counts as needing attention. */
export const UNREAD_WINDOW_DAYS = 30

export interface UnreadLead {
  leadId: string
  siteId: string
  count: number
  from: string
  snippet: string
  at: string
}

export async function unreadRepliesFor(member: Member, now = new Date()): Promise<UnreadLead[]> {
  const sites = memberSites(member)
  if (sites.length === 0) return []
  const since = new Date(now.getTime() - UNREAD_WINDOW_DAYS * 86_400_000).toISOString()

  const { data } = await supabase
    .from('chat_logs')
    .select('session_id, site_id, role, message, created_at')
    .in('site_id', sites)
    .in('role', [CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, ASSIGNMENT_ROLE])
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(4000)

  const inbound = new Map<string, Map<string, { from: string; snippet: string; at: string }>>()
  const read = new Set<string>()
  const owner = new Map<string, string | null>()

  for (const r of data ?? []) {
    if (r.role === CRM_EMAIL_IN_ROLE) {
      const e = parseCrmEmailIn(r.message)
      if (!e) continue
      if (!inbound.has(r.session_id)) inbound.set(r.session_id, new Map())
      inbound.get(r.session_id)!.set(e.gmailId, {
        from: e.fromName || e.from, snippet: e.snippet || e.subject, at: e.at || r.created_at,
      })
    } else if (r.role === CRM_EMAIL_READ_ROLE) {
      const e = parseCrmEmailRead(r.message)
      if (e) read.add(e.gmailId)
    } else {
      // Ascending, so the last assignment row per session wins.
      const email = (r.message ?? '').trim()
      owner.set(r.session_id, email || null)
    }
  }

  const me = member.email.trim().toLowerCase()
  const out: UnreadLead[] = []
  for (const [leadId, msgs] of inbound) {
    if ((owner.get(leadId) ?? '').toLowerCase() !== me) continue
    let newest: { from: string; snippet: string; at: string } | null = null
    let count = 0
    for (const [gmailId, m] of msgs) {
      if (read.has(gmailId)) continue
      count++
      if (!newest || m.at > newest.at) newest = m
    }
    if (count === 0 || !newest) continue
    const site = (data ?? []).find((r) => r.session_id === leadId)?.site_id ?? ''
    out.push({ leadId, siteId: site, count, from: newest.from, snippet: newest.snippet, at: newest.at })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}
