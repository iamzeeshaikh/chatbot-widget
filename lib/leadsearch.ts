// Global lead search.
//
// Two surfaces hold lead identity, so both are queried in parallel and merged:
//   • `leads`        — email/quote/checkout leads, with real name/email/phone
//                      columns plus the enquiry body in `message`
//   • `chat_logs`    — chat leads, whose name/email/phone live inside the JSON
//     role=lead_capture   of one control row per captured session
//
// SITE SCOPE IS PART OF EVERY QUERY, not a filter applied afterwards. A member
// can never receive a lead they could not open, so search can never be used to
// discover that a site exists.
//
// ── Why it does not degrade ──────────────────────────────────────────────────
// Both queries are bounded three ways: the site scope, a hard row cap, and a
// minimum term length (a 1-character term would match half the table and is
// refused). The enquiry body is searched, but only as one OR arm of a query
// that is already capped — never as a separate unbounded scan.
//
// The one that will bite eventually is `role = 'lead_capture'`: chat_logs has
// no index on `role`, so finding those 88 rows means scanning all 40k. It is
// fast now and grows with the table. See the index note in CLAUDE.md.

import { supabase } from './supabase'
import { memberSites, type Member } from './auth'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { asUtcIso } from './visitor'
import {
  quoteSessionId, isQuoteLeadMessage, isCheckoutLeadMessage, stripQuoteTag, cleanQuoteSubject,
} from './quoteintake'
import { digitsOnly, normEmail, groupSameParty, phoneKey, samePhone } from './identity'

/** Below this, a term matches too much to be useful. */
export const MIN_QUERY = 2
/** Rows pulled from each surface before merging. */
export const ROW_CAP = 120
/** Results handed to the UI. */
export const RESULT_CAP = 25

export type SearchKind = 'chat' | 'quote' | 'checkout'
export type MatchField = 'name' | 'email' | 'phone' | 'enquiry' | 'site'

export interface SearchHit {
  id: string
  siteId: string
  siteName: string
  name: string
  email: string | null
  phone: string | null
  kind: SearchKind
  /** Which field the term was found in — shown so a surprising hit explains itself. */
  matchedOn: MatchField
  /** Enquiry snippet, only when that is where the match was. */
  snippet: string | null
  at: string | null
  /** Same-party group, from lib/identity.ts — the Related Leads rule. */
  group: number
}

interface LeadRow {
  id: string; site_id: string; name: string | null; email: string | null
  phone: string | null; message: string | null; created_at: string
}
interface CaptureRow { session_id: string; site_id: string; message: string; created_at: string }

