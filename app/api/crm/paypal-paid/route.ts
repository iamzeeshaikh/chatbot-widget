import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runPaypalPaid } from '@/lib/paypalpaid'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// PayPal "paid for your invoice" mails → the sports lead, the Sales ledger and
// a notification (lib/paypalpaid.ts). SPORTS ONLY. Vercel Cron every 10
// minutes with CRON_SECRET, or a sports admin by hand; ?dryRun=1 reports what
// would be matched without writing anything.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const cron = !!secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)
  if (!cron) {
    const member = await getMember(req)
    if (member?.role !== 'admin' || member.workspace !== 'sports') {
      return NextResponse.json({ error: secret ? 'Unauthorized' : 'CRON_SECRET is not set' }, { status: 401 })
    }
  }
  try {
    const result = await runPaypalPaid(req.nextUrl.origin, { dryRun: req.nextUrl.searchParams.get('dryRun') === '1' })
    if (result.errors.length) console.error('[paypal-paid]', result.errors.slice(0, 5))
    return NextResponse.json(result)
  } catch (e) {
    console.error('[paypal-paid] failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'paypal-paid failed' }, { status: 500 })
  }
}
