import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages, warnIfCapped } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { findBurstKeys } from '@/lib/botfilter'
import { buildBuckets, isRange, tally, toPktMs, PKT_MS, type Range } from '@/lib/analytics'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// "That point on the chart — which sites was it?"
//
// The Overview chart answers how the whole workspace did over time. The
// question it always raises next is which of the sites the number came from,
// and that used to mean reading the chart, then the site tiles, then doing the
// arithmetic in your head for a month you can no longer select.
//
// So: click a point, get that bucket broken down per site — visits, distinct
// people, chats, and how many of those visits an agent actually picked up.
//
// ── Why it cannot drift from the chart ──────────────────────────────────────
// It calls the SAME buildBuckets() and the SAME tally() the chart does
// (lib/analytics.ts), on the same rules, with the bot-burst set computed across
// every row in the window rather than per site. Per-site columns therefore add
// up to the point that was clicked — apart from Unique, which deliberately does
// not: one person who visited two sites is one person on the chart and one on
// each of their rows, and a breakdown that "fixed" that would be lying about
// both. The response says so rather than leaving it to be discovered.
//
// Only ONE bucket is fetched, not the whole range: an hour, a day, a week or a
// month of rows instead of twelve months of them, which is why this can afford
// to be exact where the chart has to be cached.
const VISITOR_ROW_CAP = 60000
const AGENT_ROW_CAP = 60000
const CHAT_ROW_CAP = 20000

interface SiteRow {
  siteId: string
  name: string
  visits: number
  unique: number
  chats: number
  picked: number
  notPicked: number
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const allowed = Array.from(await siteScope(member))
  if (allowed.length === 0) return NextResponse.json({ sites: [], label: '', total: null })

  const rangeParam = req.nextUrl.searchParams.get('range')
  const range: Range = isRange(rangeParam) ? rangeParam : 'daily'
  const buckets = buildBuckets(range)

  const idx = Number(req.nextUrl.searchParams.get('bucket') ?? '-1')
  if (!Number.isInteger(idx) || idx < 0 || idx >= buckets.length) {
    return NextResponse.json({ error: 'Unknown point on the chart.' }, { status: 400 })
  }
  const bucket = buckets[idx]

  // Bucket bounds are in PKT-epoch space; the DB stores UTC.
  const fromISO = new Date(bucket.start - PKT_MS).toISOString()
  const toISO = new Date(bucket.end - PKT_MS).toISOString()

  const [visRows, agentRows, chatRows, siteRows] = await Promise.all([
    fetchAllPages<{ created_at: string; user_agent: string | null; session_id: string; page_url: string | null; site_id: string }>(
      () => supabase.from('active_visitors').select('created_at, user_agent, session_id, page_url, site_id')
        .in('site_id', allowed).gte('created_at', fromISO).lt('created_at', toISO)
        .order('created_at', { ascending: true }),
      VISITOR_ROW_CAP),
    fetchAllPages<{ session_id: string }>(
      () => supabase.from('chat_logs').select('session_id').in('site_id', allowed)
        .eq('role', 'admin').gte('created_at', fromISO).lt('created_at', toISO)
        .order('created_at', { ascending: true }),
      AGENT_ROW_CAP),
    fetchAllPages<{ created_at: string; session_id: string; message: string; site_id: string }>(
      () => supabase.from('chat_logs').select('created_at, session_id, message, site_id')
        .in('site_id', allowed).in('role', ['user', 'visitor'])
        .gte('created_at', fromISO).lt('created_at', toISO)
        .order('created_at', { ascending: true }),
      CHAT_ROW_CAP),
    supabase.from('sites').select('site_id, name'),
  ])
  warnIfCapped('analytics breakdown: active_visitors', visRows.length, VISITOR_ROW_CAP)
  warnIfCapped('analytics breakdown: agent messages', agentRows.length, AGENT_ROW_CAP)
  warnIfCapped('analytics breakdown: visitor messages', chatRows.length, CHAT_ROW_CAP)

  const agentSessions = new Set<string>()
  for (const l of agentRows) agentSessions.add(l.session_id)

  // Computed over the whole bucket, then applied per site — see the note above.
  const bursts = findBurstKeys(visRows.map((v) => ({ userAgent: v.user_agent, tsMs: toPktMs(v.created_at) })))

  const names = new Map<string, string>()
  for (const s of siteRows.data ?? []) names.set(s.site_id, s.name ?? s.site_id)

  const one = [bucket]
  const sites: SiteRow[] = []
  for (const siteId of allowed) {
    const v = visRows.filter((r) => r.site_id === siteId)
    const c = chatRows.filter((r) => r.site_id === siteId)
    if (v.length === 0 && c.length === 0) continue      // a site with nothing to say
    const t = tally(one, v, agentSessions, c, bursts)
    sites.push({
      siteId,
      name: names.get(siteId) ?? siteId,
      visits: t.visitors[0], unique: t.unique[0], chats: t.chats[0],
      picked: t.picked[0], notPicked: t.notPicked[0],
    })
  }
  sites.sort((a, b) => b.visits - a.visits || b.chats - a.chats)

  // The workspace total for the same bucket — so the panel can show what the
  // clicked point actually was, next to the rows that make it up.
  const total = tally(one, visRows, agentSessions, chatRows, bursts)

  return NextResponse.json({
    range,
    bucket: idx,
    label: bucket.label,
    from: new Date(bucket.start - PKT_MS).toISOString(),
    to: new Date(bucket.end - PKT_MS).toISOString(),
    sites,
    total: {
      visits: total.visitors[0], unique: total.windowUnique, chats: total.chats[0],
      picked: total.picked[0], notPicked: total.notPicked[0],
    },
  })
}
