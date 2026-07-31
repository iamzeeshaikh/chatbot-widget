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
// "30 Jul" — day first, no year. en-GB gives "30 Jul" where en-US gives
// "Jul 30"; day-first reads better in a dense properties list.
const shortDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: PKT_TZ, day: 'numeric', month: 'short',
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

// "30 Jul, 9:43 AM" in Pakistan time — the compact form for narrow columns
// (the properties list, timeline meta, attachment rows). Callers should still
// put the full formatDateTime() value in a title attribute so the year and the
// exact time are one hover away; nothing important should only exist truncated.
export function formatShortDateTime(ts: string | null | undefined): string {
  const d = toDate(ts)
  return d ? `${shortDateFmt.format(d)}, ${timeFmt.format(d)}` : '—'
}

// "30 Jul" on its own, for rows where the time is noise.
export function formatShortDate(ts: string | null | undefined): string {
  const d = toDate(ts)
  return d ? shortDateFmt.format(d) : '—'
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

// ── Pakistan-time calendar math ──────────────────────────────────────────────
// Everything below reasons about Asia/Karachi CALENDAR days, not instants —
// which is what "due today", "overdue" and "tomorrow 10am" have to mean for
// agents sitting in Pakistan. A task due 11pm PKT is due TODAY even though it
// is already tomorrow in UTC terms for part of the evening.
//
// Never reimplement any of this as a hardcoded "+5". It all goes through the
// timezone database via Intl, so the day boundary stays correct even if the
// offset ever changed, and there is exactly one place to fix if it did.

// Karachi-local wall-clock fields of an instant. hourCycle 'h23' is deliberate:
// with hour12:false some ICU builds render midnight as "24", which would push
// the day forward by one when reassembled.
const pktFieldsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: PKT_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
})

function pktFields(d: Date): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pktFieldsFmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  return out
}

// The Karachi-local day of an instant, as a sortable "YYYY-MM-DD".
export function pktDayKey(ts: string | Date | null | undefined): string {
  const d = ts instanceof Date ? ts : toDate(ts)
  return d ? dayKey(d) : ''
}

// How far ahead of UTC Asia/Karachi is at a given instant, in ms.
export function pktOffsetMs(at: Date): number {
  const f = pktFields(at)
  const asIfUtc = Date.UTC(+f.year, +f.month - 1, +f.day, +f.hour, +f.minute, +f.second)
  // Drop sub-second precision on both sides so the difference is a clean offset.
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000
}

// A Karachi wall-clock date + time ("2026-08-01", "23:00") as a real UTC
// instant. Returns null on malformed input rather than an Invalid Date, so
// callers can reject bad form input instead of storing NaN.
export function pktDateTimeToUtc(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? '').trim())
  const t = /^(\d{1,2}):(\d{2})$/.exec((time ?? '').trim())
  if (!d || !t) return null
  const hh = +t[1]
  const mm = +t[2]
  if (hh > 23 || mm > 59) return null

  const naive = Date.UTC(+d[1], +d[2] - 1, +d[3], hh, mm, 0)
  // Two passes. The first is already exact for a fixed-offset zone like PKT;
  // the second only matters if the zone ever gained a DST edge, and costs
  // nothing.
  let instant = naive - pktOffsetMs(new Date(naive))
  instant = naive - pktOffsetMs(new Date(instant))
  const out = new Date(instant)
  return isNaN(out.getTime()) ? null : out.toISOString()
}

// The inverse: an instant split into the Karachi date/time strings a
// <input type="date"> and <input type="time"> expect.
export function pktPartsOf(ts: string | Date | null | undefined): { date: string; time: string } | null {
  const d = ts instanceof Date ? ts : toDate(ts)
  if (!d) return null
  const f = pktFields(d)
  return { date: `${f.year}-${f.month}-${f.day}`, time: `${f.hour}:${f.minute}` }
}

// The Karachi day N days from an instant, as "YYYY-MM-DD". Used for "tomorrow"
// defaults and for the Today/Upcoming split.
export function pktDayKeyOffset(days: number, from: Date = new Date()): string {
  return dayKey(new Date(from.getTime() + days * 24 * 60 * 60 * 1000))
}

// ── Reporting ranges ─────────────────────────────────────────────────────────
// Every reporting boundary is a KARACHI wall-clock instant, converted here.
// chat_logs stores naive-UTC timestamps, so a UTC calendar month silently
// includes five hours of the wrong day at each end: rows between 19:00 and
// 23:59 UTC on 30 June are already 1 July in Karachi, and rows after 19:00 UTC
// on 31 July are already August. `to` is EXCLUSIVE, matching the `.lt()` the
// existing performance and billing queries use.
export interface ReportRange { from: string; to: string }

