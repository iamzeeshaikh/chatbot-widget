import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, memberSites } from '@/lib/auth'
import { hasFeature, defaultOwnerForSite } from '@/lib/workspaces'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from '@/lib/crm'
import { parseWaMessage } from '@/lib/whatsapp'
import { ASSIGNMENT_ROLE } from '@/lib/assignment'
import { LEAD_CAPTURE_ROLE } from '@/lib/leadtracking'
import { canSeeAllLeads, visibleToMember } from '@/lib/teamlead'
import { isOwnLeadsOnly, ownedSessions } from '@/lib/ownleads'
import { canSeeContacts, scrubText, HIDDEN_PHONE } from '@/lib/pii'
import { asUtcIso } from '@/lib/visitor'
import { storedMemberNames } from '@/lib/membername'
import { agentDisplayName } from '@/lib/agentname'

export const dynamic = 'force-dynamic'

// The WhatsApp half of the Inbox: one row per lead that has a WhatsApp
// conversation, newest message first, the way the email Inbox lists threads.
// Asked for by the sports team (owner's voice note, 2026-11-03): until now a
// customer's WhatsApp showed only as an "Unanswered" badge deep in the leads
// table, and nothing else said who wrote, what, or when.
//
// "Waiting" uses EXACTLY lib/wawaiting.ts's rule — the newest WhatsApp row on
// the lead is the customer's — so this list, the leads table badge and the
// bell can never disagree. It needs no read-marking: an agent's reply, from
// any device, clears it.

const WINDOW_DAYS = 90

interface Row { session_id: string; site_id: string; role: string; message: string; created_at: string }

async function waRows(sites: string[], since: string): Promise<Row[]> {
  // Paged with range(), not .limit(): PostgREST caps a response at 1000 rows
  // and ascending order would make that cap eat the NEWEST messages.
  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data: page } = await supabase.from('chat_logs')
      .select('session_id, site_id, role, message, created_at')
      .in('site_id', sites)
      .in('role', [CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE])
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + 999)
    rows.push(...(page ?? []))
    if (!page || page.length < 1000) break
  }
  return rows
}

async function ownersFor(leadIds: string[]): Promise<Map<string, string | null>> {
  const owner = new Map<string, string | null>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data } = await supabase.from('chat_logs')
      .select('session_id, message, created_at')
      .in('session_id', leadIds.slice(i, i + 100)).eq('role', ASSIGNMENT_ROLE)
      .order('created_at', { ascending: true }).limit(2000)
    for (const r of data ?? []) owner.set(r.session_id, (r.message ?? '').trim() || null)
  }
  return owner
}

/** The customer's name, from the leads table (quote-<id> sessions) or the
 *  chat widget's lead capture (everything else). */
