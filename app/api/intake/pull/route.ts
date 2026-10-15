import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runIntakePull } from '@/lib/gmailintake'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Quote intake pulled from the intake mailbox (lib/gmailintake.ts). Vercel
// Cron every 5 minutes with CRON_SECRET, or a packaging admin by hand;
// ?dryRun=1 lists what would be filed without posting or remembering anything.
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
    const result = await runIntakePull(req.nextUrl.origin, { dryRun: req.nextUrl.searchParams.get('dryRun') === '1' })
    if (result.errors.length) console.error('[intake-pull]', result.errors.slice(0, 5))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[intake-pull] failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'intake pull failed' }, { status: 500 })
  }
}
