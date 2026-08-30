import { NextRequest, NextResponse } from 'next/server'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'

export const dynamic = 'force-dynamic'

// Somebody dialled the business number.
//
// Until the browser softphone lands this answers with a greeting and takes a
// message. It matters more than it sounds: the number is printed on the sites
// now, and an unconfigured Twilio number plays Twilio's own demo recording
// ("thanks for trying our documentation") to whoever calls — which is worse
// than not answering at all.
//
// The recording is posted to /recording below, where it is attached to the
// caller's lead.
function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return xml('<Response><Say>This service is not configured.</Say></Response>')

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    return new NextResponse('Bad signature', { status: 403 })
  }

  const origin = `${proto}://${host}`
  // Voice and wording chosen to sound like a business, not a robot reading a
  // form: short, says what happens next, and asks for the one thing that makes
  // a callback possible.
  return xml(
    '<Response>'
    + '<Say voice="Polly.Joanna">Thanks for calling. Our team is not available right now.</Say>'
    + '<Say voice="Polly.Joanna">Please leave your name, your team, and what you need after the tone, and we will get back to you.</Say>'
    + `<Record maxLength="120" playBeep="true" trim="trim-silence" recordingStatusCallback="${origin}/api/twilio/voice/recording" recordingStatusCallbackMethod="POST" />`
    + '<Say voice="Polly.Joanna">We did not get a message. Goodbye.</Say>'
    + '</Response>',
  )
}
