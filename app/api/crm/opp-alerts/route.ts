import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runOppAlerts } from '@/lib/oppalertsweep'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Opportunities alerts for the packaging sales team (lib/oppalertsweep.ts):
// the 20:00 daily summary, the 2 h / 24 h "customer waiting" nudges and the
// month-end leaderboard. Vercel Cron every 5 minutes with CRON_SECRET, or a
// packaging admin by hand; ?dry=1 returns what would be sent without writing
// or pushing anything. Packaging only — never gated on the cron path.
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
    const dry = sp.get('dry') === '1' || sp.get('dryRun') === '1'
    // A pretend clock is allowed on dry runs only, so a time window can be
    // previewed ("what goes out at 10:00?") without waiting for it.
    const at = dry && sp.get('at') ? new Date(String(sp.get('at'))) : undefined
    const result = await runOppAlerts({ dry, now: at && !isNaN(at.getTime()) ? at : undefined })
    if (result.errors.length) console.error('[opp-alerts]', result.errors.slice(0, 5))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[opp-alerts] failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'opp-alerts failed' }, { status: 500 })
  }
}
