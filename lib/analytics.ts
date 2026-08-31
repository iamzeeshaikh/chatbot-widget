// The time buckets behind the Overview chart, and the rules for counting into
// them.
//
// It lives here rather than in the route because TWO endpoints now answer from
// it: the chart itself, and the per-site breakdown a click on the chart opens.
// A second copy of "what counts as a visit, a unique person, a picked-up chat"
// would drift on the first fix that landed in only one of them — which is this
// project's oldest recurring bug — and the drift would show as a breakdown
// whose column totals disagree with the point the user clicked on.

import { asUtcIso, unpackVisitor } from './visitor'
import { PKT_OFFSET_HOURS } from './botschedule'
import { burstKey } from './botfilter'

export type Range = 'hourly' | 'daily' | 'weekly' | 'monthly'

export interface Bucket { start: number; end: number; label: string }

export const RANGES: Range[] = ['hourly', 'daily', 'weekly', 'monthly']

export function isRange(v: string | null): v is Range {
  return !!v && (RANGES as string[]).includes(v)
}

// All bucketing happens in Pakistan time, like every other dashboard timestamp.
// We work in "PKT epoch" space: UTC ms shifted by +5h, then read/derive wall
// time with the UTC accessors (same trick as lib/botschedule.pktParts). A day
// bucket therefore runs midnight–midnight PKT, not UTC.
export const PKT_MS = PKT_OFFSET_HOURS * 60 * 60 * 1000

// chat_logs/active_visitors timestamps are naive UTC — normalise via asUtcIso
// (parsing them raw would use the server's local zone) before shifting to PKT.
export const toPktMs = (ts: string) => new Date(asUtcIso(ts) ?? ts).getTime() + PKT_MS

// Build the time buckets for a range (oldest → newest), ending "now".
export function buildBuckets(range: Range): Bucket[] {
  const now = new Date(Date.now() + PKT_MS)
  const buckets: Bucket[] = []
  const label = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en', { ...opts, timeZone: 'UTC' })

  if (range === 'hourly') {
    const base = new Date(now); base.setUTCMinutes(0, 0, 0)
    for (let i = 23; i >= 0; i--) {
      const start = new Date(base); start.setUTCHours(base.getUTCHours() - i)
      const end = new Date(start); end.setUTCHours(start.getUTCHours() + 1)
      // 12-hour PKT labels ("9 PM"), matching every other dashboard timestamp.
      const h = start.getUTCHours()
      buckets.push({ start: start.getTime(), end: end.getTime(), label: `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}` })
    }
  } else if (range === 'daily') {
    const base = new Date(now); base.setUTCHours(0, 0, 0, 0)
    for (let i = 29; i >= 0; i--) {
      const start = new Date(base); start.setUTCDate(base.getUTCDate() - i)
      const end = new Date(start); end.setUTCDate(start.getUTCDate() + 1)
      buckets.push({ start: start.getTime(), end: end.getTime(), label: label(start, { month: 'short', day: 'numeric' }) })
    }
  } else if (range === 'weekly') {
    const base = new Date(now); base.setUTCHours(0, 0, 0, 0)
    const dow = base.getUTCDay() === 0 ? 6 : base.getUTCDay() - 1 // Monday start
    base.setUTCDate(base.getUTCDate() - dow)
    for (let i = 11; i >= 0; i--) {
      const start = new Date(base); start.setUTCDate(base.getUTCDate() - i * 7)
      const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7)
      buckets.push({ start: start.getTime(), end: end.getTime(), label: label(start, { month: 'short', day: 'numeric' }) })
    }
  } else {
    const base = new Date(now)
    for (let i = 11; i >= 0; i--) {
      const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1))
      const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i + 1, 1))
      buckets.push({ start: start.getTime(), end: end.getTime(), label: label(start, { month: 'short', year: '2-digit' }) })
    }
  }
  return buckets
}

export function bucketIndex(buckets: Bucket[], ts: number): number {
  for (let i = 0; i < buckets.length; i++) if (ts >= buckets[i].start && ts < buckets[i].end) return i
  return -1
}

export interface VisitorRow {
  created_at: string; user_agent: string | null; session_id: string; page_url: string | null
  site_id?: string
}
export interface VisitorMessageRow { created_at: string; session_id: string; message: string; site_id?: string }

export interface Tally {
  visitors: number[]; unique: number[]; picked: number[]; notPicked: number[]; chats: number[]
  /** Distinct people across the WHOLE window — not the sum of the per-bucket
   *  uniques, because one person visiting in three months is one person. */
  windowUnique: number
}

/**
 * Count rows into buckets.
 *
 * `bursts` is passed in rather than computed here on purpose: bot bursts are
 * detected across every row in the window (dozens of sessions sharing a
 * user-agent within an hour), so computing them per site would let a flood
 * split across sites slip through and make the breakdown disagree with the
 * chart it came from.
 */
export function tally(
  buckets: Bucket[],
  visRows: VisitorRow[],
  agentSessions: Set<string>,
  chatRows: VisitorMessageRow[],
  bursts: Set<string>,
): Tally {
  const visitors = new Array(buckets.length).fill(0)
  const picked = new Array(buckets.length).fill(0)
  const notPicked = new Array(buckets.length).fill(0)
  const uniqueSets: Set<string>[] = buckets.map(() => new Set<string>())
  const windowUnique = new Set<string>()
  const countedSessions = new Set<string>() // one visitor row per session, but guard anyway

  for (const v of visRows) {
    const ts = toPktMs(v.created_at)
    if (bursts.has(burstKey(v.user_agent, ts))) continue
    const idx = bucketIndex(buckets, ts)
    if (idx < 0) continue
    visitors[idx]++
    if (!countedSessions.has(v.session_id)) {
      countedSessions.add(v.session_id)
      // Sessions an agent ENGAGED — any 'admin' message, proactive greeting OR
      // a reply. picked + notPicked === visitors, by construction.
      if (agentSessions.has(v.session_id)) picked[idx]++
      else notPicked[idx]++
    }
    // Unique people: the widget's persistent visitor id, falling back to IP and
    // then the session, for rows recorded before vid existed.
    const { vid, ip } = unpackVisitor(v.page_url)
    const key = vid || ip || v.session_id
    uniqueSets[idx].add(key)
    windowUnique.add(key)
  }

  // New chats = a session's FIRST genuine visitor message. Counting any message
  // made an agent's follow-up on a weeks-old conversation register as a
  // brand-new chat that day — which is how a day with 1 visitor showed 19
  // "chats".
  const firstSeen: Record<string, number> = {}
  for (const l of chatRows) {
    if (l.message === '(session started)') continue
    const ts = toPktMs(l.created_at)
    if (firstSeen[l.session_id] === undefined || ts < firstSeen[l.session_id]) firstSeen[l.session_id] = ts
  }
  const chats = new Array(buckets.length).fill(0)
  for (const ts of Object.values(firstSeen)) {
    const idx = bucketIndex(buckets, ts)
    if (idx >= 0) chats[idx]++
  }

  return { visitors, unique: uniqueSets.map((s) => s.size), picked, notPicked, chats, windowUnique: windowUnique.size }
}
