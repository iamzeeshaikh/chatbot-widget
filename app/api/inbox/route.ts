import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, memberSites } from '@/lib/auth'
import { hasFeature, defaultOwnerForSite } from '@/lib/workspaces'
import { CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, parseCrmEmailIn, parseCrmEmailRead } from '@/lib/emailreply'
import { CRM_EMAIL_ROLE, parseCrmEmail } from '@/lib/crmemail'
import { ASSIGNMENT_ROLE } from '@/lib/assignment'
import { CRM_EMAIL_OPEN_ROLE, parseCrmEmailOpen } from '@/lib/emailtrack'
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

const WINDOW_DAYS = 90   // the Gmail history import reaches back 75 days; the list must show all of it

function excerpt(body: string, q: string): string {
  const i = body.toLowerCase().indexOf(q)
  if (i < 0) return ''
  const start = Math.max(0, i - 60)
  const end = Math.min(body.length, i + q.length + 90)
  return `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\s+/g, ' ').trim()}${end < body.length ? '…' : ''}`
}


type Row = { session_id: string; site_id: string; role: string; message: string; created_at: string }

// The mail rows for a site set, held for a minute. Every open Inbox tab polls
// this endpoint every 60s, and each poll used to page ~1,500 email rows (~9MB)
// out of Postgres and JSON-parse them — 18 seconds, measured. Now a warm
// instance answers from memory; a cold one loads once. Rows are append-only,
// and a minute is the poll interval, so nothing is ever more than a poll stale.
const ROW_CACHE = new Map<string, { at: number; rows: Row[] }>()
const ROW_CACHE_MS = 60_000

async function emailRows(sites: string[], since: string): Promise<Row[]> {
  const key = `${sites.slice().sort().join(',')}|${since.slice(0, 10)}`
  const hit = ROW_CACHE.get(key)
  if (hit && Date.now() - hit.at < ROW_CACHE_MS) return hit.rows
  // Paged with range(), not .limit() — PostgREST caps any single response at
  // 1000 rows, and ascending order means a cap eats the NEWEST rows (the bug
  // lib/unread.ts documents; same shape, same cure).
  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data: page } = await supabase.from('chat_logs')
      .select('session_id, site_id, role, message, created_at')
      .in('site_id', sites)
      .in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, CRM_EMAIL_OPEN_ROLE])
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + 999)
    rows.push(...(page ?? []))
    if (!page || page.length < 1000) break
  }
  ROW_CACHE.set(key, { at: Date.now(), rows })
  return rows
}

