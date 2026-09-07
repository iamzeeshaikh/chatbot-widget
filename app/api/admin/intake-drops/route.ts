import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'
import { recentIntakeDrops } from '@/lib/intakedrop'

export const dynamic = 'force-dynamic'

// The leads the intake endpoint accepted and did not store.
//
// This exists because "some leads are missing" was, until now, an unanswerable
// question: a spam match, a retired site or a duplicate all returned success
// and wrote nothing anywhere. Now every one of them leaves a row, and this is
// how an admin reads them back.
//
// Scoped like everything else — an admin sees only the sites they are assigned,
// so a sports admin cannot read a packaging submission out of it.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') {
    return NextResponse.json({ error: 'Admins only' }, { status: 403 })
  }
  const sites = memberSites(member)
  if (sites.length === 0) return NextResponse.json({ drops: [], counts: {} })

  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 200) || 200, 500)
  const drops = await recentIntakeDrops(sites, limit)

  const counts: Record<string, number> = { spam: 0, retired: 0, duplicate: 0 }
  for (const d of drops) counts[d.reason] = (counts[d.reason] ?? 0) + 1

  return NextResponse.json({ drops, counts, total: drops.length })
}
