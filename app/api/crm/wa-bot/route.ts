import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { runWaBot, readBotConfig, writeBotConfig } from '@/lib/wabotsweep'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// The WhatsApp assistant (lib/wabot.ts, lib/wabotsweep.ts), packaging only.
//
// GET  — the sweep. Vercel Cron every minute with CRON_SECRET (not gated on a
//        workspace: cron is not a member), or a packaging admin by hand.
//        ?dryRun=1 writes, sends and pushes nothing; with it,
//        ?sample=<days> replays real recent threads ignoring the 3-minute
//        timing, ?replay=1 answers each thread as it stood at the customer's
//        first message, and ?lead=<id>[,<id>] narrows to given leads.
//        ?status=1 returns the workspace switch only.
// POST — a packaging admin flips the workspace switch:
//        { enabled?: boolean, delayMin?: number, maxPerDay?: number }.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  const cron = !!secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)
  if (!cron) {
    const member = await getMember(req)
    if (member?.role !== 'admin' || member.workspace !== 'packaging') {
      return NextResponse.json({ error: secret ? 'Unauthorized' : 'CRON_SECRET is not set' }, { status: 401 })
    }
  }
  const sp = req.nextUrl.searchParams
  if (sp.get('status') === '1') return NextResponse.json(await readBotConfig())
  const dryRun = sp.get('dryRun') === '1' || sp.get('dry') === '1'
  try {
    const sample = dryRun ? Math.min(14, Math.max(0, Number(sp.get('sample') ?? 0))) : 0
    const leadIds = (sp.get('lead') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const result = await runWaBot({
      dryRun, leadIds: leadIds.length ? leadIds : undefined,
      sampleDays: sample || undefined, ignoreTiming: dryRun && (sample > 0 || leadIds.length > 0),
      replayFirst: dryRun && sp.get('replay') === '1',
    })
    return NextResponse.json(result)
  } catch (e) {
    console.error('[wa-bot] failed:', e)
    return NextResponse.json({ error: e instanceof Error ? e.message : 'wa-bot failed' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (member?.role !== 'admin' || member.workspace !== 'packaging') return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  const b = await req.json().catch(() => ({}))
  const next = await writeBotConfig({
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    delayMin: Number.isFinite(b.delayMin) ? Number(b.delayMin) : undefined,
    maxPerDay: Number.isFinite(b.maxPerDay) ? Number(b.maxPerDay) : undefined,
  }, member.email)
  return NextResponse.json(next)
}
