import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages } from '@/lib/supabase'
import { getMember, siteScope, HARDCODED_ACCOUNTS } from '@/lib/auth'
import { MODE_ROLE } from '@/lib/mode'
import { CONTACT_ROLE, TAGS_ROLE, asUtcIso } from '@/lib/visitor'
import { LEAD_CAPTURE_ROLE } from '@/lib/leadtracking'
import { REPLY_AUTHOR_ROLE, RESPONSE_SLA_MS, RESPONSE_OUTLIER_CAP_MS, parseReplyAuthor, type ReplyAuthor } from '@/lib/replyauthor'
import { isBotOffBySchedule } from '@/lib/botschedule'
import { isBotEnabled } from '@/lib/botflag'
import { findBurstKeys, burstKey } from '@/lib/botfilter'

export const dynamic = 'force-dynamic'

// Agent performance / accountability report for a date range (default: this
// calendar month). Admin-only and strictly workspace-isolated: an admin only
// ever sees agents and conversations within their own workspace's sites.
//
// Everything is derived from chat_logs (no DDL):
//   • Agent replies are role 'admin'. Each is attributed to a member via its
//     paired reply_author row (same session_id + created_at). Replies older than
//     that tracking have no author row → counted as "unattributed" (historical).
//   • Response time = an agent reply's timestamp minus the visitor message that
//     was waiting on a reply. All timestamps are UTC-normalised (asUtcIso) so the
//     schedule check and durations are correct in any server timezone.
//   • "Missed" = a visitor messaged while the bot was off (manual human takeover
//     OR the packaging off-hours schedule) and no agent replied within the SLA.
//   • "Unanswered" = a conversation whose last message is the visitor's and which
//     has no agent reply at all — still waiting.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // Only admins see other agents' stats (standard members are excluded).
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const scope = siteScope(member)
  const allowed = Array.from(scope)

  const now = new Date()
  const from = req.nextUrl.searchParams.get('from') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const to = req.nextUrl.searchParams.get('to') || new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

  // ── Agent roster: workspace members + built-in workspace admins ─────────────
  const { data: memberRows } = await supabase
    .from('members')
    .select('id, email')
    .eq('workspace', member.workspace)

  const roster = new Map<string, { id: string; email: string; builtin: boolean }>()
  for (const a of HARDCODED_ACCOUNTS.filter((acc) => acc.workspace === member.workspace)) {
    roster.set(`builtin:${a.email}`, { id: `builtin:${a.email}`, email: a.email, builtin: true })
  }
  for (const m of memberRows ?? []) roster.set(m.id, { id: m.id, email: m.email, builtin: false })

  const emptySummary = {
    totalConversations: 0, answeredConversations: 0, totalLeads: 0, totalMissed: 0, totalUnanswered: 0,
    ignoredVisitors: 0, totalReplies: 0, attributedReplies: 0, avgResponseMs: null as number | null,
    avgExcludedOutliers: 0,
  }
  if (allowed.length === 0) {
    return NextResponse.json({ from, to, summary: emptySummary, agents: [], unattributedReplies: 0 })
  }

  // Paginated: a plain .limit(50000) is silently capped at 1000 rows by
  // PostgREST, which would drop everything after the month's first 1000 rows.
  const [rows, visitorRows] = await Promise.all([
    fetchAllPages<{ session_id: string; site_id: string; role: string; message: string; created_at: string }>(
      () => supabase
        .from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .in('site_id', allowed)
        .gte('created_at', from)
        .lt('created_at', to)
        .order('created_at', { ascending: true }),
      50000),
    // Every widget session of the period (for the ignored-visitors count),
    // with user_agent so bot bursts can be excluded like everywhere else.
    fetchAllPages<{ session_id: string; user_agent: string | null; created_at: string }>(
      () => supabase
        .from('active_visitors')
        .select('session_id, user_agent, created_at')
        .in('site_id', allowed)
        .gte('created_at', from)
        .lt('created_at', to)
        .order('created_at', { ascending: true }),
      50000),
  ])
  const t = (ts: string) => new Date(asUtcIso(ts) as string).getTime()
  const nowMs = Date.now()
  // Global bot kill switch: while the bot is disabled, EVERY waiting visitor
  // message is a human agent's responsibility, so it feeds the missed/SLA logic
  // like manual takeover does. Historical rows from when the bot was on aren't
  // distorted: back then the bot's 'assistant' reply cleared the pending state.
  const botDisabled = !isBotEnabled()

  // Author lookup: a reply_author row shares its admin reply's exact created_at.
  const authorByKey = new Map<string, ReplyAuthor>()
  const idToEmail = new Map<string, string>()
  for (const r of rows) {
    if (r.role === REPLY_AUTHOR_ROLE) {
      const a = parseReplyAuthor(r.message)
      if (a) { authorByKey.set(`${r.session_id}|${r.created_at}`, a); if (a.email) idToEmail.set(a.id, a.email) }
    }
  }

  // Per-agent accumulators. Beyond responsiveness (respSum/slow), each agent is
  // also measured on: leads (handled conversations that captured a lead),
  // hanging (conversations where THEIR last reply was followed by a visitor
  // message nobody answered — they dropped the ball), and lastReplyMs (most
  // recent activity, exposing agents who've gone quiet).
  type Agg = { handled: Set<string>; replies: number; respSum: number; respCount: number; respExcluded: number; slow: number; leads: number; hanging: number; lastReplyMs: number; proactive: number }
  const agg = new Map<string, Agg>()
  const ensure = (id: string): Agg => {
    let a = agg.get(id)
    if (!a) { a = { handled: new Set(), replies: 0, respSum: 0, respCount: 0, respExcluded: 0, slow: 0, leads: 0, hanging: 0, lastReplyMs: 0, proactive: 0 }; agg.set(id, a) }
    return a
  }

  // Workspace-level tallies.
  let totalReplies = 0, attributedReplies = 0, totalLeads = 0
  let wsRespSum = 0, wsRespCount = 0, wsRespExcluded = 0
  // Diagnostic: every (visitor_msg, agent_reply, diff) pair that feeds the avg,
  // so a corrupt/outlier pair can be eyeballed in the server logs.
  const respPairs: { sid: string; userIso: string; adminIso: string; diffMin: number; excluded: boolean }[] = []
  const conversations = new Set<string>()
  const answeredSessions = new Set<string>()
  const missedSessions = new Set<string>()
  const unansweredSessions = new Set<string>()
  const leadSessions = new Set<string>()

  // Group rows per session, preserving ascending order.
  const bySession = new Map<string, typeof rows>()
  for (const r of rows) {
    if (r.role === LEAD_CAPTURE_ROLE) { totalLeads++; leadSessions.add(r.session_id) }
    let list = bySession.get(r.session_id)
    if (!list) { list = []; bySession.set(r.session_id, list) }
    list.push(r)
  }

  for (const [sid, evs] of bySession) {
    let mode: 'bot' | 'human' = 'bot'
    let pendingUserTs: number | null = null   // a visitor message awaiting a reply
    let pendingUserIso: string | null = null  // …its raw created_at (for diagnostics)
    let pendingHumanState = false             // …sent while the bot was off
    let hasRealMsg = false
    let lastRealRole = ''
    let firstRealRole = ''                    // 'admin' first = a proactive chat
    let adminCount = 0
    let lastAdminAuthor: string | null = null // who sent the session's final agent reply
    let firstAdminAuthor: string | null = null // who sent the session's FIRST agent message

    for (const ev of evs) {
      if (ev.role === MODE_ROLE) { mode = ev.message === 'human' ? 'human' : 'bot'; continue }
      if (ev.role === CONTACT_ROLE || ev.role === TAGS_ROLE || ev.role === LEAD_CAPTURE_ROLE || ev.role === REPLY_AUTHOR_ROLE) continue
      if (ev.message === '(session started)') continue

      hasRealMsg = true
      if (!firstRealRole) firstRealRole = ev.role
      lastRealRole = ev.role
      const ts = t(ev.created_at)

      if (ev.role === 'user') {
        // Only track the FIRST unanswered visitor message in a waiting streak, so
        // a burst of visitor messages counts as one response-time measurement.
        if (pendingUserTs === null) {
          pendingUserTs = ts
          pendingUserIso = ev.created_at
          const scheduleOff = isBotOffBySchedule(ev.site_id, new Date(asUtcIso(ev.created_at) as string))
          pendingHumanState = botDisabled || mode === 'human' || scheduleOff
        }
      } else if (ev.role === 'assistant') {
        // The bot answered — clears the wait (normal bot-on flow, not a miss).
        pendingUserTs = null
        pendingUserIso = null
        pendingHumanState = false
      } else if (ev.role === 'admin') {
        adminCount++
        totalReplies++
        const author = authorByKey.get(`${sid}|${ev.created_at}`)
        if (author) {
          attributedReplies++
          const a = ensure(author.id); a.replies++; a.handled.add(sid)
          if (ts > a.lastReplyMs) a.lastReplyMs = ts
          lastAdminAuthor = author.id
          if (!firstAdminAuthor) firstAdminAuthor = author.id
        }

        if (pendingUserTs !== null) {
          // dt = reply time − the FIRST unanswered visitor message in this waiting
          // streak (a burst of visitor messages = one first-response measurement).
          // pendingUserTs is always a PRECEDING message, so a reply can never pair
          // with a message that came after it.
          const dt = ts - pendingUserTs
          if (dt >= 0) {
            // An outlier (next-day/overnight reply) still counts as slow/missed,
            // but must NOT pollute the average. Negative diffs are dropped above.
            const isOutlier = dt > RESPONSE_OUTLIER_CAP_MS
            respPairs.push({ sid, userIso: pendingUserIso!, adminIso: ev.created_at, diffMin: dt / 60000, excluded: isOutlier })
            if (isOutlier) {
              wsRespExcluded++
              if (author) ensure(author.id).respExcluded++
            } else {
              wsRespSum += dt; wsRespCount++
              if (author) { const a = ensure(author.id); a.respSum += dt; a.respCount++ }
            }
            if (author && dt > RESPONSE_SLA_MS) ensure(author.id).slow++
            // Dropped the ball: visitor waited (bot off) and the reply was late.
            if (pendingHumanState && dt > RESPONSE_SLA_MS) missedSessions.add(sid)
          }
          pendingUserTs = null
          pendingUserIso = null
          pendingHumanState = false
        }
      }
    }

    if (hasRealMsg) conversations.add(sid)
    if (hasRealMsg && adminCount > 0) answeredSessions.add(sid)
    // A trailing visitor message during a bot-off state that has now been waiting
    // longer than the SLA with no reply at all → missed.
    if (pendingUserTs !== null && pendingHumanState && nowMs - pendingUserTs > RESPONSE_SLA_MS) {
      missedSessions.add(sid)
    }
    // Dropped: the agent who replied LAST in this conversation left the
    // visitor's follow-up hanging past the SLA. Owned by that specific agent.
    if (pendingUserTs !== null && lastAdminAuthor && nowMs - pendingUserTs > RESPONSE_SLA_MS) {
      ensure(lastAdminAuthor).hanging++
    }
    // Still waiting: last message is the visitor's and no agent ever replied.
    if (lastRealRole === 'user' && adminCount === 0) unansweredSessions.add(sid)
    // Lead credit: every agent who replied in a lead-capturing conversation.
    if (leadSessions.has(sid)) {
      for (const a of agg.values()) if (a.handled.has(sid)) a.leads++
    }
    // Proactive: the conversation's very first message was an agent's (they
    // reached out to a browsing visitor instead of waiting).
    if (firstRealRole === 'admin' && firstAdminAuthor) ensure(firstAdminAuthor).proactive++
  }

  // ── Ignored visitors (workspace-wide) ───────────────────────────────────────
  // Sessions that pinged as visitors this period but have NO real chat message
  // at all: the visitor never typed AND no agent ever reached out. Bot bursts
  // are excluded with the shared heuristic. No single agent owns these.
  const vStamped = visitorRows.map((v) => ({ v, ms: new Date(asUtcIso(v.created_at) ?? v.created_at).getTime() }))
  const vBursts = findBurstKeys(vStamped.map((s) => ({ userAgent: s.v.user_agent, tsMs: s.ms })))
  const seenVisitorSessions = new Set<string>()
  let ignoredVisitors = 0
  for (const { v, ms } of vStamped) {
    if (vBursts.has(burstKey(v.user_agent, ms))) continue
    if (seenVisitorSessions.has(v.session_id)) continue
    seenVisitorSessions.add(v.session_id)
    // `conversations` = sessions with at least one REAL message (visitor or
    // agent), so control-row-only sessions still count as ignored.
    if (!conversations.has(v.session_id)) ignoredVisitors++
  }

  // ── Diagnostic: dump every pair feeding the workspace average ───────────────
  // Lets us eyeball whether the avg is real or skewed by a few bad/outlier pairs.
  const wsAvgMin = wsRespCount ? wsRespSum / wsRespCount / 60000 : 0
  console.log(`[Performance] ${member.workspace} ${from}..${to} — response pairs: ${respPairs.length} (${wsRespCount} averaged, ${wsRespExcluded} excluded as >${RESPONSE_OUTLIER_CAP_MS / 3600000}h outliers). avg=${wsAvgMin.toFixed(1)}min`)
  for (const p of [...respPairs].sort((a, b) => b.diffMin - a.diffMin)) {
    console.log(`  ${p.userIso} -> ${p.adminIso} = ${p.diffMin.toFixed(1)}min${p.excluded ? '  [EXCLUDED outlier]' : ''}  [${p.sid.slice(0, 8)}]`)
  }

  // ── Build the agent table (roster ∪ anyone with attributed replies) ─────────
  const agentRow = (id: string, email: string, builtin: boolean, former: boolean, a: Agg | undefined) => ({
    id, email, builtin, former,
    handled: a ? a.handled.size : 0,
    replies: a ? a.replies : 0,
    avgResponseMs: a && a.respCount ? Math.round(a.respSum / a.respCount) : null,
    slowReplies: a ? a.slow : 0,
    // All measured response pairs, INCLUDING outliers (they're excluded from
    // the average but still count as slow) — keeps slow ≤ measured.
    measuredReplies: a ? a.respCount + a.respExcluded : 0,
    leads: a ? a.leads : 0,
    dropped: a ? a.hanging : 0,
    proactive: a ? a.proactive : 0,
    lastReplyAt: a && a.lastReplyMs ? new Date(a.lastReplyMs).toISOString() : null,
  })
  type AgentRow = ReturnType<typeof agentRow>
  const agents: AgentRow[] = []
  const seen = new Set<string>()
  for (const [id, info] of roster) {
    agents.push(agentRow(id, info.email, info.builtin, false, agg.get(id)))
    seen.add(id)
  }
  // Replies attributed to someone no longer in the roster (e.g. a removed member).
  for (const [id, a] of agg) {
    if (seen.has(id)) continue
    agents.push(agentRow(id, idToEmail.get(id) || 'former member', id.startsWith('builtin:'), true, a))
  }

  // Sort by responsiveness: active agents first (fastest average on top), idle
  // agents (no replies in the period) last so "missing chats" stand out.
  agents.sort((x, y) => {
    const xActive = x.replies > 0 ? 0 : 1
    const yActive = y.replies > 0 ? 0 : 1
    if (xActive !== yActive) return xActive - yActive
    const xa = x.avgResponseMs ?? Number.POSITIVE_INFINITY
    const ya = y.avgResponseMs ?? Number.POSITIVE_INFINITY
    if (xa !== ya) return xa - ya
    return x.email.localeCompare(y.email)
  })

  return NextResponse.json({
    from, to,
    summary: {
      totalConversations: conversations.size,
      answeredConversations: answeredSessions.size,
      totalLeads,
      totalMissed: missedSessions.size,
      totalUnanswered: unansweredSessions.size,
      ignoredVisitors,
      totalReplies,
      attributedReplies,
      avgResponseMs: wsRespCount ? Math.round(wsRespSum / wsRespCount) : null,
      avgExcludedOutliers: wsRespExcluded,
    },
    agents,
    unattributedReplies: totalReplies - attributedReplies,
  })
}
