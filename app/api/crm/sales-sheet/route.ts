import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { syncSalesSheet } from '@/lib/salessheet'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Shazzy's sales sheet → production status on the matching sales
// (lib/salessheet.ts). Vercel Cron hourly, or a packaging admin by hand;
// ?dryRun=1 reports what would change and writes nothing.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  let by = ''
  if (secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)) by = 'cron'
  else {
    const member = await getMember(req)
    if (member?.role === 'admin' && hasFeature(member.workspace, 'sales') && member.workspace === 'packaging') by = `admin:${member.email}`
  }
  if (!by) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    const result = await syncSalesSheet(new Date(), { dryRun })
    return NextResponse.json({ by, ...result })
  } catch (err) {
    console.error('[sales-sheet] failed:', err)
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'sync failed' }, { status: 500 })
  }
}
