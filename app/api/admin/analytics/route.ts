import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages, warnIfCapped } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { asUtcIso, unpackVisitor } from '@/lib/visitor'
import { PKT_OFFSET_HOURS } from '@/lib/botschedule'
import { findBurstKeys, burstKey } from '@/lib/botfilter'

export const dynamic = 'force-dynamic'

type Range = 'hourly' | 'daily' | 'weekly' | 'monthly'

interface Bucket { start: number; end: number; label: string }

// All bucketing happens in Pakistan time, like every other dashboard timestamp.
// We work in "PKT epoch" space: UTC ms shifted by +5h, then read/derive wall
// time with the UTC accessors (same trick as lib/botschedule.pktParts). A day
// bucket therefore runs midnight–midnight PKT, not UTC.
const PKT_MS = PKT_OFFSET_HOURS * 60 * 60 * 1000
// chat_logs/active_visitors timestamps are naive UTC — normalise via asUtcIso
// (parsing them raw would use the server's local zone) before shifting to PKT.
const toPktMs = (ts: string) => new Date(asUtcIso(ts) ?? ts).getTime() + PKT_MS

// Build the time buckets for a range (oldest → newest), ending "now".
function buildBuckets(range: Range): Bucket[] {
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

function bucketIndex(buckets: Bucket[], ts: number): number {
  for (let i = 0; i < buckets.length; i++) if (ts >= buckets[i].start && ts < buckets[i].end) return i
  return -1
}

// Row caps. Sized against the widest range this endpoint serves — 12 months —
// measured on 2026-08-13 across the 24 packaging sites: 30.8k visitor rows,
// 25.1k agent messages, 1.3k visitor messages. Roughly 2x headroom each.
// They are a backstop, not a budget: the role filters below are what keep the
// real numbers small. Raise one only together with the reason it was hit.
const VISITOR_ROW_CAP = 60000
const AGENT_ROW_CAP = 60000
const CHAT_ROW_CAP = 20000


export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ points: [] }, { status: 401 })
  const scope = await siteScope(member)
  const allowed = Array.from(scope)

  const range = (req.nextUrl.searchParams.get('range') as Range) || 'daily'
  const buckets = buildBuckets(['hourly', 'daily', 'weekly', 'monthly'].includes(range) ? range : 'daily')
  // Bucket starts are in PKT-epoch space; convert back to real UTC for the query.
  const startISO = new Date(buckets[0].start - PKT_MS).toISOString()

  // Empty scope (standard member with no sites) → nothing to show.
  if (allowed.length === 0) {
    return NextResponse.json({ range, points: buckets.map((b) => ({ label: b.label, visitors: 0, unique: 0, chats: 0 })), totalUnique: 0 })
  }

  // Paginated (fetchAllPages): a plain query silently tops out at 1000 rows,
  // which starved the chart of every day after the first ~1000 visitors.
  //
  // ── Fetch ONLY the roles this chart reads ────────────────────────────────
  // `logRows` used to be every chat_logs row in the window, of which the chart
  // reads exactly two kinds: 'admin' (did an agent engage?) and 'user'/'visitor'
  // (when did this chat start?). Everything else — assignment, reply_author,
  // mode, tags, lead_capture, the crm_* rows — was fetched and thrown away.
  //
  // On 2026-08-13 that was 39,000 of the 61,700 rows in a 30-day packaging
  // window: 63% waste, and enough to push the fetch past its 50,000-row cap.
  // Because the query is ordered OLDEST FIRST, the cap dropped the NEWEST rows,
  // so Picked and Chats read 0 for the last four days while Visits — a separate,
  // smaller query — stayed correct. A chart that is right until it silently
  // isn't is worse than one that fails loudly, hence warnIfCapped below.
  //
  // Splitting the two also drops `message` from the agent query, which is the
  // bulky column and was never read for those rows.
  const [visRows, agentRows, chatRows] = await Promise.all([
    fetchAllPages<{ created_at: string; user_agent: string | null; session_id: string; page_url: string | null }>(
      () => supabase.from('active_visitors').select('created_at, user_agent, session_id, page_url').in('site_id', allowed)
        .gte('created_at', startISO).order('created_at', { ascending: true }),
      VISITOR_ROW_CAP),
    fetchAllPages<{ session_id: string }>(
      () => supabase.from('chat_logs').select('session_id').in('site_id', allowed)
        .eq('role', 'admin').gte('created_at', startISO).order('created_at', { ascending: true }),
      AGENT_ROW_CAP),
    fetchAllPages<{ created_at: string; session_id: string; message: string }>(
      () => supabase.from('chat_logs').select('created_at, session_id, message').in('site_id', allowed)
        .in('role', ['user', 'visitor']).gte('created_at', startISO).order('created_at', { ascending: true }),
      CHAT_ROW_CAP),
  ])
  warnIfCapped('analytics: active_visitors', visRows.length, VISITOR_ROW_CAP)
  warnIfCapped('analytics: agent messages', agentRows.length, AGENT_ROW_CAP)
  warnIfCapped('analytics: visitor messages', chatRows.length, CHAT_ROW_CAP)

  // Visitors = widget sessions started in the bucket (the ping route upserts
  // exactly one active_visitors row per session, created_at = session start).
  // Bot bursts — dozens of sessions with the exact same user-agent in one hour
  // (e.g. the 557-row flood on Jul 4 2026) — are excluded so the line shows
  // real humans (see lib/botfilter.ts).
  // Sessions an agent ENGAGED — any 'admin' message, proactive greeting OR a
  // reply. This mirrors the Performance tab's "picked up": of the visitors that
  // came, how many the team served vs ignored (picked + notPicked === visitors).
  const agentSessions = new Set<string>()
  for (const l of agentRows) agentSessions.add(l.session_id)

  const visStamped = visRows.map((v) => ({ v, userAgent: v.user_agent, tsMs: toPktMs(v.created_at) }))
  const bursts = findBurstKeys(visStamped)
  const visitorCounts = new Array(buckets.length).fill(0)
  const pickedCounts = new Array(buckets.length).fill(0)
  const notPickedCounts = new Array(buckets.length).fill(0)
  const countedSessions = new Set<string>() // one visitor row per session, but guard anyway
  // Unique people per bucket: keyed by the widget's persistent visitor id
  // (falling back to IP, then session, for rows recorded before vid existed).
  const uniqueSets: Set<string>[] = buckets.map(() => new Set())
  const windowUnique = new Set<string>()
  for (const s of visStamped) {
    if (bursts.has(burstKey(s.userAgent, s.tsMs))) continue
    const idx = bucketIndex(buckets, s.tsMs)
    if (idx < 0) continue
    visitorCounts[idx]++
    if (!countedSessions.has(s.v.session_id)) {
      countedSessions.add(s.v.session_id)
      if (agentSessions.has(s.v.session_id)) pickedCounts[idx]++
      else notPickedCounts[idx]++
    }
    const { vid, ip } = unpackVisitor(s.v.page_url)
    const key = vid || ip || s.v.session_id
    uniqueSets[idx].add(key)
    windowUnique.add(key)
  }

  // New chats = a session's FIRST genuine visitor message. Counting any
  // message here (the old logic) made an agent's follow-up on a weeks-old
  // conversation register as a brand-new chat that day — which is how a day
  // with 1 visitor could show 19 "chats". The visitor-role filter is now in the
  // query itself, which also skips every control row (mode, reply_author, …).
  const firstSeen: Record<string, number> = {}
  for (const l of chatRows) {
    if (l.message === '(session started)') continue
    const ts = toPktMs(l.created_at)
    if (firstSeen[l.session_id] === undefined || ts < firstSeen[l.session_id]) firstSeen[l.session_id] = ts
  }
  const chatCounts = new Array(buckets.length).fill(0)
  for (const ts of Object.values(firstSeen)) {
    const idx = bucketIndex(buckets, ts)
    if (idx >= 0) chatCounts[idx]++
  }

  const points = buckets.map((b, i) => ({ label: b.label, visitors: visitorCounts[i], unique: uniqueSets[i].size, chats: chatCounts[i], picked: pickedCounts[i], notPicked: notPickedCounts[i] }))
  return NextResponse.json({ range, points, totalUnique: windowUnique.size })
}
