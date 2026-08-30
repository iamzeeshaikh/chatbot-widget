import { NextRequest, NextResponse } from 'next/server'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { leadPhone } from '@/lib/leadrecord'

export const dynamic = 'force-dynamic'

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c))
}

// Twilio asks: "the agent picked up — now what?" The answer is: dial the
// customer and bridge them.
//
// SIGNED, like every webhook here. This endpoint turns a lead id into a
// customer's phone number, so an unsigned version would be a public lookup
// service for exactly the thing the whole design keeps hidden.
export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return xml('<Response><Say>This service is not configured.</Say></Response>')

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  // The signed URL includes the query string, so it is rebuilt in full.
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    console.warn('[voice] refused a connect webhook with a bad signature')
    return new NextResponse('Bad signature', { status: 403 })
  }

  const leadId = req.nextUrl.searchParams.get('leadId') ?? ''
  const customer = leadId ? await leadPhone(leadId) : null
  if (!customer) {
    return xml('<Response><Say>That lead no longer has a phone number.</Say></Response>')
  }

  // callerId is the BUSINESS number: the customer sees the company, never the
  // agent's own line.
  return xml(
    '<Response>'
    + `<Dial callerId="${escapeXml(cfg.phoneNumber)}" timeout="30">`
    + `<Number>${escapeXml(customer)}</Number>`
    + '</Dial>'
    + '</Response>',
  )
}
