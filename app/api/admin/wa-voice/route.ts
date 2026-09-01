import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { twilioAuth, twilioConfig } from '@/lib/twilio'
import { voiceTokenConfig } from '@/lib/voicetoken'
import { hasFeature } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

// TEMPORARY. Points a WhatsApp sender's voice endpoint at our TwiML App, so a
// customer pressing Call inside the chat reaches the CRM — then it is deleted.
//
// On the server because the auth token lives in the Vercel environment and
// `vercel env pull` returns sensitive values empty.
//
// GET lists the senders (read-only); POST sets voice_application_sid on one.
const API = 'https://messaging.twilio.com/v2/Channels/Senders'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const auth = twilioAuth()
  if (!auth) return NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 })

  const res = await fetch(API, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${auth.sid}:${auth.token}`).toString('base64') },
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: j?.message ?? `list failed (${res.status})` }, { status: 502 })
  return NextResponse.json({
    appSid: voiceTokenConfig()?.appSid ?? null,
    mine: {
      sports: twilioConfig('sports')?.whatsappFrom ?? '',
      packaging: twilioConfig('packaging')?.whatsappFrom ?? '',
    },
    senders: (j.senders ?? []).map((s: Record<string, unknown>) => ({
      sid: s.sid, sender_id: s.sender_id, status: s.status,
      voice_application_sid: (s.configuration as Record<string, unknown> | undefined)?.voice_application_sid ?? null,
    })),
  })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  if (!hasFeature(member.workspace, 'telephony')) {
    return NextResponse.json({ error: 'Not this workspace.' }, { status: 403 })
  }
  const auth = twilioAuth()
  const app = voiceTokenConfig()?.appSid
  if (!auth || !app) return NextResponse.json({ error: 'Twilio or the TwiML App is not configured.' }, { status: 503 })

  const { senderSid } = await req.json().catch(() => ({}))
  if (!/^XE[0-9a-f]{32}$/i.test(String(senderSid ?? ''))) {
    return NextResponse.json({ error: 'Give the sender SID to configure.' }, { status: 400 })
  }

  const res = await fetch(`${API}/${senderSid}`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${auth.sid}:${auth.token}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ configuration: { voice_application_sid: app } }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: j?.message ?? `update failed (${res.status})`, detail: j }, { status: 502 })
  return NextResponse.json({ ok: true, sid: j.sid, configuration: j.configuration })
}