// Owners for exactly the leads on the list — NOT a scan of every assignment
// row in the window (15,435 of them, one per chat reply: 16 pages, the bulk
// of the 18 seconds). Only an agent who cannot see every lead needs this.
async function ownersFor(leadIds: string[]): Promise<Map<string, string | null>> {
  const owner = new Map<string, string | null>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data } = await supabase.from('chat_logs')
      .select('session_id, message, created_at')
      .in('session_id', leadIds.slice(i, i + 100)).eq('role', ASSIGNMENT_ROLE)
      .order('created_at', { ascending: true }).limit(2000)
    for (const r of data ?? []) owner.set(r.session_id, (r.message ?? '').trim() || null)   // ascending → last wins
  }
  return owner
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'email')) {
    return NextResponse.json({ error: 'Email is not enabled for this workspace' }, { status: 403 })
  }

  // Gmail-style mail search: ?q= matches subject, every message body, sender
  // names/addresses and attachment names — across the same 60-day window the
  // list shows. Threads carry a lowercase haystack for it, built in the fold.
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100)
  const sites = memberSites(member)
  if (sites.length === 0) return NextResponse.json({ threads: [] })
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

  const rows = await emailRows(sites, since)

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
    lastOutId: string
    /** Whether the customer opened our latest send (open pixel). */
    lastOutOpened: boolean
    /** Search: did ANY message of this thread contain the term. */
    matched: boolean
    /** For a search hit: the first body passage around the term. */
    hit: string
  }
  // Matched PER MESSAGE, not against a capped per-thread haystack: a 95-message
  // thread carried "invoice" past the old 40k cap and never matched, while
  // Gmail found it. Quoted history counts too, as it does in Gmail.
  const feed = (t: Thread, text: string, body: string) => {
    if (!q) return
    if (!t.matched && text.toLowerCase().includes(q)) t.matched = true
    if (!t.hit) t.hit = excerpt(body, q)
  }
  const threads = new Map<string, Thread>()
  const read = new Set<string>()
  const opened = new Set<string>()   // email ids the customer opened

  for (const r of rows) {
    if (r.role === CRM_EMAIL_READ_ROLE) {
      const e = parseCrmEmailRead(r.message)
      if (e) read.add(e.gmailId)
      continue
    }
    if (r.role === CRM_EMAIL_OPEN_ROLE) {
      const o = parseCrmEmailOpen(r.message)
      if (o) opened.add(o.emailId)
      continue
    }
    let t = threads.get(r.session_id)
    if (!t) {
      t = { leadId: r.session_id, siteId: r.site_id, subject: '', from: '', snippet: '', at: '', direction: 'out', messages: 0, unread: 0, hasAttachments: false, inboundIds: [], participants: [], files: [], lastOutAt: '', lastOutId: '', lastOutOpened: false, matched: false, hit: '' }
      threads.set(r.session_id, t)
    }
    if (r.role === CRM_EMAIL_IN_ROLE) {
      const e = parseCrmEmailIn(r.message)
      if (!e) continue
      t.messages++
      t.inboundIds.push(e.gmailId)
      if (e.attachments?.length) { t.hasAttachments = true; for (const a of e.attachments) t.files.push({ name: a.name, mime: a.mime }) }
      t.participants.push(`c:${e.fromName || ''}|${e.from || ''}`)
      feed(t, `${e.subject} ${e.fromName ?? ''} ${e.from} ${(e.attachments ?? []).map((a) => a.name).join(' ')} ${e.body} ${e.quoted ?? ''}`, e.body || e.quoted || '')
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
      feed(t, `${e.subject} ${e.to} ${(e.attachments ?? []).map((a) => a.name).join(' ')} ${e.body}`, e.body)
      const oAt = e.at || r.created_at
      if (oAt > t.lastOutAt) { t.lastOutAt = oAt; t.lastOutId = e.id }
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
  const owner = seesAll ? new Map<string, string | null>() : await ownersFor(Array.from(threads.keys()))
  const hideContactsHere = !canSeeContacts(member)
  const { data: siteRows } = await supabase.from('sites').select('site_id, name')
  const siteName = new Map((siteRows ?? []).map((s) => [s.site_id, String(s.name ?? '')]))

  const out = Array.from(threads.values())
    .filter((t) => t.messages > 0)
    .filter((t) => !q || t.matched)
    .filter((t) => visibleToMember(owner.get(t.leadId) ?? defaultOwnerForSite(t.siteId), member.email, seesAll))
    .map((t) => ({
      leadId: t.leadId,
      siteId: t.siteId,
      siteName: siteName.get(t.siteId) ?? t.siteId,
      subject: hideContactsHere ? (scrubText(t.subject) ?? '') : t.subject,
      from: hideContactsHere && /@/.test(t.from) ? HIDDEN_EMAIL : (hideContactsHere ? (scrubText(t.from) ?? '') : t.from),
      snippet: hideContactsHere ? (scrubText(q && t.hit ? t.hit : t.snippet) ?? '') : (q && t.hit ? t.hit : t.snippet),
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
      lastOutOpened: !!t.lastOutId && opened.has(t.lastOutId),
      unread: t.inboundIds.filter((id) => !read.has(id)).length,
      owner: owner.get(t.leadId) ?? defaultOwnerForSite(t.siteId),
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 500)   // 200 clipped the list once the history import passed it

  return NextResponse.json({ threads: out, q })
}
