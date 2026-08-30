import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { identityFor, voiceTokenConfig } from '@/lib/voicetoken'
import { findLeadByPhone } from '@/lib/inbound'
import { voicemailTwiml } from '@/lib/voicemail'
import { HARDCODED_ACCOUNTS } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Somebody dialled the business number.
//
// WHAT HAPPENS, in order:
//   1. every agent's BROWSER rings, for 20 seconds — whoever has the dashboard
//      open picks up and talks from the tab;
//   2. nobody answers → the greeting plays and a message is taken.
//
// No mobile is ever rung. That is a decision, not an omission: the owner does
// not want calls forwarded to his own line, and the agents are remote, so the
// dashboard is the phone. The voicemail is the floor beneath it — before this
// endpoint existed, an unconfigured Twilio number played Twilio's own demo
// recording to whoever called, which is worse than not answering.
//
// ── The customer's number does NOT reach the agent's browser ────────────────
// This is the part that is easy to get wrong. By default the client leg's
// `From` is the caller's own number, and the Voice SDK hands that straight to
// page JavaScript — which would undo the whole contact-privacy rule in one
// attribute. So `callerId` is pinned to the BUSINESS number, and what the agent
// actually needs (who is calling, and which lead to open) travels as named
// parameters instead: a name, and a lead id. Never a number.
const RING_SECONDS = 20
/** Twilio allows ten legs in one Dial; the cap is here so a workspace that
 *  grows to fifty members does not produce a rejected TwiML document. */
const MAX_CLIENT_LEGS = 8

function xml(body: string): NextResponse {
  return new NextResponse(body, { headers: { 'Content-Type': 'text/xml' } })
}

function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c))
}

/** Every member who could pick up — this workspace only. */
async function ringableAgents(): Promise<string[]> {
  const { data } = await supabase
    .from('members').select('email').eq('workspace', 'sports').limit(MAX_CLIENT_LEGS)
  const emails = (data ?? []).map((m) => String(m.email || '').toLowerCase()).filter(Boolean)
  const builtin = HARDCODED_ACCOUNTS.find((a) => a.workspace === 'sports')?.email
  if (builtin && !emails.includes(builtin) && emails.length < MAX_CLIENT_LEGS) emails.push(builtin)
  return emails
}

export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return xml('<Response><Say>This service is not configured.</Say></Response>')

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    return new NextResponse('Bad signature', { status: 403 })
  }

  const origin = `${proto}://${host}`
  // WHO called has to travel in the callback URL. Twilio's recording callback
  // carries RecordingSid, CallSid and a duration — and NOT `From`, which is the
  // one field the CRM needs to know whose lead this voicemail belongs to. The
  // first version read `From` there, found nothing, and dropped every voicemail
  // in silence. The signature covers the query string too, so this stays
  // verifiable.
  const caller = params.From ?? ''

  // Without a TwiML App there is no softphone to ring, so this is voicemail-
  // only — exactly as it behaved before the softphone existed.
  const agents = voiceTokenConfig() ? await ringableAgents() : []
  if (agents.length === 0) {
    return xml(`<Response>${voicemailTwiml(origin, caller, params.To || req.nextUrl.searchParams.get('to') || '')}</Response>`)
  }

  // Who is calling, for the agent's screen. Looked up but never created: a
  // spam call that rings out must not leave a lead behind.
  const known = caller ? await findLeadByPhone(caller) : null
  const label = known?.name?.trim() || 'New caller'

  const after = `${origin}/api/twilio/voice/incoming/after?from=${encodeURIComponent(caller)}`
  const legs = agents.map((email) => (
    `<Client>`
    + `<Identity>${escapeXml(identityFor(email))}</Identity>`
    + `<Parameter name="leadName" value="${escapeXml(label)}" />`
    + (known ? `<Parameter name="leadId" value="${escapeXml(known.sessionId)}" />` : '')
    + `</Client>`
  )).join('')

  return xml(
    '<Response>'
    // answerOnBridge: the caller hears ringing rather than silence while the
    // browsers are being tried.
    + `<Dial timeout="${RING_SECONDS}" answerOnBridge="true" callerId="${escapeXml(cfg.phoneNumber)}"`
    + ` action="${escapeXml(after)}" method="POST">`
    + legs
    + '</Dial>'
    + '</Response>',
  )
}
