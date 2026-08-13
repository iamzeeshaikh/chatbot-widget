import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { runReminderSweep } from '@/lib/reminderssweep'

export const dynamic = 'force-dynamic'
// Comfortably inside Vercel's limit; the sweep is a handful of bounded queries.
export const maxDuration = 60

// The scheduled reminder sweep.
//
// Triggering follows the pattern this project already uses for scheduled work —
// a secret-protected HTTP endpoint driven by an external clock (the same shape
// as /api/quote-intake, which the Gmail Apps Script time-trigger calls). It
// accepts either:
//
//   Authorization: Bearer <CRON_SECRET>   ← what Vercel Cron sends
//   x-cron-secret: <CRON_SECRET>          ← for any other trigger, matching the
//                                           x-quote-secret style used elsewhere
//
// A signed-in admin may also run it by hand, which is what makes it debuggable
// without leaking the secret into a browser.
//
// The work itself is idempotent and derived from task state (see
// lib/reminderssweep.ts), so running late, running twice or missing a window are
// all safe.
async function authorise(req: NextRequest): Promise<{ ok: boolean; by: string; why?: string }> {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const bearer = req.headers.get('authorization')
    if (bearer === `Bearer ${secret}`) return { ok: true, by: 'cron' }
    if (req.headers.get('x-cron-secret') === secret) return { ok: true, by: 'trigger' }
  }
  // One run covers every workspace and the response names each assignee it
  // reminded, so the manual trigger is limited to an admin of a workspace that
  // actually carries reminders. The CRON_SECRET path above is untouched.
  const member = await getMember(req)
  if (member?.role === 'admin' && hasFeature(member.workspace, 'reminders')) {
    return { ok: true, by: `admin:${member.email}` }
  }

  // Being explicit here matters: without CRON_SECRET set in the environment,
  // Vercel Cron sends no Authorization header, every scheduled run 401s, and
  // reminders silently never fire. Say so in the response so the cron log
  // names the cause instead of just showing a 401.
  return {
    ok: false,
    by: '',
    why: secret
      ? 'Bad or missing cron secret'
      : 'CRON_SECRET is not set in the environment — scheduled runs cannot authenticate',
  }
}

async function handle(req: NextRequest) {
  const auth = await authorise(req)
  if (!auth.ok) {
    console.error('[reminders] sweep rejected:', auth.why)
    return NextResponse.json({ error: 'Not allowed', reason: auth.why }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    const result = await runReminderSweep(new Date(), { dryRun })
    return NextResponse.json({ ...result, triggeredBy: auth.by })
  } catch (err) {
    console.error('[reminders] sweep failed:', err)
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Sweep failed' }, { status: 500 })
  }
}

// Vercel Cron issues a GET; manual triggers tend to POST. Both do the same work.
export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
