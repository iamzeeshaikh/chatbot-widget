// Single source of truth for displaying timestamps in the dashboard.
//
// Two things bite us here and BOTH are handled inside these helpers so callers
// can't get it wrong:
//
//  1. Naive timestamps. Some chat_logs / active_visitors timestamps are stored
//     without a timezone (naive UTC). `new Date("2026-06-19 17:14:00")` parses
//     that as LOCAL time, double-shifting the result. We normalise to UTC first
//     (append 'Z' when there's no offset — same rule as asUtcIso) BEFORE any
//     formatting.
//  2. Browser timezone. toLocaleTimeString() formats in whatever timezone the
//     agent's browser happens to be in. We pin everything to Pakistan Standard
//     Time (Asia/Karachi, UTC+5, no DST) with 12-hour AM/PM, so every agent sees
//     the same correct local time regardless of where they are.

import { asUtcIso } from './visitor'

export const PKT_TZ = 'Asia/Karachi'

// Normalise any (possibly naive) timestamp to a real Date in UTC terms. Returns
// null for missing/invalid input so callers can fall back to a dash.
function toDate(ts: string | null | undefined): Date | null {
  if (!ts) return null
  const d = new Date(asUtcIso(ts) as string)
  return isNaN(d.getTime()) ? null : d
}

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PKT_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
})
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PKT_TZ, year: 'numeric', month: 'short', day: 'numeric',
})
const dateLongFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PKT_TZ, weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
})
// Sortable Karachi-local day key ("2026-06-19"), used for Today/Yesterday logic.
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PKT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
})

// "10:14 PM" in Pakistan time.
export function formatTime(ts: string | null | undefined): string {
  const d = toDate(ts)
  return d ? timeFmt.format(d) : '—'
}

// "Jun 19, 2026" in Pakistan time.
export function formatDate(ts: string | null | undefined): string {
  const d = toDate(ts)
  return d ? dateFmt.format(d) : '—'
}

// "Jun 19, 2026, 10:14 PM" in Pakistan time.
export function formatDateTime(ts: string | null | undefined): string {
  const d = toDate(ts)
  return d ? `${dateFmt.format(d)}, ${timeFmt.format(d)}` : '—'
}

// "2h ago" / "3d ago". Timezone-independent (it's a duration), but it still
// goes through toDate so a naive-UTC timestamp isn't read as local time and
// reported hours off.
export function timeAgo(ts: string | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(days / 365)}y ago`
}

// The Karachi-local calendar day of an instant, as "YYYY-MM-DD".
function dayKey(d: Date): string {
  return dayKeyFmt.format(d)
}

// Date-divider label for the message view. Keeps the friendly "Today" /
// "Yesterday" labels but always appends the real date, and shows a full
// weekday+date for older days — all computed in Asia/Karachi, not the browser's
// local day (so the divider flips at Pakistan midnight, not the agent's).
export function dateDividerLabel(ts: string | null | undefined): string {
  const d = toDate(ts)
  if (!d) return '—'
  const key = dayKey(d)
  const now = new Date()
  const todayKey = dayKey(now)
  // UTC+5 has no DST, so subtracting 24h and re-reading the Karachi day is exact.
  const yesterdayKey = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  if (key === todayKey) return `Today · ${dateFmt.format(d)}`
  if (key === yesterdayKey) return `Yesterday · ${dateFmt.format(d)}`
  return dateLongFmt.format(d)
}
