import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, HARDCODED_ACCOUNTS } from '@/lib/auth'
import { AGENT_DUTY_SITE } from '@/lib/visitor'

export const dynamic = 'force-dynamic'

// Who's online right now: every agent in the workspace, flagged online if their
// duty heartbeat (POST below, once a minute) landed within ONLINE_MS. Available
// to any member so the whole team can see who's on shift (Zendesk-style).
const ONLINE_MS = 2.5 * 60 * 1000
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ agents: [], onlineCount: 0 }, { status: 401 })

  const [{ data: memberRows }, { data: beats }] = await Promise.all([
    supabase.from('members').select('email, role').eq('workspace', member.workspace),
    supabase.from('active_visitors').select('page_url, last_seen')
      .eq('site_id', AGENT_DUTY_SITE)
      .gte('last_seen', new Date(Date.now() - 15 * 60 * 1000).toISOString()),
  ])

  const roster = new Set<string>()
  for (const a of HARDCODED_ACCOUNTS.filter((x) => x.workspace === member.workspace)) roster.add(a.email)
  for (const m of memberRows ?? []) roster.add(m.email)

  // Who actually works leads. Admins and the built-in account run the system —
  // they are not on the rota — so anything choosing an assignee should offer
  // the agents and no one else. Presence itself still lists everybody, because
  // "who is online" genuinely means everybody.
  const agentOnly = new Set(
    (memberRows ?? []).filter((m) => m.role !== 'admin').map((m) => String(m.email)),
  )

  const lastByEmail: Record<string, number> = {}
  for (const b of beats ?? []) {
    let email = '', ws = ''
    try { const o = JSON.parse(b.page_url ?? '{}'); email = o.email; ws = o.ws } catch { /* skip */ }
    if (!email || ws !== member.workspace) continue
    const ms = new Date(b.last_seen.endsWith('Z') ? b.last_seen : b.last_seen + 'Z').getTime()
    if (!lastByEmail[email] || ms > lastByEmail[email]) lastByEmail[email] = ms
  }

  const now = Date.now()
  const agents = Array.from(roster).map((email) => {
    const ms = lastByEmail[email] || 0
    return {
      email, online: ms > 0 && now - ms < ONLINE_MS,
      lastSeen: ms ? new Date(ms).toISOString() : null,
      assignable: agentOnly.has(email),
    }
  }).sort((a, b) => (a.online === b.online ? a.email.localeCompare(b.email) : a.online ? -1 : 1))

  return NextResponse.json({ agents, onlineCount: agents.filter((a) => a.online).length })
}

// Agent duty-hours heartbeat — no DDL: one active_visitors row per agent per
// PKT day under the reserved AGENT_DUTY_SITE id (every visitor query filters
// by the member's real sites, so these rows can never leak into visitor views).
// The dashboard beats once a minute while open; each beat adds the elapsed
// time since the previous beat (capped, so a closed laptop doesn't count).
const MAX_GAP_MS = 3 * 60 * 1000

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now = Date.now()
  const day = new Date(now + 5 * 3600 * 1000).toISOString().slice(0, 10) // PKT day
  const id = `agent-duty:${member.email}:${day}`

  const { data: existing } = await supabase
    .from('active_visitors')
    .select('page_url, last_seen')
    .eq('session_id', id)
    .maybeSingle()

  let secs = 0
  if (existing) {
    try { secs = Number(JSON.parse(existing.page_url ?? '{}').secs) || 0 } catch { secs = 0 }
    const lastMs = new Date(existing.last_seen.endsWith('Z') ? existing.last_seen : existing.last_seen + 'Z').getTime()
    secs += Math.round(Math.min(Math.max(now - lastMs, 0), MAX_GAP_MS) / 1000)
  }

  await supabase.from('active_visitors').upsert({
    session_id: id,
    site_id: AGENT_DUTY_SITE,
    page_url: JSON.stringify({ email: member.email, ws: member.workspace, secs }),
    status: 'active',
    last_seen: new Date(now).toISOString(),
  }, { onConflict: 'session_id' })

  return NextResponse.json({ ok: true })
}
