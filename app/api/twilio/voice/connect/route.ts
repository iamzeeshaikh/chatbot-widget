import { NextRequest, NextResponse } from 'next/server'
import { twilioAuth, twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { leadPhone, resolveLeadSite } from '@/lib/leadrecord'
import { siteWorkspace } from '@/lib/workspaces'
import { recordAttrs } from '@/lib/callrecording'

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
  const auth = twilioAuth()
  if (!auth) return xml('<Response><Say>This service is not configured.</Say></Response>')

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  // The signed URL includes the query string, so it is rebuilt in full.
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(auth.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    console.warn('[voice] refused a connect webhook with a bad signature')
    return new NextResponse('Bad signature', { status: 403 })
  }

  const leadId = req.nextUrl.searchParams.get('leadId') ?? ''
  const customer = leadId ? await leadPhone(leadId) : null
  if (!customer) {
    return xml('<Response><Say>That lead no longer has a phone number.</Say></Response>')
  }
  // The caller ID comes from the LEAD's own business, never from a default:
  // showing a packaging customer the sports number would be the mix-up this
  // whole split exists to prevent.
  const resolved = await resolveLeadSite(leadId)
  const workspace = resolved ? siteWorkspace(resolved.siteId) : null
  const cfg = workspace ? twilioConfig(workspace) : null
  if (!cfg || !cfg.phoneNumber) {
    return xml('<Response><Say>Calling is not set up for this account.</Say></Response>')
  }

  // callerId is the BUSINESS number: the customer sees the company, never the
  // agent's own line.
  const origin = `${proto}://${host}`
  return xml(
    '<Response>'
    + `<Dial callerId="${escapeXml(cfg.phoneNumber)}" timeout="30"${recordAttrs(origin, { leadId })}>`
    + `<Number>${escapeXml(customer)}</Number>`
    + '</Dial>'
    + '</Response>',
  )
}
