import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { asUtcIso } from '@/lib/visitor'
import { PKT_OFFSET_HOURS } from '@/lib/botschedule'

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
      buckets.push({ start: start.getTime(), end: end.getTime(), label: `${String(start.getUTCHours()).padStart(2, '0')}:00` })
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
    return NextResponse.json({ range, points: buckets.map((b) => ({ label: b.label, visitors: 0, chats: 0 })) })
  }

  const [visRes, logRes] = await Promise.all([
    supabase.from('active_visitors').select('created_at, site_id').in('site_id', allowed).gte('created_at', startISO),
    supabase.from('chat_logs').select('created_at, site_id, session_id, role, message').in('site_id', allowed).gte('created_at', startISO).limit(20000),
  ])

  // Visitors = widget sessions started in the bucket (the ping route upserts
  // exactly one active_visitors row per session, created_at = session start).
  const visitorCounts = new Array(buckets.length).fill(0)
  for (const v of visRes.data ?? []) {
    const idx = bucketIndex(buckets, toPktMs(v.created_at))
    if (idx >= 0) visitorCounts[idx]++
  }

  // New chats = a session's FIRST genuine visitor message. Counting any
  // message here (the old logic) made an agent's follow-up on a weeks-old
  // conversation register as a brand-new chat that day — which is how a day
  // with 1 visitor could show 19 "chats". Restricting to visitor-role rows
  // also inherently skips every control row (mode, reply_author, …).
  const firstSeen: Record<string, number> = {}
  for (const l of logRes.data ?? []) {
    const role = String(l.role || '').toLowerCase()
    if (role !== 'user' && role !== 'visitor') continue
    if (l.message === '(session started)') continue
    const ts = toPktMs(l.created_at)
    if (firstSeen[l.session_id] === undefined || ts < firstSeen[l.session_id]) firstSeen[l.session_id] = ts
  }
  const chatCounts = new Array(buckets.length).fill(0)
  for (const ts of Object.values(firstSeen)) {
    const idx = bucketIndex(buckets, ts)
    if (idx >= 0) chatCounts[idx]++
  }

  const points = buckets.map((b, i) => ({ label: b.label, visitors: visitorCounts[i], chats: chatCounts[i] }))
  return NextResponse.json({ range, points })
}
