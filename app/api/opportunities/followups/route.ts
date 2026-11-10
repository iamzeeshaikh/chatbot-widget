import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { isOwnLeadsOnly, ownLeadsRefusal } from '@/lib/ownleads'
import { hasFeature } from '@/lib/workspaces'
import { loadFollowUpStats } from '@/lib/followupstats'

export const dynamic = 'force-dynamic'

// Follow-up results on the Opportunities page (lib/followupstats.ts). Everyone
// in the packaging workspace sees them, like the rest of that page.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Own-leads-only (lib/ownleads.ts): this screen is about everybody's leads.
  if (isOwnLeadsOnly(member)) return ownLeadsRefusal()
  if (!hasFeature(member.workspace, 'opportunities')) return NextResponse.json({ error: 'Not enabled for this workspace' }, { status: 403 })
  const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get('days')) || 30))
  try {
    return NextResponse.json(await loadFollowUpStats(days), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    console.error('[followups] failed:', e)
    return NextResponse.json({ error: 'Could not load follow-up results' }, { status: 500 })
  }
}
