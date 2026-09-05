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
      t = { leadId: r.session_id, siteId: r.site_id, subject: '', from: '', snippet: '', at: '', direction: 'out', messages: 0, unread: 0, hasAttachments: false, inboundIds: [] }
      threads.set(r.session_id, t)
    }
    if (r.role === CRM_EMAIL_IN_ROLE) {
      const e = parseCrmEmailIn(r.message)
      if (!e) continue
      t.messages++
      t.inboundIds.push(e.gmailId)
      if (e.attachments?.length) t.hasAttachments = true
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
      if (e.attachments?.length) t.hasAttachments = true
      const at = e.at || r.created_at
      if (at >= t.at) {
        t.at = at; t.direction = 'out'
        t.from = e.to
        t.subject = e.subject || t.subject
        t.snippet = e.snippet || ''
      }
    }
  }

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
      unread: t.inboundIds.filter((id) => !read.has(id)).length,
      owner: owner.get(t.leadId) ?? null,
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 200)

  return NextResponse.json({ threads: out })
}
