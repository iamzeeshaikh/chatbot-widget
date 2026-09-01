import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { canSeeContacts, maskEmail, maskPhone, scrubText } from '@/lib/pii'
import { CONTACT_ROLE, parseContact } from '@/lib/visitor'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, extractEmail } from '@/lib/leadtracking'
import { notALeadSessions, sessionForLead } from '@/lib/notalead'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from '@/lib/crm'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ leads: [] }, { status: 401 })
  const scope = await siteScope(member)
  const allowed = Array.from(scope)

  // Quote leads reach back to whenever the account owner first started
  // labeling emails in Gmail (some from 2024) — long before the chat widget
  // itself went live. Counting those in the Overview's "Total Leads" makes
  // it a different, larger number than what the dashboard has actually been
  // tracking since go-live, so it's floored to when the bot went active.
  const TRACKING_START = '2026-06-01T00:00:00Z'

  // The Overview tab's Total/Today/This-Week tiles and the site breakdown are
  // all computed client-side from this full list — a `.limit(100)` here
  // silently capped "Total Leads" well below the real count once quote-lead
  // ingestion pushed this table past a few hundred rows (found showing "100"
  // when the true total was 982). Page through everything in scope instead.
  const leads = await fetchAllPages(
    () => {
      let q = supabase.from('leads').select('*').gte('created_at', TRACKING_START).order('created_at', { ascending: false })
      if (scope) q = q.in('site_id', allowed)
      return q
    },
    20000
  )

  // The leads table has no session_id, so resolve each lead's conversation by
  // matching its email against chat rows for the same site — preferring the
  // explicit billing capture / agent-entered contact, then any visitor message
  // that mentioned the email. Keyed by `${site_id}|${email}` so it never links
  // across sites. Best-effort: leads with no on-record conversation stay unlinked.
  const emails = new Set(leads.map((l) => (l.email || '').trim().toLowerCase()).filter(Boolean))
  if (emails.size > 0 && allowed.length > 0) {
    const { data: rows } = await supabase
      .from('chat_logs')
      .select('session_id, site_id, role, message, created_at')
      .in('site_id', allowed)
      .in('role', [LEAD_CAPTURE_ROLE, CONTACT_ROLE, 'user'])
      .order('created_at', { ascending: false })
      .limit(8000)

    // rank: lead_capture (3) > contact (2) > user message (1). Higher wins; for
    // equal rank the most recent row wins (rows are newest-first already).
    const best: Record<string, { rank: number; session_id: string }> = {}
    for (const r of rows ?? []) {
      let email: string | null = null
      let rank = 0
      if (r.role === LEAD_CAPTURE_ROLE) { email = parseLeadCapture(r.message)?.email ?? null; rank = 3 }
      else if (r.role === CONTACT_ROLE) { email = (parseContact(r.message).email || '').toLowerCase() || null; rank = 2 }
      else { email = extractEmail(r.message); rank = 1 }
      if (!email) continue
      const key = `${r.site_id}|${email.toLowerCase()}`
      if (!emails.has(email.toLowerCase())) continue
      if (!best[key] || rank > best[key].rank) best[key] = { rank, session_id: r.session_id }
    }

    for (const l of leads) {
      const key = `${l.site_id}|${(l.email || '').trim().toLowerCase()}`
      ;(l as { session_id?: string | null }).session_id = best[key]?.session_id ?? null
    }
  }

  // Chat-captured leads (lead_capture control rows) that never produced a
  // `leads` table row — a visitor typing their email into the chat, or a
  // manual mark-as-lead. They count in the Overview tiles and in Billing, so
  // leaving them out of Recent Leads made the tile say "2" while the table
  // showed 1. Merged here as synthetic rows (id `cap-<session>`, no message /
  // score) — a capture whose site+email already has a real leads row is the
  // same lead and is skipped, not listed twice.
  const captureRows = await fetchAllPages(
    () => {
      let q = supabase
        .from('chat_logs')
        .select('session_id, site_id, message, created_at')
        .eq('role', LEAD_CAPTURE_ROLE)
        .gte('created_at', TRACKING_START)
        .order('created_at', { ascending: false })
      if (scope) q = q.in('site_id', allowed)
      return q
    },
    20000
  )

  const leadKeys = new Set(
    leads
      .filter((l) => (l.email || '').trim())
      .map((l) => `${l.site_id}|${(l.email || '').trim().toLowerCase()}`)
  )
  const seenSessions = new Set<string>()
  const captureLeads = []
  for (const r of captureRows) {
    if (seenSessions.has(r.session_id)) continue
    seenSessions.add(r.session_id)
    const cap = parseLeadCapture(r.message)
    if (!cap) continue
    if (cap.email && leadKeys.has(`${r.site_id}|${cap.email.toLowerCase()}`)) continue
    captureLeads.push({
      id: `cap-${r.session_id}`,
      site_id: r.site_id,
      name: cap.name,
      email: cap.email,
      phone: cap.phone,
      message: null,
      created_at: r.created_at,
      product: null,
      quantity: null,
      budget: null,
      timeline: null,
      qualification_score: null,
      session_id: r.session_id,
    })
  }

  const merged = [...leads, ...captureLeads].sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  )

  // ── Who actually handled this chat: the bot, or a person? ─────────────────
  // The test is the same one the Overview chart's "Picked" line uses, so the
  // two can never disagree: a session carries an `admin` row only when a HUMAN
  // typed in it. The bot's own answers are `assistant` rows. No admin row on a
  // chat lead therefore means the bot ran that conversation start to finish.
  //
  // One extra query, bounded by the sessions already on this page.
  const chatSessions = merged
    .map((l) => (l as { session_id?: string }).session_id)
    .filter((v): v is string => !!v)
  const humanSessions = new Set<string>()
  if (chatSessions.length > 0) {
    for (let i = 0; i < chatSessions.length; i += 200) {
      const { data: admins } = await supabase
        .from('chat_logs')
        .select('session_id')
        .eq('role', 'admin')
        .in('session_id', chatSessions.slice(i, i + 200))
      for (const r of admins ?? []) humanSessions.add(r.session_id)
    }
  }
  for (const l of merged as Array<Record<string, unknown>>) {
    const sid = typeof l.session_id === 'string' ? l.session_id : null
    l.handledBy = sid ? (humanSessions.has(sid) ? 'agent' : 'bot') : null
  }

  // Recent Leads is a list of names and sites for a member who may not see
  // contacts — the address and number are masked here, on the way out, and the
  // NAME is scrubbed too because a lead that arrived without one is titled by
  // its own email address.
  if (!canSeeContacts(member)) {
    for (const l of merged as Array<Record<string, unknown>>) {
      if (typeof l.name === 'string' && (/@/.test(l.name) || /\d{7,}/.test(l.name))) l.name = scrubText(l.name)
      if ('email' in l) l.email = maskEmail(l.email as string | null)
      if ('phone' in l) l.phone = maskPhone(l.phone as string | null)
      if (typeof l.message === 'string') l.message = scrubText(l.message)
    }
  }

  // ── Which leads are waiting on a WhatsApp reply ──────────────────────────
  // A customer's WhatsApp message lands on the record and nowhere else, so the
  // only way to find one was to open leads at random. That is how a real
  // enquiry sat unanswered for an hour on 1 Sep while its lead sat in this very
  // list looking identical to the rest.
  //
  // The rule is the same one the record uses: the LAST WhatsApp message on the
  // lead is the customer's. It needs no read-marking and clears itself the
  // moment somebody replies.
  const waSessions = new Set(
    merged.map((l) => sessionForLead(l as { id: string; session_id?: string | null })),
  )
  const waWaiting = new Set<string>()
  if (allowed.length > 0) {
    const { data: waRows } = await supabase
      .from('chat_logs')
      .select('session_id, role, created_at')
      .in('site_id', allowed)
      .in('role', [CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE])
      .order('created_at', { ascending: true })
      .limit(5000)
    for (const r of waRows ?? []) {
      if (!waSessions.has(r.session_id)) continue
      if (r.role === CRM_WA_IN_ROLE) waWaiting.add(r.session_id)
      else waWaiting.delete(r.session_id)
    }
  }
  for (const l of merged as Array<Record<string, unknown>>) {
    l.waWaiting = waWaiting.has(sessionForLead(l as { id: string; session_id?: string | null }))
  }

  // Leads somebody has marked "not a lead" — a supplier pitching their factory
  // through the quote form, a duplicate, a mistake. They are dropped from the
  // list the Overview tiles and the site cards are computed from, so they stop
  // counting; the record itself is untouched and still opens by URL.
  const excluded = await notALeadSessions(allowed)
  // Marked leads are flagged, not deleted from the response. Dropping them
  // outright made marking a one-way trip: the row vanished from every list and
  // the only way back was a URL nobody had kept. The dashboard filters them out
  // of its counts and can show them on request.
  for (const l of merged as Array<Record<string, unknown>>) {
    l.notALead = excluded.has(sessionForLead(l as { id: string; session_id?: string | null }))
  }
  const notALeadCount = (merged as Array<Record<string, unknown>>).filter((l) => l.notALead).length

  // Said out loud rather than left to be discovered: a smaller number with no
  // explanation is exactly how a filter that went wrong stays hidden.
  return NextResponse.json({ leads: merged, notALead: notALeadCount })
}
