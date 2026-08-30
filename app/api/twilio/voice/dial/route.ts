import { NextRequest, NextResponse } from 'next/server'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { emailFromIdentity } from '@/lib/voicetoken'
import { memberByEmail } from '@/lib/auth'
import { guardLeadAccess, writeControlRow, leadPhone } from '@/lib/leadrecord'
import { CRM_CALL_ROLE } from '@/lib/crm'

export const dynamic = 'force-dynamic'

// The TwiML App's Voice URL: an agent's BROWSER has dialled, and Twilio is
// asking what to do about it.
//
// The browser sent a LEAD ID and nothing else. The customer's number is looked
// up here, on the server, exactly as it is for the ring-my-mobile flow — so the
// softphone does not widen what an agent can learn by one digit.
//
// ── Who is allowed to dial this lead ────────────────────────────────────────
// A signed webhook proves the request came from Twilio; it does NOT prove which
// agent is behind it. `From` carries the client identity, which decodes to a
// member, and that member is then put through the ordinary lead guard. Without
// this, any agent's token could dial any lead in the account — including one in
// a workspace they cannot open.
function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c))
}

function say(msg: string): NextResponse {
  return xml(`<Response><Say voice="Polly.Joanna">${escapeXml(msg)}</Say></Response>`)
}

export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return say('This service is not configured.')

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    console.warn('[voice] refused a dial webhook with a bad signature')
    return new NextResponse('Bad signature', { status: 403 })
  }

  // `leadId` is a custom parameter the browser passes to device.connect(); it
  // arrives as an ordinary POST field.
  const leadId = params.leadId ?? params.LeadId ?? ''
  const member = await memberByEmail(emailFromIdentity(params.From ?? ''))
  if (!member) return say('This line is not recognised.')

  const access = await guardLeadAccess(member, leadId, 'telephony')
  if (!access.ok) return say('You are not allowed to call this contact.')

  const customer = await leadPhone(leadId)
  if (!customer) return say('This lead has no phone number on file.')

  const sid = params.CallSid ?? ''
  if (sid) {
    await writeControlRow({
      sessionId: leadId, siteId: access.siteId, role: CRM_CALL_ROLE,
      message: JSON.stringify({
        sid, by: member.email, at: new Date().toISOString(), status: 'ringing', via: 'browser',
      }),
    })
  }

  const origin = `${proto}://${host}`
  const statusUrl = `${origin}/api/twilio/voice/status?leadId=${encodeURIComponent(leadId)}`
  // callerId is the business's number — the customer sees the company, and the
  // agent's browser has no number to show in the first place.
  //
  // NO answerOnBridge HERE, and it is not an oversight. It is right for the
  // INCOMING flow, where the parent is a real caller who should hear ringing
  // instead of silence. On a call that ORIGINATES in the browser it holds the
  // parent leg unanswered — so the SDK tore the call down after two or three
  // seconds, Twilio cancelled the customer leg with it, and the customer's
  // phone never rang at all. The call log then reported 'no-answer' against a
  // leg that lasted ZERO seconds, which reads like the customer ignored a call
  // they were never offered.
  return xml(
    '<Response>'
    + `<Dial callerId="${escapeXml(cfg.phoneNumber)}" timeout="30"`
    + ` action="${escapeXml(statusUrl)}" method="POST">`
    + `<Number>${escapeXml(customer)}</Number>`
    + '</Dial>'
    + '</Response>',
  )
}
