import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioAuth, verifyTwilioSignature, workspaceForBusinessNumber } from '@/lib/twilio'
import { CRM_CALL_ROLE } from '@/lib/crm'
import { leadForCaller } from '@/lib/inbound'
import { voicemailTwiml } from '@/lib/voicemail'

export const dynamic = 'force-dynamic'

// The browsers were rung. What happened?
//
// ANSWERED  → the call is over and it belongs on the customer's record. Twilio
//             comes back here when the bridge ends, so this is also where the
//             duration is known.
// ANYTHING  → nobody was at the dashboard, or they declined. Fall through to
// ELSE        the greeting and take a message, which is what this number did
//             before the softphone existed.
//
// The fall-through is the point of the whole route: a missed call must never
// end in silence, and the states that mean "missed" are several (no-answer,
// busy, failed, canceled), so it is 'completed' that is special-cased and
// everything else that lands on voicemail.
function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

export async function POST(req: NextRequest) {
  const auth = twilioAuth()
  if (!auth) return xml('<Response><Say>This service is not configured.</Say></Response>')

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(auth.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    return new NextResponse('Bad signature', { status: 403 })
  }

  const origin = `${proto}://${host}`
  const caller = params.From || req.nextUrl.searchParams.get('from') || ''
  const status = params.DialCallStatus ?? ''

  if (status !== 'completed') {
    return xml(`<Response>${voicemailTwiml(origin, caller, params.To || req.nextUrl.searchParams.get('to') || '')}</Response>`)
  }

  // Answered in the dashboard. Record it against the customer — creating the
  // lead now, because a call somebody actually took is a real contact.
  const duration = Number(params.DialCallDuration ?? '0') || 0
  const called = params.To || req.nextUrl.searchParams.get('to') || ''
  const workspace = workspaceForBusinessNumber(called)
  const found = caller && workspace
    ? await leadForCaller(caller, workspace, 'Called the phone line and spoke to the team.', { calledNumber: called })
    : null
  if (found) {
    await supabase.from('chat_logs').insert([{
      session_id: found.sessionId, site_id: found.siteId, role: CRM_CALL_ROLE,
      message: JSON.stringify({
        sid: params.CallSid ?? '', by: '', at: new Date().toISOString(),
        status: 'inbound', duration,
      }),
    }])
  }
  // The conversation is over; saying anything here would talk over the hang-up.
  return xml('<Response><Hangup /></Response>')
}
