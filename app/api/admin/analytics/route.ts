import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages, warnIfCapped } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { findBurstKeys } from '@/lib/botfilter'
import { buildBuckets, isRange, tally, toPktMs, PKT_MS, type Range } from '@/lib/analytics'

export const dynamic = 'force-dynamic'

// Row caps. Sized against the widest range this endpoint serves — 12 months —
// measured on 2026-08-13 across the 24 packaging sites: 30.8k visitor rows,
// 25.1k agent messages, 1.3k visitor messages. Roughly 2x headroom each.
// They are a backstop, not a budget: the role filters below are what keep the
// real numbers small. Raise one only together with the reason it was hit.
const VISITOR_ROW_CAP = 60000
const AGENT_ROW_CAP = 60000
const CHAT_ROW_CAP = 20000


// A short-lived answer cache, per instance.
//
// The Monthly range is twelve months of visitor rows and chat rows folded in
// Node — seconds of work on a Micro Postgres, every time anybody presses the
// button. The numbers behind it move by minutes, not by seconds, so serving a
// recent answer is not a compromise. The key carries the member's own site
// scope: two members with different sites must never share an entry.
const ANSWER_TTL_MS: Record<Range, number> = {
  hourly: 60_000,      // the live end of the chart — keep it fresh
  daily: 120_000,
  weekly: 300_000,
  monthly: 600_000,    // the slowest and the least volatile
}
const answers = new Map<string, { at: number; body: unknown }>()

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ points: [] }, { status: 401 })
  const scope = await siteScope(member)
  const allowed = Array.from(scope)

  const rangeParam = req.nextUrl.searchParams.get('range')
  const range: Range = isRange(rangeParam) ? rangeParam : 'daily'
  const cacheKey = `${member.workspace}|${range}|${[...allowed].sort().join(',')}`
  const hit = answers.get(cacheKey)
  if (hit && Date.now() - hit.at < (ANSWER_TTL_MS[range] ?? 120_000)) {
    return NextResponse.json(hit.body)
  }
  const buckets = buildBuckets(range)
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

  // Counting itself lives in lib/analytics.ts, shared with the per-site
  // breakdown a click on the chart opens — see the note there for why.
  //
  // Bot bursts — dozens of sessions with the exact same user-agent in one hour
  // (e.g. the 557-row flood on Jul 4 2026) — are excluded so the line shows
  // real humans (lib/botfilter.ts), and the burst set is computed here, across
  // every row in the window, so both endpoints exclude the same sessions.
  const agentSessions = new Set<string>()
  for (const l of agentRows) agentSessions.add(l.session_id)

  const bursts = findBurstKeys(visRows.map((v) => ({ userAgent: v.user_agent, tsMs: toPktMs(v.created_at) })))
  const counts = tally(buckets, visRows, agentSessions, chatRows, bursts)

  const points = buckets.map((b, i) => ({
    label: b.label, visitors: counts.visitors[i], unique: counts.unique[i],
    chats: counts.chats[i], picked: counts.picked[i], notPicked: counts.notPicked[i],
  }))
  const body = { range, points, totalUnique: counts.windowUnique }
  answers.set(cacheKey, { at: Date.now(), body })
  // The map is bounded by (workspaces × ranges × distinct site scopes), which is
  // a handful of entries — but prune anyway rather than trust that forever.
  if (answers.size > 200) {
    for (const [k, v] of answers) if (Date.now() - v.at > 900_000) answers.delete(k)
  }
  return NextResponse.json(body)
}
