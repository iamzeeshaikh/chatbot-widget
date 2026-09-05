import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, memberSites } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, parseCrmEmailIn, parseCrmEmailRead } from '@/lib/emailreply'
import { CRM_EMAIL_ROLE, parseCrmEmail } from '@/lib/crmemail'
import { ASSIGNMENT_ROLE } from '@/lib/assignment'
import { canSeeAllLeads, visibleToMember } from '@/lib/teamlead'
import { canSeeContacts, scrubText, HIDDEN_EMAIL } from '@/lib/pii'
import { asUtcIso } from '@/lib/visitor'
import { storedMemberNames } from '@/lib/membername'
import { agentDisplayName } from '@/lib/agentname'

export const dynamic = 'force-dynamic'

// The Inbox: every email conversation this member may see, newest first,
// unread flagged — the mail half of the CRM in one list, the way a mailbox
// shows it, instead of scattered one thread per lead record.
//
// A THREAD here is a lead: all mail with one customer lands on their record,
// which is what keeps quoting, threading headers and read-marking in one
// place. Clicking through opens that record; this endpoint only has to say
// what is waiting.

const WINDOW_DAYS = 60

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'email')) {
    return NextResponse.json({ error: 'Email is not enabled for this workspace' }, { status: 403 })
  }

  const sites = memberSites(member)
  if (sites.length === 0) return NextResponse.json({ threads: [] })
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

  // Paged with range(), not .limit() — PostgREST caps any single response at
  // 1000 rows, and ascending order means a cap eats the NEWEST rows (the bug
  // lib/unread.ts documents; same shape, same cure).
  const rows: { session_id: string; site_id: string; role: string; message: string; created_at: string }[] = []
  for (let from = 0; ; from += 1000) {
    const { data: page } = await supabase.from('chat_logs')
      .select('session_id, site_id, role, message, created_at')
      .in('site_id', sites)
      .in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, ASSIGNMENT_ROLE])
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + 999)
    rows.push(...(page ?? []))
    if (!page || page.length < 1000) break
  }

  interface Thread {
    leadId: string; siteId: string
    subject: string; from: string; snippet: string; at: string
    direction: 'in' | 'out'
    messages: number; unread: number; hasAttachments: boolean
    inboundIds: string[]
    /** Gmail's "Samir, Damaria" — distinct parties in first-appearance order. */
    participants: string[]
    /** Every file on the thread, for the chips under the row. */
    files: { name: string; mime: string }[]
    /** When WE last wrote — the Sent folder sorts on this. */
    lastOutAt: string
  }
  const threads = new Map<string, Thread>()
  const read = new Set<string>()
  const owner = new Map<string, string | null>()

  for (const r of rows) {
    if (r.role === CRM_EMAIL_READ_ROLE) {
      const e = parseCrmEmailRead(r.message)
      if (e) read.add(e.gmailId)
      continue
    }
    if (r.role === ASSIGNMENT_ROLE) {
      owner.set(r.session_id, (r.message ?? '').trim() || null)   // ascending → last wins
      continue
    }
    let t = threads.get(r.session_id)
    if (!t) {
      t = { leadId: r.session_id, siteId: r.site_id, subject: '', from: '', snippet: '', at: '', direction: 'out', messages: 0, unread: 0, hasAttachments: false, inboundIds: [], participants: [], files: [], lastOutAt: '' }
      threads.set(r.session_id, t)
    }
    if (r.role === CRM_EMAIL_IN_ROLE) {
      const e = parseCrmEmailIn(r.message)
      if (!e) continue
      t.messages++
      t.inboundIds.push(e.gmailId)
      if (e.attachments?.length) { t.hasAttachments = true; for (const a of e.attachments) t.files.push({ name: a.name, mime: a.mime }) }
      t.participants.push(`c:${e.fromName || ''}|${e.from || ''}`)
      const at = e.at || r.created_at
      if (at >= t.at) {
        t.at = at; t.direction = 'in'
        t.from = e.fromName || e.from
        t.subject = e.subject || t.subject
        t.snippet = (e.body || '').replace(/\s+/g, ' ').trim() || e.snippet || ''
      }
    } else {
      const e = parseCrmEmail(r.message)
      if (!e) continue
      t.messages++
      if (e.attachments?.length) { t.hasAttachments = true; for (const a of e.attachments) t.files.push({ name: a.name, mime: a.mime }) }
      t.participants.push(`a:${e.sentBy || e.from || ''}`)
      const oAt = e.at || r.created_at
      if (oAt > t.lastOutAt) t.lastOutAt = oAt
      const at = e.at || r.created_at
      if (at >= t.at) {
        t.at = at; t.direction = 'out'
        t.from = e.to
        t.subject = e.subject || t.subject
        t.snippet = e.snippet || ''
      }
    }
  }

  const names = await storedMemberNames()
  const shortAgent = (email: string) => {
    const e = String(email || '').toLowerCase()
    if (e === member.email.toLowerCase()) return 'me'
    return (names.get(e) || agentDisplayName(e)).split(/\s+/)[0]
  }
  const shortCustomer = (name: string, addr: string) => (name || addr.split('@')[0] || 'Customer').split(/\s+/)[0]
  const addParty = (t: Thread, who: string) => { if (who && !t.participants.includes(who)) t.participants.push(who) }

  const seesAll = await canSeeAllLeads(member)
  const hideContactsHere = !canSeeContacts(member)
  const { data: siteRows } = await supabase.from('sites').select('site_id, name')
  const siteName = new Map((siteRows ?? []).map((s) => [s.site_id, String(s.name ?? '')]))

  const out = Array.from(threads.values())
    .filter((t) => t.messages > 0)
    .filter((t) => visibleToMember(owner.get(t.leadId), member.email, seesAll))
    .map((t) => ({
      leadId: t.leadId,
      siteId: t.siteId,
      siteName: siteName.get(t.siteId) ?? t.siteId,
      subject: hideContactsHere ? (scrubText(t.subject) ?? '') : t.subject,
      from: hideContactsHere && /@/.test(t.from) ? HIDDEN_EMAIL : (hideContactsHere ? (scrubText(t.from) ?? '') : t.from),
      snippet: hideContactsHere ? (scrubText(t.snippet) ?? '') : t.snippet,
      at: asUtcIso(t.at),
      direction: t.direction,
      messages: t.messages,
      hasAttachments: t.hasAttachments,
      participants: (() => {
        const out: Thread = { ...t, participants: [] }
        for (const tag of t.participants) {
          if (tag.startsWith('a:')) addParty(out, shortAgent(tag.slice(2)))
          else { const [n, a] = tag.slice(2).split('|'); addParty(out, hideContactsHere && !n ? 'Customer' : shortCustomer(n, a)) }
        }
        return out.participants
      })(),
      files: (hideContactsHere ? t.files.map((f) => ({ ...f, name: scrubText(f.name) ?? 'file' })) : t.files).slice(0, 12),
      lastOutAt: t.lastOutAt ? asUtcIso(t.lastOutAt) : null,
      unread: t.inboundIds.filter((id) => !read.has(id)).length,
      owner: owner.get(t.leadId) ?? null,
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 200)

  return NextResponse.json({ threads: out })
}
