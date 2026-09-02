import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioAuth, verifyTwilioSignature, workspaceForBusinessNumber } from '@/lib/twilio'
import { CRM_CALL_ROLE } from '@/lib/crm'
import { leadForCaller } from '@/lib/inbound'
import { resolveLeadSite } from '@/lib/leadrecord'
import { CALL_LEAD_MESSAGE, WHATSAPP_CALL_LEAD_MESSAGE, VOICEMAIL_LEAD_MESSAGE } from '@/lib/quoteintake'

export const dynamic = 'force-dynamic'

// A recording has finished. TWO KINDS arrive here:
//
//   • a VOICEMAIL, from lib/voicemail.ts's <Record> — nobody picked up, and the
//     recording IS the whole contact, so it creates the lead and the timeline
//     event together;
//
//   • an ANSWERED CALL, from a <Dial record="…"> (lib/callrecording.ts) — the
//     phone line, the browser softphone, the ring-my-mobile flow and a WhatsApp
//     call all land here. The call itself is already on the record; this only
//     has to attach the audio to it.
//
// They are told apart by `kind=call` on the callback URL. The signature covers
// the query string, so that marker cannot be forged.
//
// Whose lead it is — matched on the number, or created if nobody matches — is
// lib/inbound.ts's job, shared with the WhatsApp and answered-call paths so the
// three cannot drift.

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

  // `From` is not one of the recording callback's parameters — it is put on the
  // URL by whichever handler asked for the recording. The param is still read
  // first in case Twilio ever sends one.
  const from = params.From || req.nextUrl.searchParams.get('from') || ''
  const sid = params.CallSid ?? params.RecordingSid ?? ''
  const recordingSid = params.RecordingSid ?? ''
  const duration = Number(params.RecordingDuration ?? '0') || 0
  const called = params.To || req.nextUrl.searchParams.get('to') || ''
  const isCall = req.nextUrl.searchParams.get('kind') === 'call'
  const leadId = req.nextUrl.searchParams.get('leadId') || ''
  if (!sid || !recordingSid) return new NextResponse('', { status: 204 })

  // ── An answered call, dialled FROM a record ───────────────────────────────
  // The lead is already known, so nothing is matched or created — the audio is
  // simply attached to the call that is already sitting on the timeline.
  if (isCall && leadId) {
    const resolved = await resolveLeadSite(leadId)
    if (!resolved) return new NextResponse('', { status: 204 })
    await supabase.from('chat_logs').insert([{
      session_id: leadId, site_id: resolved.siteId, role: CRM_CALL_ROLE,
      // Only the two fields this row actually knows. `status`, `by`, `at` and
      // the call's real duration are left blank ON PURPOSE: the rows for one
      // call are folded together (lib/leadrecord.ts), and a blank field there
      // keeps what the earlier row said instead of overwriting it with nothing.
      // RecordingDuration is the length of the AUDIO, not of the call, and the
      // two differ — so it is deliberately not written as the duration.
      message: JSON.stringify({ sid, by: '', at: '', status: '', recordingSid }),
    }])
    return new NextResponse('', { status: 204 })
  }

  if (!from) return new NextResponse('', { status: 204 })

  // Whose call this is. Without it the recording could be filed on the other
  // business's lead list, which is the one thing these two must never do.
  const workspace = workspaceForBusinessNumber(called)
  if (!workspace) return new NextResponse('', { status: 204 })

  // An inbound call that was ANSWERED still reaches here without a lead id, so
  // it is resolved by number — and it must describe itself as a call, not as a
  // voicemail, because this callback can beat the after-dial handler to
  // creating the lead and whichever gets there first writes the sentence the
  // record will keep.
  const whatsApp = called.startsWith('whatsapp:') || from.startsWith('whatsapp:')
  const message = !isCall ? VOICEMAIL_LEAD_MESSAGE
    : whatsApp ? WHATSAPP_CALL_LEAD_MESSAGE
    : CALL_LEAD_MESSAGE
  const found = await leadForCaller(from.replace(/^whatsapp:/, ''), workspace, message, { calledNumber: called })
  if (!found) return new NextResponse('', { status: 204 })

  await supabase.from('chat_logs').insert([{
    session_id: found.sessionId, site_id: found.siteId, role: CRM_CALL_ROLE,
    message: JSON.stringify(
      isCall
        ? { sid, by: '', at: '', status: '', recordingSid }
        : { sid, by: '', at: new Date().toISOString(), status: 'voicemail', duration, recordingSid },
    ),
  }])

  return new NextResponse('', { status: 204 })
}
