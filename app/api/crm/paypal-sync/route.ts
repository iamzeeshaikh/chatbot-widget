import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runPaypalSync } from '@/lib/paypalsync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// PayPal → packaging Sales ledger (lib/paypalsync.ts). Vercel Cron every 30
// minutes with CRON_SECRET, or a packaging admin by hand; ?dryRun=1 reports
// what it would record without writing anything.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const cron = !!secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)
  if (!cron) {
    const m = await getMember(req)
    if (m?.role !== 'admin' || m.workspace !== 'packaging') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await runPaypalSync({ dryRun: req.nextUrl.searchParams.get('dryRun') === '1' }))
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'PayPal sync failed' }, { status: 500 })
  }
}
