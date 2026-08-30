import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { CRM_WA_OUT_ROLE } from '@/lib/crm'
import { parseWaMessage } from '@/lib/whatsapp'
import { resolveLeadSite } from '@/lib/leadrecord'

export const dynamic = 'force-dynamic'

// What WhatsApp actually did with a message we sent.
//
// This exists because "Twilio accepted it" and "the customer got it" are
// different facts, and the CRM only ever recorded the first. Two messages sat
// on a real record reading "WhatsApp sent" having reached nobody — the 24-hour
// window had closed, and WhatsApp reported that minutes later, to nowhere.
//
// Append-only like everything else: a second row for the same message SID, and
// the timeline takes the newest. Nothing is updated in place, so the send and
// its outcome both stay in the record.
//
// Only meaningful states are written. Twilio sends 'queued' → 'sent' →
// 'delivered' → 'read', and writing a row for each would put four copies of
// every message in the table for no gain.
const WORTH_RECORDING = new Set(['delivered', 'read', 'failed', 'undelivered'])

export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return new NextResponse('', { status: 204 })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    console.warn('[whatsapp] refused a status webhook with a bad signature')
    return new NextResponse('Bad signature', { status: 403 })
  }

  const leadId = req.nextUrl.searchParams.get('leadId') ?? ''
  const sid = params.MessageSid ?? params.SmsSid ?? ''
  const status = params.MessageStatus ?? params.SmsStatus ?? ''
  if (!leadId || !sid || !WORTH_RECORDING.has(status)) return new NextResponse('', { status: 204 })

  const resolved = await resolveLeadSite(leadId)
  if (!resolved) return new NextResponse('', { status: 204 })

  // Carry the message itself forward from the row written when it was sent, so
  // the folded timeline entry keeps its text, its author and its send time.
  const { data: rows } = await supabase.from('chat_logs')
    .select('message').eq('session_id', leadId).eq('role', CRM_WA_OUT_ROLE)
    .order('created_at', { ascending: false }).limit(50)
  let original = null
  for (const r of rows ?? []) {
    const w = parseWaMessage(r.message)
    if (w?.sid === sid) { original = w; break }
  }
  if (!original) return new NextResponse('', { status: 204 })

  const errorCode = Number(params.ErrorCode ?? '0') || undefined
  await supabase.from('chat_logs').insert([{
    session_id: leadId, site_id: resolved.siteId, role: CRM_WA_OUT_ROLE,
    message: JSON.stringify({ ...original, status, errorCode }),
  }])

  return new NextResponse('', { status: 204 })
}
