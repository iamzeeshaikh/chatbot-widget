import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { runQuoteBot, sendFollowUp, sendQuoteFollowUp, quoteBotEnabled } from '@/lib/quotebot'

export const dynamic = 'force-dynamic'
// Each lead costs one model call and, at most, one Gmail send; the per-run cap
// in lib/quotebot.ts keeps a run well inside this.
export const maxDuration = 120

// The quote bot's sweep (lib/quotebot.ts). Same triggering as the other sweeps:
// Vercel Cron with CRON_SECRET, or a signed-in packaging admin by hand.
//
//   ?dryRun=1        decide everything, send nothing, write nothing
//   ?lead=<id>[,<id>] preview named leads (always a dry run), outside the time window
//   ?followup=<id>    ADMIN ONLY: send that lead's next follow-up now, without
//                     the 3-day wait (every other stop rule still applies) —
//                     for testing the sequence on a lead
//   ?quotefollowup=<id> ADMIN ONLY: the same for a follow-up after the quote
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
  const followup = req.nextUrl.searchParams.get('followup')
  if (followup) {
    if (!auth.by.startsWith('admin:')) return NextResponse.json({ error: 'Follow-up test sends are for an admin' }, { status: 403 })
    if (!quoteBotEnabled()) return NextResponse.json({ error: 'The quote bot is switched off' }, { status: 409 })
    return NextResponse.json(await sendFollowUp(followup, new Date(), { force: true }))
  }
  const quoteFollowup = req.nextUrl.searchParams.get('quotefollowup')
  if (quoteFollowup) {
    if (!auth.by.startsWith('admin:')) return NextResponse.json({ error: 'Follow-up test sends are for an admin' }, { status: 403 })
    if (!quoteBotEnabled()) return NextResponse.json({ error: 'The quote bot is switched off' }, { status: 409 })
    return NextResponse.json(await sendQuoteFollowUp(quoteFollowup, new Date(), { force: true }))
  }
  const leadIds = (req.nextUrl.searchParams.get('lead') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 25)
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1' || leadIds.length > 0
  try {
    const result = await runQuoteBot(req.nextUrl.origin, new Date(), { dryRun, leadIds })
    return NextResponse.json({ by: auth.by, ...result })
  } catch (err) {
    console.error('[quotebot] run failed:', err)
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'The quote bot failed' }, { status: 500 })
  }
}