// PostgREST `or=` is comma-separated, and a comma or parenthesis inside a value
// would break out of the filter list. Percent and underscore are ILIKE
// wildcards. Escaping both keeps a term like "a,b(c)" a literal search rather
// than a syntax error or an accidental match-everything.
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`)
}
function escapeOrValue(term: string): string {
  return escapeLike(term).replace(/[(),]/g, ' ')
}

/**
 * A phone typed any which way still matches one stored any other way.
 *
 * Stored numbers carry formatting ("+92 300 000-0000"), so an ILIKE for the
 * digits alone never matches. This builds a pattern of the digits separated by
 * wildcards — `%9%2%3%0%0%` — which SQL can use to NARROW cheaply, and the
 * exact digits-only comparison then happens in Node (see phoneMatches). The
 * loose pattern over-matches on purpose; nothing reaches the caller unverified.
 */
function loosePhonePattern(digits: string): string {
  return `%${digits.split('').join('%')}%`
}

function phoneMatches(stored: string | null | undefined, typed: string): boolean {
  // The canonical key handles country-code and trunk-prefix differences; the
  // substring fallback catches a partial number typed from memory.
  if (samePhone(stored, typed)) return true
  const d = digitsOnly(stored)
  const q = digitsOnly(typed)
  return q.length >= 6 && d.includes(q)
}

function snippetAround(body: string, term: string): string | null {
  const i = body.toLowerCase().indexOf(term.toLowerCase())
  if (i < 0) return null
  const from = Math.max(0, i - 40)
  const text = body.slice(from, from + 140).replace(/\s+/g, ' ').trim()
  return (from > 0 ? '…' : '') + text + (from + 140 < body.length ? '…' : '')
}

export async function searchLeads(member: Member, rawTerm: string): Promise<{
  hits: SearchHit[]; truncated: boolean; tookMs: number
}> {
  const started = Date.now()
  const term = rawTerm.trim()
  const allowed = memberSites(member)
  if (term.length < MIN_QUERY || allowed.length === 0) return { hits: [], truncated: false, tookMs: 0 }

  const like = `%${escapeOrValue(term)}%`
  const qDigits = digitsOnly(term)
  const phoneish = qDigits.length >= 4
  // The pattern is built from the CANONICAL key, not the typed digits. Built
  // from "03004567890" the wildcards demand a 3 after the leading 0, which
  // "+92 300 4567890" does not have, so the row is never fetched and Node never
  // gets to verify it. The last-9 form matches every spelling of the number.
  const phonePattern = phoneish ? loosePhonePattern(phoneKey(term) ?? qDigits) : null

  const [leadsRes, capsRes, sitesRes] = await Promise.all([
    supabase.from('leads')
      .select('id, site_id, name, email, phone, message, created_at')
      .in('site_id', allowed)
      .or([
        `name.ilike.${like}`,
        `email.ilike.${like}`,
        `phone.ilike.${like}`,
        `message.ilike.${like}`,
        ...(phonePattern ? [`phone.ilike.${phonePattern}`] : []),
      ].join(','))
      .order('created_at', { ascending: false })
      .limit(ROW_CAP),
    // One ILIKE over the capture JSON covers name, email AND phone for chat
    // leads, because all three live in that one row.
    supabase.from('chat_logs')
      .select('session_id, site_id, message, created_at')
      .eq('role', LEAD_CAPTURE_ROLE)
      .in('site_id', allowed)
      .or([`message.ilike.${like}`, ...(phonePattern ? [`message.ilike.${phonePattern}`] : [])].join(','))
      .order('created_at', { ascending: false })
      .limit(ROW_CAP),
    supabase.from('sites').select('site_id, name'),
  ])

  const siteName: Record<string, string> = {}
  for (const s of sitesRes.data ?? []) siteName[s.site_id] = s.name

  const lower = term.toLowerCase()
  const hits: Omit<SearchHit, 'group'>[] = []

  // ── chat leads ─────────────────────────────────────────────────────────────
  for (const r of (capsRes.data ?? []) as CaptureRow[]) {
    const c = parseLeadCapture(r.message)
    if (!c) continue
    const name = (c.name ?? '').trim()
    const matchedOn: MatchField | null =
      name.toLowerCase().includes(lower) ? 'name'
      : normEmail(c.email).includes(lower) ? 'email'
      : (phoneish && phoneMatches(c.phone, term)) ? 'phone'
      : null
    // The loose phone pattern and the JSON-wide ILIKE both over-match; a row
    // that survives neither an exact field check nor the phone comparison is
    // dropped here rather than shown as an unexplained hit.
    if (!matchedOn) continue
    hits.push({
      id: r.session_id, siteId: r.site_id, siteName: siteName[r.site_id] ?? r.site_id,
      name: name || c.email || 'Unnamed lead', email: c.email, phone: c.phone,
      kind: 'chat', matchedOn, snippet: null, at: asUtcIso(c.at || r.created_at),
    })
  }

  // ── email / quote / checkout leads ─────────────────────────────────────────
  const seen = new Set(hits.map((h) => h.id))
  for (const l of (leadsRes.data ?? []) as LeadRow[]) {
    const id = quoteSessionId(l.id)
    if (seen.has(id)) continue
    const name = (l.name ?? '').trim()
    const body = stripQuoteTag(l.message)
    let matchedOn: MatchField | null =
      name.toLowerCase().includes(lower) ? 'name'
      : normEmail(l.email).includes(lower) ? 'email'
      : (phoneish && phoneMatches(l.phone, term)) ? 'phone'
      : null
    let snippet: string | null = null
    if (!matchedOn && body.toLowerCase().includes(lower)) {
      matchedOn = 'enquiry'
      snippet = snippetAround(body, term)
    }
    if (!matchedOn) continue
    hits.push({
      id, siteId: l.site_id, siteName: siteName[l.site_id] ?? l.site_id,
      name: name || cleanQuoteSubject(body.split('\n')[0]) || l.email || 'Unnamed lead',
      email: l.email, phone: l.phone,
      kind: isCheckoutLeadMessage(l.message) ? 'checkout' : isQuoteLeadMessage(l.message) ? 'quote' : 'chat',
      matchedOn, snippet, at: asUtcIso(l.created_at),
    })
    seen.add(id)
  }

  // ── site-name matches ──────────────────────────────────────────────────────
  // Typing a site name should surface that site's recent leads. Only applied to
  // rows already fetched — it never widens the query.
  for (const h of hits) {
    if (h.matchedOn === 'name' || h.matchedOn === 'email') continue
    if (h.siteName.toLowerCase().includes(lower)) h.matchedOn = 'site'
  }

  // Most recent first — an agent taking a call wants the live one.
  hits.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
  const truncated = hits.length > RESULT_CAP
  const top = hits.slice(0, RESULT_CAP)

  const groups = groupSameParty(top)
  return {
    hits: top.map((h, i) => ({ ...h, group: groups[i] })),
    truncated,
    tookMs: Date.now() - started,
  }
}
