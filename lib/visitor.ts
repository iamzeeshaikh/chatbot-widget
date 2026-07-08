// Visitor detail storage helpers.
//
// A genuinely "live" visitor session is recent. Sessions whose start (created_at)
// is older than this are treated as stale and never shown as live — regardless of
// last_seen — which caps "on site" time and prevents an "active now" row from
// linking to an old conversation. Used by both the API and the dashboard.
export const LIVE_MAX_ON_SITE_MS = 3 * 60 * 60 * 1000 // 3 hours

// Reserved site_id for agent duty-hours heartbeat rows in active_visitors (no
// DDL). Every visitor-facing query filters by real site ids, so these rows can
// never appear as visitors.
export const AGENT_DUTY_SITE = 'zeeops-agent-duty'

// active_visitors timestamps are stored without a timezone (naive UTC). Append a
// 'Z' so `new Date(...)` parses them as UTC in any browser timezone, instead of
// misreading them as local time (which skewed "on site" / "active now" by hours).
export function asUtcIso(ts: string | null | undefined): string | null {
  if (!ts) return ts ?? null
  return /[Z]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + 'Z'
}
//
// We have no DDL access, so the active_visitors row packs everything we can't
// give a dedicated column into the single `page_url` text field as a small JSON
// blob. This module is the one place that knows that shape so the ping writer
// and the readers (live list + visitor detail) stay in sync.
//
// Packed shape: { u, t, r, v, ip, h }
//   u  = current page url
//   t  = current page title
//   r  = original (first) referrer
//   v  = visit count (page loads, persisted client-side per browser/site)
//   ip = visitor IP (captured server-side from x-forwarded-for)
//   h  = page history: [{ u, t, ts }] in chronological order (oldest first)
//
// Legacy rows may store a plain URL string instead of JSON — unpack handles both.

// Agent-entered contact details (name/email/phone/notes) are persisted the same
// way conversation mode is: as a control row in chat_logs (role = CONTACT_ROLE,
// message = JSON). The current details are the most recent such row per session.
// Both the conversations list and the message view filter this role out so it
// never shows up as a chat message.
export const CONTACT_ROLE = 'contact'

export interface VisitorContact {
  name: string
  email: string
  phone: string
  notes: string
}

export const EMPTY_CONTACT: VisitorContact = { name: '', email: '', phone: '', notes: '' }

export function parseContact(message: string | null | undefined): VisitorContact {
  if (!message) return { ...EMPTY_CONTACT }
  try {
    const o = JSON.parse(message)
    return {
      name: typeof o.name === 'string' ? o.name : '',
      email: typeof o.email === 'string' ? o.email : '',
      phone: typeof o.phone === 'string' ? o.phone : '',
      notes: typeof o.notes === 'string' ? o.notes : '',
    }
  } catch {
    return { ...EMPTY_CONTACT }
  }
}

// Conversation tags (e.g. "hot lead", "follow up") are persisted the same way
// as mode/contact: a control row in chat_logs (role = TAGS_ROLE, message = a
// JSON string array). The current tags are the most recent such row per session.
// Filtered out of the message/conversation/analytics views like other controls.
export const TAGS_ROLE = 'tags'

// Normalise a tag: trimmed, collapsed whitespace, capped length.
export function normalizeTag(raw: string): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

// Clean + de-duplicate (case-insensitive) a list of tags, capped to a sane max.
export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of list) {
    const tag = normalizeTag(typeof t === 'string' ? t : '')
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
    if (out.length >= 20) break
  }
  return out
}

export function parseTags(message: string | null | undefined): string[] {
  if (!message) return []
  try {
    return normalizeTags(JSON.parse(message))
  } catch {
    return []
  }
}

export interface PageVisit {
  u: string | null
  t: string | null
  ts: string
}

export interface UnpackedVisitor {
  page_url: string | null
  page_title: string | null
  referrer: string | null
  visits: number
  ip: string | null
  history: PageVisit[]
}

// Cap stored history so the packed blob can't grow without bound.
export const MAX_HISTORY = 40

export function unpackVisitor(raw: string | null): UnpackedVisitor {
  if (!raw) return { page_url: null, page_title: null, referrer: null, visits: 1, ip: null, history: [] }
  if (raw[0] === '{') {
    try {
      const o = JSON.parse(raw)
      return {
        page_url: o.u ?? null,
        page_title: o.t ?? null,
        referrer: o.r ?? null,
        visits: typeof o.v === 'number' ? o.v : (parseInt(o.v, 10) || 1),
        ip: o.ip ?? null,
        history: Array.isArray(o.h) ? o.h : [],
      }
    } catch { /* fall through to legacy */ }
  }
  return { page_url: raw, page_title: null, referrer: null, visits: 1, ip: null, history: [] }
}

export function packVisitor(v: {
  page_url: string | null
  page_title: string | null
  referrer: string | null
  visits: number
  ip: string | null
  history: PageVisit[]
}): string {
  return JSON.stringify({
    u: v.page_url,
    t: v.page_title,
    r: v.referrer,
    v: v.visits,
    ip: v.ip,
    h: v.history.slice(-MAX_HISTORY),
  })
}

// Append a page to history only when it's a new page (different URL from the
// last one recorded), so repeated pings on the same page don't bloat the path.
export function appendHistory(history: PageVisit[], url: string | null, title: string | null): PageVisit[] {
  if (!url) return history
  const last = history[history.length - 1]
  if (last && last.u === url) return history
  return [...history, { u: url, t: title, ts: new Date().toISOString() }].slice(-MAX_HISTORY)
}
