import { NextRequest, NextResponse } from 'next/server'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'

export const dynamic = 'force-dynamic'

// TEMPORARY, for one end-to-end test of the voicemail.
//
// This is the CALLER's side of a test call the server places to the business
// number: it waits for the greeting to finish, says something, and hangs up —
// so the recording that lands on the lead is a real one, taken the same way a
// customer's would be. Deleted once the test has passed.
export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    return new NextResponse('Bad signature', { status: 403 })
  }

  return new NextResponse(
    '<Response>'
    + '<Pause length="9"/>'
    + '<Say voice="Polly.Matthew">Hello, this is a test message. I am looking for volleyball uniforms for twenty four players. Please call me back.</Say>'
    + '<Pause length="2"/>'
    + '<Hangup/>'
    + '</Response>',
    { headers: { 'Content-Type': 'text/xml' } },
  )
}
