import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { dialable } from '@/lib/identity'
import { findLeadByPhone, leadForCaller } from '@/lib/inbound'
import { setAssignment } from '@/lib/assignment'
import { resolveLeadSite } from '@/lib/leadrecord'

export const dynamic = 'force-dynamic'

// The dial pad's one job: turn a TYPED NUMBER into a lead to call.
//
// Every call in this product is placed against a lead id — that is what carries
// the recording, the timeline entry and the "who rang whom" of it. So a dial
// pad that could ring an arbitrary number would be the one call that leaves no
// trace, which is exactly the call you most want a record of.
//
// Instead the number is resolved first:
//   • a lead already holds it  → that lead, and the call joins its history
//   • nothing holds it         → a lead is created for it, assigned to the
//                                agent who dialled, and the call lands there
//
// Nothing about the Twilio path changes: the browser still sends only a lead
// id, and the server still looks the number up. The pad widens WHO can be
// called, never what an agent can read.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'telephony')) {
    return NextResponse.json({ error: 'Calling is not available on this dashboard.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const typed = String(body?.phone ?? '').trim()
  const number = dialable(typed)
  if (!number) {
    return NextResponse.json({ error: 'That does not look like a phone number.' }, { status: 400 })
  }

  const existing = await findLeadByPhone(number, member.workspace)
  if (existing) {
    return NextResponse.json({
      ok: true, created: false,
      leadId: existing.sessionId, name: existing.name, siteId: existing.siteId,
    })
  }

  // Said plainly on the record, because a lead created this way asserts nothing
  // about where the number came from — the agent typed it, and only they know
  // whether it was a business card, a returned missed call or a referral.
  const made = await leadForCaller(
    number, member.workspace,
    `Outbound call: ${member.email} dialled this number from the dial pad. This record was created for the call — nothing is known about where the number came from.`,
  )
  if (!made) return NextResponse.json({ error: 'That number cannot be called.' }, { status: 400 })

  // Theirs, not the pool's: they are the one person who knows what this call is
  // about, and an unassigned record with a single outbound call on it tells the
  // next person nothing.
  await setAssignment(made.sessionId, made.siteId, member.email)

  const resolved = await resolveLeadSite(made.sessionId)
  return NextResponse.json({
    ok: true, created: true,
    leadId: made.sessionId, name: '', siteId: resolved?.siteId ?? made.siteId,
  })
}
