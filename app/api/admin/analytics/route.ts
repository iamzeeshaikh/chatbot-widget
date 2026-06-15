import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { MODE_ROLE } from '@/lib/mode'
import { CONTACT_ROLE } from '@/lib/visitor'

export const dynamic = 'force-dynamic'

type Range = 'hourly' | 'daily' | 'weekly' | 'monthly'

interface Bucket { start: number; end: number; label: string }

// Build the time buckets for a range (oldest → newest), ending "now".
function buildBuckets(range: Range): Bucket[] {
  const now = new Date()
  const buckets: Bucket[] = []

  if (range === 'hourly') {
    const base = new Date(now); base.setMinutes(0, 0, 0)
    for (let i = 23; i >= 0; i--) {
      const start = new Date(base); start.setHours(base.getHours() - i)
      const end = new Date(start); end.setHours(start.getHours() + 1)
      buckets.push({ start: start.getTime(), end: end.getTime(), label: `${String(start.getHours()).padStart(2, '0')}:00` })
    }
  } else if (range === 'daily') {
    const base = new Date(now); base.setHours(0, 0, 0, 0)
    for (let i = 29; i >= 0; i--) {
      const start = new Date(base); start.setDate(base.getDate() - i)
      const end = new Date(start); end.setDate(start.getDate() + 1)
      buckets.push({ start: start.getTime(), end: end.getTime(), label: start.toLocaleDateString('en', { month: 'short', day: 'numeric' }) })
    }
  } else if (range === 'weekly') {
    const base = new Date(now); base.setHours(0, 0, 0, 0)
    const dow = base.getDay() === 0 ? 6 : base.getDay() - 1 // Monday start
    base.setDate(base.getDate() - dow)
    for (let i = 11; i >= 0; i--) {
      const start = new Date(base); start.setDate(base.getDate() - i * 7)
      const end = new Date(start); end.setDate(start.getDate() + 7)
      buckets.push({ start: start.getTime(), end: end.getTime(), label: start.toLocaleDateString('en', { month: 'short', day: 'numeric' }) })
    }
  } else {
    const base = new Date(now); base.setDate(1); base.setHours(0, 0, 0, 0)
    for (let i = 11; i >= 0; i--) {
      const start = new Date(base.getFullYear(), base.getMonth() - i, 1)
      const end = new Date(base.getFullYear(), base.getMonth() - i + 1, 1)
      buckets.push({ start: start.getTime(), end: end.getTime(), label: start.toLocaleDateString('en', { month: 'short', year: '2-digit' }) })
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
  const startISO = new Date(buckets[0].start).toISOString()

  // Empty scope (standard member with no sites) → nothing to show.
  if (allowed.length === 0) {
    return NextResponse.json({ range, points: buckets.map((b) => ({ label: b.label, visitors: 0, chats: 0 })) })
  }

  const [visRes, logRes] = await Promise.all([
    supabase.from('active_visitors').select('created_at, site_id').in('site_id', allowed).gte('created_at', startISO),
    supabase.from('chat_logs').select('created_at, site_id, session_id, role').in('site_id', allowed).gte('created_at', startISO).limit(20000),
  ])

  const visitorCounts = new Array(buckets.length).fill(0)
  for (const v of visRes.data ?? []) {
    const idx = bucketIndex(buckets, new Date(v.created_at).getTime())
    if (idx >= 0) visitorCounts[idx]++
  }

  // New chats = a session's earliest (non-control) message within the window.
  const firstSeen: Record<string, number> = {}
  for (const l of logRes.data ?? []) {
    if (l.role === MODE_ROLE || l.role === CONTACT_ROLE) continue
    const ts = new Date(l.created_at).getTime()
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
