import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioAuth, verifyTwilioSignature, workspaceForBusinessNumber } from '@/lib/twilio'
import { CRM_CALL_ROLE } from '@/lib/crm'
import { leadForCaller } from '@/lib/inbound'

export const dynamic = 'force-dynamic'

// A voicemail, attached to whoever left it. Who that is — matched on the
// number, or created if nobody matches — is lib/inbound.ts's job, shared with
// the WhatsApp and answered-call paths so the three cannot drift.

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
  // URL by the greeting handler. The param is still read first in case Twilio
  // ever sends one.
  const from = params.From || req.nextUrl.searchParams.get('from') || ''
  const sid = params.CallSid ?? params.RecordingSid ?? ''
  const recordingSid = params.RecordingSid ?? ''
  const duration = Number(params.RecordingDuration ?? '0') || 0
  if (!from || !sid) return new NextResponse('', { status: 204 })

  const called = params.To || req.nextUrl.searchParams.get('to') || ''
  // Whose voicemail this is. Without it the message could be filed on the other
  // business's lead list, which is the one thing these two must never do.
  const workspace = workspaceForBusinessNumber(called)
  if (!workspace) return new NextResponse('', { status: 204 })
  const found = await leadForCaller(from, workspace, 'Voicemail — the caller left a message on the phone line.', {
    calledNumber: called,
  })
  const sessionId = found?.sessionId ?? null
  const siteId = found?.siteId ?? ''

  if (sessionId) {
    await supabase.from('chat_logs').insert([{
      session_id: sessionId, site_id: siteId, role: CRM_CALL_ROLE,
      message: JSON.stringify({
        sid, by: '', at: new Date().toISOString(),
        status: 'voicemail', duration, recordingSid,
      }),
    }])
  }

  return new NextResponse('', { status: 204 })
}
