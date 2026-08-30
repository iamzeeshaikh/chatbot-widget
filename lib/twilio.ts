// Twilio: WhatsApp messaging (and, later, voice) for the CRM.
//
// Talks to Twilio's REST API over plain fetch rather than pulling in their SDK —
// the two calls we make are form-encoded POSTs with basic auth, and a dependency
// that ships an HTTP client, a JWT library and a TwiML builder to do that is not
// worth carrying.
//
// CREDENTIALS live in the environment and never leave the server:
//   TWILIO_ACCOUNT_SID    the account, "AC…"
//   TWILIO_AUTH_TOKEN     the secret — also the key incoming webhooks are signed
//                         with, which is why nothing here logs it
//   TWILIO_WHATSAPP_FROM  the sender, "whatsapp:+1…" (the sandbox number while
//                         testing, the business's own number once approved)
//   TWILIO_PHONE_NUMBER   the voice number

import { createHmac, timingSafeEqual } from 'crypto'

const API = 'https://api.twilio.com/2010-04-01'

export interface TwilioConfig { sid: string; token: string; whatsappFrom: string; phoneNumber: string }

export function twilioConfig(): TwilioConfig | null {
  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) return null
  return {
    sid, token,
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM ?? '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? '',
  }
}

/** Human-readable reason the integration cannot run, or null when it can. */
export function twilioProblem(): string | null {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return 'Twilio is not configured on the server (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).'
  }
  if (!process.env.TWILIO_WHATSAPP_FROM) {
    return 'No WhatsApp sender is configured (TWILIO_WHATSAPP_FROM).'
  }
  return null
}

function authHeader(cfg: TwilioConfig): string {
  return 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')
}

/** The account itself — used to prove the credentials work before anything else does. */
export async function fetchAccount(cfg: TwilioConfig): Promise<{ friendlyName: string; status: string }> {
  const res = await fetch(`${API}/Accounts/${cfg.sid}.json`, { headers: { Authorization: authHeader(cfg) } })
  if (!res.ok) throw new Error(`Twilio refused the credentials (${res.status})`)
  const j = await res.json()
  return { friendlyName: String(j.friendly_name ?? ''), status: String(j.status ?? '') }
}

export interface SentWhatsApp { sid: string; status: string }

/**
 * Send a WhatsApp message.
 *
 * `to` is a bare E.164 number ("+15551234567"); the whatsapp: prefix is added
 * here so no caller has to remember it.
 *
 * THE 24-HOUR RULE, because it is the thing that will surprise somebody:
 * WhatsApp only allows a free-form message within 24 hours of the customer's
 * last message. Outside that window Meta rejects anything that is not an
 * approved template, and Twilio returns error 63016. That is surfaced as a
 * readable sentence rather than a code, since the agent can do something about
 * it (wait for a reply, or use another channel).
 */
export async function sendWhatsApp(cfg: TwilioConfig, to: string, body: string): Promise<SentWhatsApp> {
  const form = new URLSearchParams({
    From: cfg.whatsappFrom,
    To: `whatsapp:${to.replace(/^whatsapp:/, '')}`,
    Body: body,
  })
  const res = await fetch(`${API}/Accounts/${cfg.sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: authHeader(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = Number(j?.code ?? 0)
    if (code === 63016) {
      throw new Error('WhatsApp only allows a free reply within 24 hours of the customer’s last message. This conversation is outside that window.')
    }
    if (code === 63015) {
      throw new Error('This number has not joined the WhatsApp sandbox, so Twilio will not deliver to it.')
    }
    throw new Error(String(j?.message ?? `Twilio refused the message (${res.status})`))
  }
  return { sid: String(j.sid ?? ''), status: String(j.status ?? '') }
}

/** The last few calls, for working out why one did not land. */
export async function recentCalls(cfg: TwilioConfig): Promise<unknown[]> {
  const res = await fetch(`${API}/Accounts/${cfg.sid}/Calls.json?PageSize=5`, {
    headers: { Authorization: authHeader(cfg) },
  })
  if (!res.ok) throw new Error(`Twilio refused the call list (${res.status})`)
  const j = await res.json()
  return (j.calls ?? []).map((c: Record<string, unknown>) => ({
    sid: c.sid, from: c.from, to: c.to, status: c.status,
    duration: c.duration, direction: c.direction, at: c.start_time,
  }))
}

/** The last few recordings, to tell "no recording was made" apart from
 *  "the recording was made but our callback never ran". */
export async function recentRecordings(cfg: TwilioConfig): Promise<unknown[]> {
  const res = await fetch(`${API}/Accounts/${cfg.sid}/Recordings.json?PageSize=5`, {
    headers: { Authorization: authHeader(cfg) },
  })
  if (!res.ok) throw new Error(`Twilio refused the recording list (${res.status})`)
  const j = await res.json()
  return (j.recordings ?? []).map((r: Record<string, unknown>) => ({
    sid: r.sid, callSid: r.call_sid, duration: r.duration, status: r.status, at: r.date_created,
  }))
}

export interface PlacedCall { sid: string; status: string }

/**
 * Ring `to`, and when it answers, fetch instructions from `twimlUrl`.
 *
 * `to` here is the AGENT's phone: the call reaches them first, and the TwiML
 * that comes back then dials the customer. The customer's number is never in
 * this request, and never in the browser — it is looked up on the server when
 * Twilio asks what to do next.
 */
export async function placeCall(
  cfg: TwilioConfig, to: string, twimlUrl: string, statusCallback: string,
): Promise<PlacedCall> {
  const form = new URLSearchParams({
    From: cfg.phoneNumber,
    To: to,
    Url: twimlUrl,
    StatusCallback: statusCallback,
    StatusCallbackEvent: 'completed',
    StatusCallbackMethod: 'POST',
  })
  const res = await fetch(`${API}/Accounts/${cfg.sid}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: authHeader(cfg), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(String(j?.message ?? `Twilio refused the call (${res.status})`))
  return { sid: String(j.sid ?? ''), status: String(j.status ?? '') }
}

/**
 * Is this webhook really from Twilio?
 *
 * Twilio signs every webhook with the auth token: HMAC-SHA1 over the full URL
 * with the POST fields appended in sorted order. Without this check the inbound
 * endpoint is a public form anybody could post to — and it writes to a
 * customer's record, so "anybody" would be writing into the CRM.
 *
 * Compared with timingSafeEqual rather than ===, for the usual reason.
 */
export function verifyTwilioSignature(token: string, url: string, params: Record<string, string>, signature: string): boolean {
  if (!signature) return false
  let data = url
  for (const key of Object.keys(params).sort()) data += key + params[key]
  const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
