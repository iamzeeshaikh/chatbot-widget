import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioAuth, verifyTwilioSignature } from '@/lib/twilio'
import { CRM_CALL_ROLE } from '@/lib/crm'
import { parseCall } from '@/lib/call'
import { resolveLeadSite } from '@/lib/leadrecord'

export const dynamic = 'force-dynamic'

// How the call ended, written onto the lead when Twilio reports it.
//
// Append-only, like everything else: a second row for the same call SID, and
// the reader takes the newest. Nothing is updated in place, so "who called, and
// what happened" stays in the record.
export async function POST(req: NextRequest) {
  const auth = twilioAuth()
  if (!auth) return new NextResponse('', { status: 204 })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(auth.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    return new NextResponse('Bad signature', { status: 403 })
  }

  const leadId = req.nextUrl.searchParams.get('leadId') ?? ''
  const sid = params.CallSid ?? ''
  if (!leadId || !sid) return new NextResponse('', { status: 204 })

  const resolved = await resolveLeadSite(leadId)
  if (!resolved) return new NextResponse('', { status: 204 })

  // Carry forward who placed it, from the row written when it was dialled.
  const { data: rows } = await supabase.from('chat_logs')
    .select('message').eq('session_id', leadId).eq('role', CRM_CALL_ROLE)
    .order('created_at', { ascending: false }).limit(50)
  let by = ''
  let at = ''
  for (const r of rows ?? []) {
    const c = parseCall(r.message)
    if (c?.sid === sid) { by = c.by; at = c.at; break }
  }

  await supabase.from('chat_logs').insert([{
    session_id: leadId,
    site_id: resolved.siteId,
    role: CRM_CALL_ROLE,
    message: JSON.stringify({
      sid, by, at: at || new Date().toISOString(),
      // Two callers, two vocabularies: Twilio's StatusCallback reports
      // CallStatus/CallDuration, while a <Dial action> — which is how a call
      // placed from the BROWSER comes back — reports DialCallStatus and
      // DialCallDuration. Reading only the first shape recorded every softphone
      // call as a zero-second 'completed'.
      status: params.DialCallStatus || params.CallStatus || 'completed',
      duration: Number(params.DialCallDuration ?? params.CallDuration ?? '0') || 0,
    }),
  }])

  // Two callers again. A StatusCallback ignores whatever comes back; a <Dial
  // action> — the browser softphone's path — plays it to the AGENT, who is
  // still on the line and otherwise just gets cut off in silence. Saying what
  // happened is the difference between "nobody picked up" and "this thing is
  // broken", which is exactly how an unanswered call was read the first time.
  const outcome = params.DialCallStatus ?? ''
  const spoken = outcome === 'no-answer' ? 'There was no answer.'
    : outcome === 'busy' ? 'The line was busy.'
    : outcome === 'failed' ? 'The call could not be connected.'
    : ''
  if (spoken) {
    return new NextResponse(
      `<Response><Say voice="Polly.Joanna">${spoken}</Say><Hangup /></Response>`,
      { headers: { 'Content-Type': 'text/xml' } },
    )
  }
  return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
}
