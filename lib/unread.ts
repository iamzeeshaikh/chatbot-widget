// Leads waiting on a reply from this member.
//
// "Unread" means a captured customer reply with no crm_email_read row against
// its Gmail id.
//
// Whose queue it belongs to uses EXACTLY the rule the notification uses: the
// lead's owner, or — when it is unassigned — whoever sent the message being
// replied to, because that is the mailbox it landed in. Anything else and the
// two disagree: the push says "you have a reply" while the badge says zero,
// which is precisely what happened the first time this shipped.
//
// Deliberately one bounded query set, folded in Node: it rides on the 60s nav
// poll that already exists for the task badge, so it adds no new polling.

import { supabase } from './supabase'
import { memberSites, type Member } from './auth'
import { CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, parseCrmEmailIn, parseCrmEmailRead } from './emailreply'
import { CRM_EMAIL_ROLE, parseCrmEmail } from './crmemail'
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
    .in('role', [CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, ASSIGNMENT_ROLE, CRM_EMAIL_ROLE])
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(4000)

  const inbound = new Map<string, Map<string, { from: string; snippet: string; at: string }>>()
  const read = new Set<string>()
  const owner = new Map<string, string | null>()
  /** Fallback recipient: who last emailed this lead. */
  const sender = new Map<string, string>()
  const siteOf = new Map<string, string>()

  for (const r of data ?? []) {
    if (r.role === CRM_EMAIL_IN_ROLE) {
      const e = parseCrmEmailIn(r.message)
      if (!e) continue
      if (!inbound.has(r.session_id)) inbound.set(r.session_id, new Map())
      inbound.get(r.session_id)!.set(e.gmailId, {
        from: e.fromName || e.from, snippet: e.snippet || e.subject, at: e.at || r.created_at,
      })
      siteOf.set(r.session_id, r.site_id)
    } else if (r.role === CRM_EMAIL_ROLE) {
      const e = parseCrmEmail(r.message)
      if (e?.sentBy) sender.set(r.session_id, e.sentBy.trim().toLowerCase())
      siteOf.set(r.session_id, r.site_id)
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
    // Owner first; otherwise whoever's mailbox the reply landed in.
    const responsible = (owner.get(leadId) || sender.get(leadId) || '').toLowerCase()
    if (responsible !== me) continue
    let newest: { from: string; snippet: string; at: string } | null = null
    let count = 0
    for (const [gmailId, m] of msgs) {
      if (read.has(gmailId)) continue
      count++
      if (!newest || m.at > newest.at) newest = m
    }
    if (count === 0 || !newest) continue
    out.push({ leadId, siteId: siteOf.get(leadId) ?? '', count, from: newest.from, snippet: newest.snippet, at: newest.at })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at))
}
