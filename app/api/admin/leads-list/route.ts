import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { CONTACT_ROLE, parseContact } from '@/lib/visitor'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, extractEmail } from '@/lib/leadtracking'

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

  return NextResponse.json({ leads })
}
