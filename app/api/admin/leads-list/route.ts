import { NextRequest, NextResponse } from 'next/server'
import { defaultOwnerForSite, siteWorkspace } from '@/lib/workspaces'
import { quoteSessionId } from '@/lib/quoteintake'
import { supabase, fetchAllPages } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { canSeeContacts, maskEmail, maskPhone, scrubText } from '@/lib/pii'
import { CONTACT_ROLE, parseContact } from '@/lib/visitor'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, extractEmail } from '@/lib/leadtracking'
import { notALeadSessions, sessionForLead } from '@/lib/notalead'
import { CRM_STAGE_ROLE, isCrmStage } from '@/lib/crm'
import { canSeeAllLeads, visibleToMember } from '@/lib/teamlead'
import { ASSIGNMENT_ROLE, deriveAssignments } from '@/lib/assignment'
import { waWaitingSessions } from '@/lib/wawaiting'

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
  // Shared with the dashboard's badge poll (lib/wawaiting.ts), so the bell that
  // rings and the badge that appears can never disagree about which leads are
  // waiting.
  const waWaiting = await waWaitingSessions(allowed, waSessions)
  for (const l of merged as Array<Record<string, unknown>>) {
    l.waWaiting = waWaiting.has(sessionForLead(l as { id: string; session_id?: string | null }))
  }

  // Leads somebody has marked "not a lead" — a supplier pitching their factory
  // through the quote form, a duplicate, a mistake. They are dropped from the
  // list the Overview tiles and the site cards are computed from, so they stop
  // counting; the record itself is untouched and still opens by URL.
  // ── whose leads this member may see ───────────────────────────────────────
  // Their own plus the unassigned pool, unless they are an admin or a team
  // lead. Removed from the response entirely rather than flagged: a lead that
  // belongs to a colleague is not this agent's to read at all, which is the
  // opposite of the "not a lead" case just below, where hiding the row was the
  // thing that made marking a one-way trip.
  // Every row carries its owner — the Overview's agent filter reads it, and
  // the visibility rule below is applied from the same map, so the filter and
  // the rule can never disagree about whose lead something is.
  // Read for the leads in THIS list only, in chunks. The old single query got
  // the oldest 1000 of ~21k assignment rows (PostgREST max-rows), so every
  // owner set after late July was invisible here: the Owner column and the
  // agent filter came up empty for recent leads (owner, 2026-10-14). Paging all
  // 21k on every Overview load would be the unbounded scan that took this
  // database down once; scoping to the listed sessions keeps it small.
  // Samir and Steve are team leads (lib/teamlead.ts) and still see every lead.
  const listed = [...new Set((merged as Array<{ id: string; session_id?: string | null }>).map((l) => sessionForLead(l)))]
  const ownerRows: { session_id: string; role: string; message: string; created_at: string }[] = []
  for (let i = 0; i < listed.length; i += 150) {
    const { data } = await supabase.from('chat_logs')
      .select('session_id, role, message, created_at')
      .in('session_id', listed.slice(i, i + 150)).eq('role', ASSIGNMENT_ROLE)
      .order('created_at', { ascending: true }).limit(1000)
    ownerRows.push(...((data ?? []) as typeof ownerRows))
  }
  ownerRows.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const owned = deriveAssignments(ownerRows)
  for (const l of merged as Array<Record<string, unknown>>) {
    l.owner = owned[sessionForLead(l as { id: string; session_id?: string | null })] ?? defaultOwnerForSite(String(l.site_id ?? ''))
  }
  if (!(await canSeeAllLeads(member))) {
    for (let i = merged.length - 1; i >= 0; i--) {
      const sid = sessionForLead(merged[i] as { id: string; session_id?: string | null })
      if (!visibleToMember(owned[sid] ?? defaultOwnerForSite(String((merged[i] as { site_id?: unknown }).site_id ?? '')), member.email, false)) merged.splice(i, 1)
    }
  }

  // The deal stage each lead is at. The pipeline board already derives this
  // from the same control rows; the Recent Leads table had no idea a stage
  // existed, so an agent scanning it could not tell who had been spoken to and
  // who had not without opening every record.
  //
  // Paged for the same reason as the owners above: the old single query got
  // the oldest 1000 of ~1,900 stage rows (cut off at 2026-09-22), so every
  // lead moved after that — by an agent or by the quote bot — read "New" here
  // while its record showed the real stage (owner, 2026-10-14).
  const stageRows = await fetchAllPages(
    () => supabase.from('chat_logs')
      .select('session_id, message, created_at')
      .in('site_id', allowed).eq('role', CRM_STAGE_ROLE)
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
    100000,
  )
  const stageOf: Record<string, { stage: string; at: string }> = {}
  for (const r of stageRows) {
    try {
      const v = JSON.parse(r.message)?.stage
      if (isCrmStage(v)) stageOf[r.session_id] = { stage: v, at: String(r.created_at) } // ascending → the last one wins
    } catch { /* not a stage row we understand */ }
  }
  for (const l of merged as Array<Record<string, unknown>>) {
    const own = stageOf[sessionForLead(l as { id: string; session_id?: string | null })]
    // Packaging only: a chat lead also has a `leads` row, and the quote bot
    // works that row's quote-<id> record — so its "Contacted" lives there, not
    // on the chat session this list resolves the lead to. The newer of the two
    // wins. Sports is left exactly as it was.
    const qid = typeof l.id === 'string' && !l.id.startsWith('cap-') ? quoteSessionId(l.id) : null
    const viaQuote = qid && l.session_id && siteWorkspace(String(l.site_id ?? '')) === 'packaging' ? stageOf[qid] : undefined
    const pick = own && viaQuote ? (viaQuote.at > own.at ? viaQuote : own) : (own ?? viaQuote)
    l.stage = pick?.stage ?? 'new'
  }

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
