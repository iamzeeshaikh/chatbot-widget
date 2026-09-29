import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { twilioAuth } from '@/lib/twilio'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// TEMPORARY. Buys a US number for RFQ OS (rfq-os.vercel.app), registers it as a
// WhatsApp sender on the same WABA as the ZeeOps numbers, and hands RFQ OS the
// account credentials once. Deleted as soon as that is done.
//
// It exists here because the Twilio auth token lives only in this project's
// Vercel environment and `vercel env pull` returns sensitive values EMPTY.
// Admin-only; GET is read-only, POST spends money or reveals the token.
const API = 'https://api.twilio.com/2010-04-01'
const SENDERS = 'https://messaging.twilio.com/v2/Channels/Senders'
const RFQ_OS = 'https://rfq-os.vercel.app'

async function guard(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  const cfg = twilioAuth()
  if (!cfg) return { error: NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 }) }
  return { cfg, auth: 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64') }
}

async function call(url: string, auth: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: auth, ...(init.headers ?? {}) } })
  const j = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, j }
}

export async function GET(req: NextRequest) {
  const g = await guard(req)
  if ('error' in g) return g.error
  const p = req.nextUrl.searchParams

  if (p.get('senders') === '1') {
    const r = await call(`${SENDERS}?Channel=whatsapp&PageSize=50`, g.auth)
    return NextResponse.json(r.j, { status: r.ok ? 200 : 502 })
  }
  const sender = p.get('sender')
  if (sender) {
    const r = await call(`${SENDERS}/${encodeURIComponent(sender)}`, g.auth)
    return NextResponse.json(r.j, { status: r.ok ? 200 : 502 })
  }
  if (p.get('owned') === '1') {
    const r = await call(`${API}/Accounts/${g.cfg.sid}/IncomingPhoneNumbers.json?PageSize=50`, g.auth)
    return NextResponse.json({ numbers: (r.j.incoming_phone_numbers ?? []).map((n: Record<string, unknown>) => ({ sid: n.sid, number: n.phone_number, friendlyName: n.friendly_name, smsUrl: n.sms_url })) })
  }
  const qs = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '8' })
  if (p.get('area')) qs.set('AreaCode', p.get('area')!)
  const r = await call(`${API}/Accounts/${g.cfg.sid}/AvailablePhoneNumbers/US/Local.json?${qs}`, g.auth)
  if (!r.ok) return NextResponse.json({ error: r.j?.message ?? `search failed (${r.status})` }, { status: 502 })
  return NextResponse.json({ numbers: (r.j.available_phone_numbers ?? []).map((n: Record<string, unknown>) => ({ number: n.phone_number, region: n.region, locality: n.locality, capabilities: n.capabilities })) })
}

export async function POST(req: NextRequest) {
  const g = await guard(req)
  if ('error' in g) return g.error
  const body = await req.json().catch(() => ({}))

  if (body.action === 'buy') {
    if (!/^\+1\d{10}$/.test(String(body.number ?? ''))) return NextResponse.json({ error: 'Give an E.164 US number to buy.' }, { status: 400 })
    const r = await call(`${API}/Accounts/${g.cfg.sid}/IncomingPhoneNumbers.json`, g.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ PhoneNumber: String(body.number), FriendlyName: 'RFQ OS WhatsApp', SmsUrl: `${RFQ_OS}/api/whatsapp/twilio`, SmsMethod: 'POST' }),
    })
    if (!r.ok) return NextResponse.json({ error: r.j?.message ?? `purchase failed (${r.status})` }, { status: 502 })
    return NextResponse.json({ ok: true, sid: r.j.sid, number: r.j.phone_number })
  }

  if (body.action === 'register') {
    if (!/^\+1\d{10}$/.test(String(body.number ?? '')) || !body.wabaId || !body.name) return NextResponse.json({ error: 'number, wabaId and name are required' }, { status: 400 })
    const r = await call(SENDERS, g.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_id: `whatsapp:${body.number}`,
        configuration: { waba_id: String(body.wabaId) },
        profile: { name: String(body.name) },
        webhook: { callback_url: `${RFQ_OS}/api/whatsapp/twilio`, callback_method: 'POST', status_callback_url: `${RFQ_OS}/api/whatsapp/twilio` },
      }),
    })
    return NextResponse.json(r.j, { status: r.ok ? 200 : 502 })
  }

  if (body.action === 'credentials') {
    return NextResponse.json({ accountSid: g.cfg.sid, authToken: g.cfg.token })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
