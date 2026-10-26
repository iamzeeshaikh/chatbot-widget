import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runCostingSweep } from '@/lib/costingsweep'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Daily costing ask (lib/costingsweep.ts). Cron (Bearer CRON_SECRET) or a
// packaging admin; ?dry=1 says what it would do, ?push=0 skips the push.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const cron = !!secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)
  if (!cron) {
    const m = await getMember(req)
    if (!m || m.role !== 'admin' || m.workspace !== 'packaging') return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  }
  const q = req.nextUrl.searchParams
  return NextResponse.json(await runCostingSweep({ dryRun: q.get('dry') === '1', push: q.get('push') !== '0' }))
}
