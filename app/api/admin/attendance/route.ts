import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember } from '@/lib/auth'
import { asUtcIso, AGENT_DUTY_SITE } from '@/lib/visitor'

export const dynamic = 'force-dynamic'

// Attendance register (admin only): per agent per PKT day — first seen, last
// seen, and accumulated online time, from the presence heartbeat rows.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ days: [] }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ days: [] }, { status: 403 })

  const now = new Date()
  const from = req.nextUrl.searchParams.get('from') || new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const to = req.nextUrl.searchParams.get('to') || new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()

  const { data } = await supabase
    .from('active_visitors')
    .select('session_id, page_url, created_at, last_seen')
    .eq('site_id', AGENT_DUTY_SITE)
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: false })

  const days = (data ?? []).flatMap((r) => {
    try {
      const o = JSON.parse(r.page_url ?? '{}')
      if (o.ws !== member.workspace || typeof o.email !== 'string') return []
      // session_id = agent-duty:{email}:{YYYY-MM-DD}
      const date = r.session_id.slice(-10)
      return [{
        date,
        email: o.email as string,
        first: asUtcIso(r.created_at),
        last: asUtcIso(r.last_seen),
        secs: Number(o.secs) || 0,
      }]
    } catch { return [] }
  }).sort((a, b) => b.date.localeCompare(a.date) || a.email.localeCompare(b.email))

  return NextResponse.json({ days })
}