async function namesFor(sessionIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const quoteIds = sessionIds.filter((s) => s.startsWith('quote-')).map((s) => s.slice(6))
  for (let i = 0; i < quoteIds.length; i += 100) {
    const { data } = await supabase.from('leads').select('id, name').in('id', quoteIds.slice(i, i + 100))
    for (const l of data ?? []) if (l.name) names.set(`quote-${l.id}`, String(l.name))
  }
  const chatIds = sessionIds.filter((s) => !s.startsWith('quote-'))
  for (let i = 0; i < chatIds.length; i += 100) {
    const { data } = await supabase.from('chat_logs').select('session_id, message')
      .in('session_id', chatIds.slice(i, i + 100)).eq('role', LEAD_CAPTURE_ROLE)
      .order('created_at', { ascending: true }).limit(1000)
    for (const r of data ?? []) {
      try { const o = JSON.parse(r.message); if (o?.name) names.set(r.session_id, String(o.name)) } catch { /* skip */ }
    }
  }
  return names
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'telephony')) {
    return NextResponse.json({ error: 'WhatsApp is not enabled for this workspace' }, { status: 403 })
  }
  const sites = memberSites(member)
  if (sites.length === 0) return NextResponse.json({ threads: [] })
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const rows = await waRows(sites, since)

  interface Thread {
    leadId: string; siteId: string
    phone: string; body: string; at: string
    direction: 'in' | 'out'
    messages: number
    /** Customer messages since our last reply — 0 when we spoke last. */
    unanswered: number
    hasMedia: boolean
    agents: string[]
    lastOutAt: string
    /** Newest outbound's delivery state, so a failed send shows up here too. */
    failed: boolean
  }
  const threads = new Map<string, Thread>()
  for (const r of rows) {
    const w = parseWaMessage(r.message)
    if (!w) continue
    let t = threads.get(r.session_id)
    if (!t) {
      t = { leadId: r.session_id, siteId: r.site_id, phone: '', body: '', at: '', direction: 'in', messages: 0, unanswered: 0, hasMedia: false, agents: [], lastOutAt: '', failed: false }
      threads.set(r.session_id, t)
    }
    t.messages++
    if (w.media?.length) t.hasMedia = true
    const at = w.at || r.created_at
    if (w.direction === 'inbound') {
      t.unanswered++
      t.phone = w.from || t.phone
    } else {
      t.unanswered = 0
      t.phone = w.to || t.phone
      if (w.sentBy && !t.agents.includes(w.sentBy)) t.agents.push(w.sentBy)
      if (at >= t.lastOutAt) { t.lastOutAt = at; t.failed = w.status === 'failed' || w.status === 'undelivered' }
    }
    // Rows arrive oldest first, so the last one seen is the newest.
    t.at = at
    t.direction = w.direction === 'inbound' ? 'in' : 'out'
    t.body = w.body || (w.media?.length ? (w.media[0].name || '📎 attachment') : '')
  }

  const ids = Array.from(threads.keys())
  const seesAll = await canSeeAllLeads(member)
  // Own-leads-only (lib/ownleads.ts): checked against the full assignment fold too.
  const ownedSet = isOwnLeadsOnly(member) ? await ownedSessions(member) : null
  const [owner, names, memberNames, siteRows] = await Promise.all([
    seesAll ? Promise.resolve(new Map<string, string | null>()) : ownersFor(ids),
    namesFor(ids),
    storedMemberNames(),
    supabase.from('sites').select('site_id, name').in('site_id', sites),
  ])
  const siteName = new Map((siteRows.data ?? []).map((s) => [s.site_id, String(s.name ?? '')]))
  const hideContacts = !canSeeContacts(member)
  const shortAgent = (email: string) => {
    const e = String(email || '').toLowerCase()
    if (e === member.email.toLowerCase()) return 'me'
    return (memberNames.get(e) || agentDisplayName(e)).split(/\s+/)[0]
  }

  const out = Array.from(threads.values())
    .filter((t) => visibleToMember(owner.get(t.leadId) ?? defaultOwnerForSite(t.siteId), member.email, seesAll, isOwnLeadsOnly(member)))
    .filter((t) => !ownedSet || ownedSet.has(t.leadId))
    .map((t) => ({
      leadId: t.leadId,
      siteId: t.siteId,
      siteName: siteName.get(t.siteId) ?? t.siteId,
      name: names.get(t.leadId) ?? '',
      // The number is contact detail: masked for a member who may not see
      // contacts (lib/pii.ts), exactly as the record masks it.
      phone: hideContacts ? HIDDEN_PHONE : t.phone,
      body: hideContacts ? (scrubText(t.body) ?? '') : t.body,
      at: asUtcIso(t.at),
      direction: t.direction,
      messages: t.messages,
      unanswered: t.unanswered,
      hasMedia: t.hasMedia,
      agents: t.agents.map(shortAgent),
      lastOutAt: t.lastOutAt ? asUtcIso(t.lastOutAt) : null,
      failed: t.failed,
      owner: owner.get(t.leadId) ?? defaultOwnerForSite(t.siteId),
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 500)

  return NextResponse.json({ threads: out })
}
