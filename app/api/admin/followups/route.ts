import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { siteScope } from '@/lib/auth'
import { buildFollowups, resolveFollowupDay, type FollowupData } from '@/lib/followups'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Daily follow-ups: what went out, what came back and who is waiting, for one
// Karachi day (?day=YYYY-MM-DD, default today). Admin-only and limited to the
// member's own sites, like the performance report it sits beside — it shows
// every agent's numbers. Packaging only: it reads the follow-up bot's ledger.
// The read is a fortnight of mail bodies, so one result is kept for three
// minutes per site scope and day (the Refresh button asks for ?fresh=1).
const CACHE_MS = 3 * 60_000
const cache = new Map<string, { at: number; data: FollowupData }>()

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if (!hasFeature(member.workspace, 'quotebot')) {
    return NextResponse.json({ error: 'Follow-ups are not enabled for this workspace' }, { status: 403 })
  }
  try {
    const sp = req.nextUrl.searchParams
    const day = resolveFollowupDay(sp.get('day'))
    const key = `${member.workspace}|${Array.from(siteScope(member)).sort().join(',')}|${day}`
    const hit = cache.get(key)
    if (hit && sp.get('fresh') !== '1' && Date.now() - hit.at < CACHE_MS) return NextResponse.json(hit.data)
    const data = await buildFollowups(member, day)
    if (cache.size > 40) cache.clear()
    cache.set(key, { at: Date.now(), data })
    return NextResponse.json(data)
  } catch (e) {
    console.error('[followups]', e)
    return NextResponse.json({ error: 'Could not build the follow-ups report.' }, { status: 500 })
  }
}
