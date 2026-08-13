import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { runEmailSweep, lastSweepStatus } from '@/lib/emailsweep'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The scheduled inbound-reply sweep.
//
// Same triggering pattern as /api/tasks/reminders/sweep: a secret-protected
// endpoint driven by an external clock, accepting either
//
//   Authorization: Bearer <CRON_SECRET>   ← what Vercel Cron sends
//   x-cron-secret: <CRON_SECRET>
//
// with a signed-in admin allowed to run it by hand so it stays debuggable
// without putting the secret in a browser.
//
// The work is idempotent (deduped on Gmail's own message ids), so running late,
// twice, or after a missed window is safe.
async function authorise(req: NextRequest): Promise<{ ok: boolean; by: string; why?: string }> {
  const secret = process.env.CRON_SECRET
  if (secret) {
    if (req.headers.get('authorization') === `Bearer ${secret}`) return { ok: true, by: 'cron' }
    if (req.headers.get('x-cron-secret') === secret) return { ok: true, by: 'trigger' }
  }
  // The sweep is global infrastructure: one run walks every workspace's threads,
  // and its result names the agents, lead ids and recipients involved. So the
  // manual trigger — and `?status=1`, which returns that same result — is
  // limited to an admin of a workspace that actually carries the email feature.
  // Before this, a sports admin polling ?status=1 was handed packaging agents'
  // addresses. The CRON_SECRET path above is untouched.
  const member = await getMember(req)
  if (member?.role === 'admin' && hasFeature(member.workspace, 'email')) {
    return { ok: true, by: `admin:${member.email}` }
  }
  return {
    ok: false,
    by: '',
    why: secret
      ? 'Bad or missing cron secret'
      : 'CRON_SECRET is not set in the environment — scheduled runs cannot authenticate, so replies would never be captured',
  }
}

export async function GET(req: NextRequest) {
  const auth = await authorise(req)
  if (!auth.ok) return NextResponse.json({ error: auth.why }, { status: 401 })

  // ?dryRun=1 reports what would be captured and writes nothing.
  // ?status=1 reads the last run without performing one.
  if (req.nextUrl.searchParams.get('status') === '1') {
    return NextResponse.json({ ok: true, last: await lastSweepStatus() })
  }

  try {
    const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
    const result = await runEmailSweep(req.nextUrl.origin, new Date(), { dryRun })
    return NextResponse.json({ ok: true, by: auth.by, ...result })
  } catch (err) {
    // A total failure is still reported rather than swallowed — the cron log
    // and the response both name the cause.
    console.error('[email-sweep] failed:', err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'The reply sweep failed' },
      { status: 500 },
    )
  }
}
