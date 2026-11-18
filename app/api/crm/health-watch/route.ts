import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runHealthWatch } from '@/lib/healthwatch'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The watchman (lib/healthwatch.ts): duplicate email rows, a runaway writer, a
// mailbox Gmail keeps refusing, a reply check that has stopped. Vercel Cron
// every 10 minutes with CRON_SECRET, or a packaging admin by hand; ?dry=1
// returns what it found without alerting anyone.
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
    const dry = req.nextUrl.searchParams.get('dry') === '1'
    const result = await runHealthWatch({ dry })
    if (result.problems.length) console.error('[health-watch]', result.problems.map((p) => p.key).join(', '))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[health-watch] failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'health-watch failed' }, { status: 500 })
  }
}
