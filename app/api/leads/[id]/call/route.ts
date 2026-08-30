import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow, leadPhone } from '@/lib/leadrecord'
import { twilioConfig, placeCall } from '@/lib/twilio'
import { memberCallPhone } from '@/lib/membername'
import { CRM_CALL_ROLE } from '@/lib/crm'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Place a call between this agent and this lead.
//
// The request carries NO phone numbers at all. The agent's own number comes
// from their member profile, the customer's from the lead — both on the server.
// The browser cannot influence who is dialled beyond naming the lead it is
// already allowed to open.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const cfg = twilioConfig()
  if (!cfg || !cfg.phoneNumber) {
    return NextResponse.json({ error: 'Calling is not configured on the server.', needsSetup: true }, { status: 503 })
  }

  const agentPhone = await memberCallPhone(access.member.email)
  if (!agentPhone) {
    return NextResponse.json({
      error: 'Your own phone number is not set, so there is nothing to ring. An admin can add it on the Members page.',
    }, { status: 400 })
  }

  const customer = await leadPhone(id)
  if (!customer) {
    return NextResponse.json({ error: 'This lead has no phone number on file.' }, { status: 400 })
  }

  const origin = req.nextUrl.origin
  // The lead id — not the customer's number — travels in the callback URL. The
  // number is looked up again when Twilio asks, and that request is signed.
  const twimlUrl = `${origin}/api/twilio/voice/connect?leadId=${encodeURIComponent(id)}`
  const statusUrl = `${origin}/api/twilio/voice/status?leadId=${encodeURIComponent(id)}`

  let placed
  try {
    placed = await placeCall(cfg, agentPhone, twimlUrl, statusUrl)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'The call could not be placed.' }, { status: 502 })
  }

  await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_CALL_ROLE,
    message: JSON.stringify({
      sid: placed.sid, by: access.member.email, at: new Date().toISOString(), status: 'ringing',
    }),
  })

  // Neither number is echoed back — the agent is not allowed to read either of
  // them, and a response is as good a leak as a page.
  return NextResponse.json({ ok: true, ringing: true })
}
