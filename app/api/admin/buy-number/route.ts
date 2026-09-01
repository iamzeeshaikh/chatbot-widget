import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { twilioConfig } from '@/lib/twilio'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// TEMPORARY. Searches for and buys one phone number, then is deleted.
//
// It exists on the server because the Twilio auth token lives in the Vercel
// environment and `vercel env pull` returns sensitive values EMPTY, so there is
// nowhere else the credentials can be used from. An endpoint that can SPEND
// MONEY is not something to leave deployed: GET searches (free), POST buys, and
// both are gone as soon as the number exists.
const API = 'https://api.twilio.com/2010-04-01'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const cfg = twilioConfig()
  if (!cfg) return NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 })

  const area = req.nextUrl.searchParams.get('area') ?? ''
  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')
  const qs = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '8' })
  if (area) qs.set('AreaCode', area)

  const res = await fetch(`${API}/Accounts/${cfg.sid}/AvailablePhoneNumbers/US/Local.json?${qs}`, {
    headers: { Authorization: auth },
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: j?.message ?? `search failed (${res.status})` }, { status: 502 })
  return NextResponse.json({
    numbers: (j.available_phone_numbers ?? []).map((n: Record<string, unknown>) => ({
      number: n.phone_number, friendly: n.friendly_name,
      region: n.region, locality: n.locality,
      capabilities: n.capabilities,
    })),
  })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const cfg = twilioConfig()
  if (!cfg) return NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 })

  const { number } = await req.json().catch(() => ({}))
  if (!/^\+1\d{10}$/.test(String(number ?? ''))) {
    return NextResponse.json({ error: 'Give an E.164 US number to buy.' }, { status: 400 })
  }

  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')
  const origin = req.nextUrl.origin
  const res = await fetch(`${API}/Accounts/${cfg.sid}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      PhoneNumber: String(number),
      FriendlyName: 'ZeeOps Packaging',
      // Pointed at the same webhooks the sports number uses. They route by the
      // number that was DIALLED, so a packaging call lands on a packaging lead —
      // see lib/inbound.ts.
      VoiceUrl: `${origin}/api/twilio/voice/incoming`,
      VoiceMethod: 'POST',
      SmsUrl: `${origin}/api/twilio/whatsapp`,
      SmsMethod: 'POST',
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: j?.message ?? `purchase failed (${res.status})` }, { status: 502 })
  return NextResponse.json({ ok: true, sid: j.sid, number: j.phone_number, friendlyName: j.friendly_name })
}
