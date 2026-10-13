import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { runQuoteBot } from '@/lib/quotebot'

export const dynamic = 'force-dynamic'
// Each lead costs one model call and, at most, one Gmail send; the per-run cap
// in lib/quotebot.ts keeps a run well inside this.
export const maxDuration = 120

// The quote bot's sweep (lib/quotebot.ts). Same triggering as the other sweeps:
// Vercel Cron with CRON_SECRET, or a signed-in packaging admin by hand.
//
//   ?dryRun=1        decide everything, send nothing, write nothing
//   ?lead=<id>       preview one lead (always a dry run), outside the time window
//
// Sending also needs QUOTE_BOT=on in the environment; without it every run is
// a dry run, which is how the bot is switched off in an emergency.
async function authorise(req: NextRequest): Promise<{ ok: boolean; by: string; why?: string }> {
  const secret = process.env.CRON_SECRET
  if (secret) {
    if (req.headers.get('authorization') === `Bearer ${secret}`) return { ok: true, by: 'cron' }
    if (req.headers.get('x-cron-secret') === secret) return { ok: true, by: 'trigger' }
  }
  const member = await getMember(req)
  if (member?.role === 'admin' && hasFeature(member.workspace, 'quotebot')) {
    return { ok: true, by: `admin:${member.email}` }
  }
  return {
    ok: false, by: '',
    why: secret ? 'Bad or missing cron secret' : 'CRON_SECRET is not set in the environment — scheduled runs cannot authenticate',
  }
}

export async function GET(req: NextRequest) {
  const auth = await authorise(req)
  if (!auth.ok) return NextResponse.json({ error: auth.why }, { status: 401 })
  const lead = req.nextUrl.searchParams.get('lead') || undefined
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1' || !!lead
  try {
    const result = await runQuoteBot(req.nextUrl.origin, new Date(), { dryRun, leadId: lead })
    return NextResponse.json({ by: auth.by, ...result })
  } catch (err) {
    console.error('[quotebot] run failed:', err)
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'The quote bot failed' }, { status: 500 })
  }
}
