import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { resolveSitesForIds } from '@/lib/bulk'
import { currentStateForIds } from '@/lib/leadstate'
import { RESULT_CAP } from '@/lib/leadsearch'

export const dynamic = 'force-dynamic'

// Stage + owner for a handful of search hits.
//
// Split from /api/search on purpose: the match itself is what the agent is
// waiting for, so it is never held up by the enrichment. Access is re-checked
// here too — the ids come from the client, and this must not become a way to
// read the state of a lead on a site the member cannot open.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ids: string[] = Array.isArray(body.ids)
    ? body.ids.filter((i: unknown) => typeof i === 'string' && i).slice(0, RESULT_CAP)
    : []
  if (ids.length === 0) return NextResponse.json({ state: {} })

  const { allowed } = await resolveSitesForIds(member, ids)
  const state = await currentStateForIds([...allowed.keys()])

  return NextResponse.json({
    state: Object.fromEntries([...state.entries()].map(([id, s]) => [id, { stage: s.stage, owner: s.owner }])),
  })
}
