import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runLostWeekly } from '@/lib/lostweeklysweep'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// The weekly Lost report to the packaging sales agents (lib/lostweeklysweep.ts):
// Vercel Cron Mondays 05:00 UTC (10:00 PKT) with CRON_SECRET, or a packaging
// admin by hand. ?dryRun=1 returns what would be sent and writes / sends
// nothing. Packaging only by construction — the cron path is not gated.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const cron = !!secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)
  if (!cron) {
    const member = await getMember(req)
    if (member?.role !== 'admin' || member.workspace !== 'packaging') {
      return NextResponse.json({ error: secret ? 'Unauthorized' : 'CRON_SECRET is not set' }, { status: 401 })
    }
  }
  try {
    const sp = req.nextUrl.searchParams
    const dry = sp.get('dryRun') === '1' || sp.get('dry') === '1'
    const result = await runLostWeekly({ dry })
    if (result.errors.length) console.error('[lost-weekly]', result.errors.slice(0, 5))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[lost-weekly] failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'lost-weekly failed' }, { status: 500 })
  }
}
