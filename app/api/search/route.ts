import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { searchLeads, MIN_QUERY } from '@/lib/leadsearch'

export const dynamic = 'force-dynamic'

// Lead search. The site scope lives inside searchLeads' queries, so a member
// can never receive a lead they could not open — search is not a way to learn
// that another site exists.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 120)
  if (q.trim().length < MIN_QUERY) {
    return NextResponse.json({ hits: [], truncated: false, tookMs: 0, min: MIN_QUERY })
  }

  try {
    const result = await searchLeads(member, q)
    // Server-side timing, so the real query cost is measurable from the client
    // without guessing at network latency.
    return NextResponse.json(result, { headers: { 'Server-Timing': `search;dur=${result.tookMs}` } })
  } catch (err) {
    console.error('[search] failed:', err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