/** `month` is 1-based: pktMonthRange(2026, 7) is July 2026. */
export function pktMonthRange(year: number, month: number): ReportRange {
  const pad = (n: number) => String(n).padStart(2, '0')
  const nextY = month === 12 ? year + 1 : year
  const nextM = month === 12 ? 1 : month + 1
  const from = pktDateTimeToUtc(`${year}-${pad(month)}-01`, '00:00')
  const to = pktDateTimeToUtc(`${nextY}-${pad(nextM)}-01`, '00:00')
  if (!from || !to) throw new Error(`bad month range ${year}-${month}`)
  return { from, to }
}

/** The Karachi calendar month an instant falls in. */
export function pktMonthOf(at: Date = new Date()): { year: number; month: number } {
  const key = pktDayKey(at) // YYYY-MM-DD in Karachi terms
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }
}

/** The last N Karachi days INCLUDING today, from 00:00 PKT of the first day. */
export function pktLastDaysRange(days: number, now: Date = new Date()): ReportRange {
  const startDay = pktDayKeyOffset(-(days - 1), now)
  const endDay = pktDayKeyOffset(1, now)
  const from = pktDateTimeToUtc(startDay, '00:00')
  const to = pktDateTimeToUtc(endDay, '00:00')
  if (!from || !to) throw new Error('bad day range')
  return { from, to }
}

/** Inclusive Karachi day range from two YYYY-MM-DD strings (a custom range). */
export function pktCustomRange(fromDay: string, toDay: string): ReportRange | null {
  const from = pktDateTimeToUtc(fromDay, '00:00')
  const toExclusive = pktDateTimeToUtc(toDay, '00:00')
  if (!from || !toExclusive) return null
  // The picker's end date is inclusive, so the query bound is the next midnight.
  const to = new Date(new Date(toExclusive).getTime() + 24 * 60 * 60 * 1000).toISOString()
  return { from, to }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** "1–31 July 2026" / "28 June – 4 July 2026" — the period in plain English. */
export function describeRange(range: ReportRange): string {
  const start = toDate(range.from)
  // `to` is exclusive, so the last day shown is the instant before it.
  const endInstant = toDate(range.to)
  if (!start || !endInstant) return '—'
  const end = new Date(endInstant.getTime() - 1000)
  const [sy, sm, sd] = pktDayKey(start).split('-').map(Number)
  const [ey, em, ed] = pktDayKey(end).split('-').map(Number)

  if (sy === ey && sm === em) return `${sd}–${ed} ${MONTH_NAMES[sm - 1]} ${sy}`
  if (sy === ey) return `${sd} ${MONTH_NAMES[sm - 1]} – ${ed} ${MONTH_NAMES[em - 1]} ${sy}`
  return `${sd} ${MONTH_NAMES[sm - 1]} ${sy} – ${ed} ${MONTH_NAMES[em - 1]} ${ey}`
}

/** Every Karachi day in a range, as YYYY-MM-DD, so empty days still get a row. */
export function pktDaysInRange(range: ReportRange): string[] {
  const start = toDate(range.from)
  const endInstant = toDate(range.to)
  if (!start || !endInstant) return []
  const out: string[] = []
  const lastKey = pktDayKey(new Date(endInstant.getTime() - 1000))
  let cursor = new Date(start.getTime())
  for (let guard = 0; guard < 800; guard++) {
    const key = pktDayKey(cursor)
    out.push(key)
    if (key >= lastKey) break
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
  }
  return out
}

/** The Karachi day an instant belongs to — the grouping key for daily rows. */
export function pktDayOf(ts: string): string {
  return pktDayKey(ts)
}

// "Due today, 10:00 AM" / "Overdue — was due Jul 30, 2026, 5:00 PM".
// Kept here so no caller hand-builds a due-date string.
export function formatDueLabel(ts: string | null | undefined, now: Date = new Date()): string {
  const d = toDate(ts)
  if (!d) return 'No due date'
  const key = dayKey(d)
  if (key === dayKey(now)) return `Today, ${timeFmt.format(d)}`
  if (key === pktDayKeyOffset(1, now)) return `Tomorrow, ${timeFmt.format(d)}`
  if (key === pktDayKeyOffset(-1, now)) return `Yesterday, ${timeFmt.format(d)}`
  // Short form: due dates sit in narrow task rows, and "Jul 25, 2026, 3:00 PM"
  // is too long for one. The full value belongs in a title attribute.
  return `${shortDateFmt.format(d)}, ${timeFmt.format(d)}`
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
