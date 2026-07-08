import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember } from '@/lib/auth'
import { AGENT_DUTY_SITE } from '@/lib/visitor'

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
