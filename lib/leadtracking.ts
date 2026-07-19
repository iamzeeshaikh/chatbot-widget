// Automatic lead detection + tagging for billing/tracking on outsourced sites.
//
// When a visitor provides a valid email anywhere in a conversation (lead form,
// a typed chat message, or during human takeover), we record a billing lead —
// ONCE per conversation — as a control row in chat_logs (no DDL), and add a
// "lead" tag alongside any manual tags. The billing report reads these rows.

import { supabase } from './supabase'
import { TAGS_ROLE, parseTags, normalizeTags } from './visitor'
import { isLeadTracked } from './workspaces'

// The tracked-site list lives in lib/workspaces.ts (a server+client-safe module)
// so the dashboard can import it without pulling in server-only code.
export { LEAD_TRACKED_SITES, isLeadTracked } from './workspaces'

// ── Email / phone extraction ─────────────────────────────────────────────────
// Pragmatic email matcher: local@domain.tld with a sane TLD. Good enough to
// gate billing without rejecting normal addresses.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

export function extractEmail(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(EMAIL_RE)
  return m ? m[0].toLowerCase().replace(/[.,;:]+$/, '') : null
}

export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false
  // Anchored validation of a trimmed candidate.
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email.trim())
}

// A phone number with at least 7 digits (allows +, spaces, dashes, parens).
export function extractPhone(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.match(/\+?\d[\d\s().-]{6,}\d/)
  if (!m) return null
  const digits = m[0].replace(/\D/g, '')
  return digits.length >= 7 && digits.length <= 15 ? m[0].trim() : null
}

// ── Billing-lead control row ─────────────────────────────────────────────────
export const LEAD_CAPTURE_ROLE = 'lead_capture'

export interface CapturedLead {
  email: string | null
  name: string | null
  phone: string | null
  at: string // ISO timestamp the lead was captured
  // True only for a lead the admin manually flagged (markLeadManually) with
  // no captured contact info at all — e.g. the chat makes it obvious the
  // customer became a real lead ("I emailed you") but never typed an email
  // into the widget, so the automatic capture below never had anything to
  // find. Kept distinct from an automatic capture (which always has email)
  // so it's identifiable in the UI/CSV rather than looking like a data bug.
  manual?: boolean
}

export function parseLeadCapture(message: string | null | undefined): CapturedLead | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && (typeof o.email === 'string' || o.manual === true)) {
      return {
        email: typeof o.email === 'string' && o.email ? o.email : null,
        name: typeof o.name === 'string' && o.name ? o.name : null,
        phone: typeof o.phone === 'string' && o.phone ? o.phone : null,
        at: typeof o.at === 'string' ? o.at : '',
        manual: o.manual === true,
      }
    }
  } catch { /* not a lead row */ }
  return null
}

// Shared by maybeCaptureLead and markLeadManually: apply the "lead" tag
// alongside any manual tags, latest tags row wins.
async function applyLeadTag(sessionId: string, siteId: string): Promise<void> {
  const { data: tagRows } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('session_id', sessionId)
    .eq('role', TAGS_ROLE)
    .order('created_at', { ascending: true })
  const current = parseTags(tagRows?.[tagRows.length - 1]?.message ?? null)
  if (!current.some((t) => t.toLowerCase() === 'lead')) {
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: TAGS_ROLE,
      message: JSON.stringify(normalizeTags(['lead', ...current])),
    })
  }
}

// Admin-only manual lead: the conversation itself makes it clear the visitor
// became a real lead (e.g. "I emailed you") even though no email was ever
// typed into the widget, so maybeCaptureLead below never fires. Counts
// toward every lead total exactly like an automatic capture, just with no
// contact info attached — idempotent per session (same guard as below), so
// clicking it twice on the same conversation is a no-op, not a double count.
export async function markLeadManually(opts: { sessionId: string; siteId: string }): Promise<{ ok: boolean; alreadyMarked: boolean }> {
  const { sessionId, siteId } = opts
  if (!sessionId || !siteId || !isLeadTracked(siteId)) return { ok: false, alreadyMarked: false }

  const { data: existingRows } = await supabase
    .from('chat_logs')
    .select('id')
    .eq('session_id', sessionId)
    .eq('role', LEAD_CAPTURE_ROLE)
    .limit(1)
  if (existingRows && existingRows.length > 0) return { ok: true, alreadyMarked: true }

  const lead: CapturedLead = { email: null, name: null, phone: null, at: new Date().toISOString(), manual: true }
  await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: LEAD_CAPTURE_ROLE,
    message: JSON.stringify(lead),
  })
  await applyLeadTag(sessionId, siteId)
  return { ok: true, alreadyMarked: false }
}

// Idempotently record a billing lead for a conversation and apply the "lead"
// tag. Safe to call on every message — it captures only once per session, then
// only enriches a missing name/phone. Never throws (billing must not break chat).
export async function maybeCaptureLead(opts: {
  sessionId: string
  siteId: string
  email?: string | null
  name?: string | null
  phone?: string | null
  text?: string | null // raw message text to scan when no explicit email is given
}): Promise<void> {
  try {
    const { sessionId, siteId } = opts
    if (!sessionId || !siteId || !isLeadTracked(siteId)) return

    const explicit = opts.email && isValidEmail(opts.email) ? opts.email.trim().toLowerCase() : null
    const email = explicit || extractEmail(opts.text)
    if (!email) return

    const name = opts.name?.trim() || null
    const phone = opts.phone?.trim() || extractPhone(opts.text)

    // Has this conversation already been counted?
    const { data: existingRows } = await supabase
      .from('chat_logs')
      .select('id, message')
      .eq('session_id', sessionId)
      .eq('role', LEAD_CAPTURE_ROLE)
      .order('created_at', { ascending: true })
      .limit(1)

    const existing = existingRows?.[0]
    if (existing) {
      // Already a lead — only fill in a missing name/phone, never re-count.
      const prev = parseLeadCapture(existing.message)
      if (prev && ((!prev.name && name) || (!prev.phone && phone))) {
        const merged: CapturedLead = {
          email: prev.email,
          name: prev.name || name,
          phone: prev.phone || phone,
          at: prev.at,
        }
        await supabase.from('chat_logs').update({ message: JSON.stringify(merged) }).eq('id', existing.id)
      }
      return
    }

    const lead: CapturedLead = { email, name, phone, at: new Date().toISOString() }
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: LEAD_CAPTURE_ROLE,
      message: JSON.stringify(lead),
    })
    await applyLeadTag(sessionId, siteId)
  } catch (err) {
    console.error('[leadtracking] maybeCaptureLead failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}
