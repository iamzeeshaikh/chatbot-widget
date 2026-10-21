import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { loadOpportunities } from '@/lib/opportunityload'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The Opportunities tab (packaging only). Read-only: every action on a deal
// happens on its own lead record, through the routes that already guard it.
// Every packaging member sees the whole list and every amount — the owner's
// rule — within their own site scope.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'opportunities')) {
    return NextResponse.json({ error: 'Opportunities are not enabled for this workspace' }, { status: 403 })
  }
  try {
    const data = await loadOpportunities(member, { fresh: req.nextUrl.searchParams.get('fresh') === '1' })
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    console.error('[opportunities] load failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to load opportunities' }, { status: 500 })
  }
}
