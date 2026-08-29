import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { disconnect } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

// Forget this agent's Gmail credential. Append-only like every control row: a
// revoked marker is written rather than the old row being deleted, so the audit
// trail of who connected what and when survives.
// ADMINS ONLY (2026-08-29). The sports mailbox is connected under the account
// an AGENT signs in with, so without this the agent could cut the workspace's
// only Gmail connection — no leak, but sending and reply capture stop until
// somebody with the Google password reconnects. There is no button for it in
// the UI; this closes the endpoint itself, which is the half that actually
// holds against anyone who opens devtools.
//
// The owner's way out if a connection ever has to be dropped: revoke ZeeOps
// from the Google account's own "Third-party apps" page, which kills the
// refresh token, or make the member an admin for the minute it takes.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (member.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin can disconnect Gmail.' }, { status: 403 })
  }
  await disconnect(member.email)
  return NextResponse.json({ ok: true })
}
