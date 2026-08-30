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

/** The account itself — used to prove the credentials work before anything else does.
 *
 *  `type` is reported separately from `status` and the two are easy to confuse:
 *  status is active/suspended/closed and says NOTHING about whether the account
 *  is on trial, while type is 'Trial' or 'Full'. A trial account may only dial
 *  numbers verified in the console, which is the difference between "calling is
 *  restricted" and "calling works" — so it is read rather than assumed. */
export async function fetchAccount(cfg: TwilioConfig): Promise<{ friendlyName: string; status: string; type: string }> {
  const res = await fetch(`${API}/Accounts/${cfg.sid}.json`, { headers: { Authorization: authHeader(cfg) } })
  if (!res.ok) throw new Error(`Twilio refused the credentials (${res.status})`)
  const j = await res.json()
  return { friendlyName: String(j.friendly_name ?? ''), status: String(j.status ?? ''), type: String(j.type ?? '') }
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
export async function sendWhatsApp(
  cfg: TwilioConfig, to: string, body: string, statusCallback?: string,
): Promise<SentWhatsApp> {
  const form = new URLSearchParams({
    From: cfg.whatsappFrom,
    To: `whatsapp:${to.replace(/^whatsapp:/, '')}`,
    Body: body,
  })
  // WHY THIS MATTERS MORE THAN IT LOOKS: a 200 from this call means Twilio
  // ACCEPTED the message, not that WhatsApp delivered it. Most real failures —
  // the 24-hour window, a number that is not on WhatsApp, a blocked sender —
  // are reported minutes later against the message, not here. Without a status
  // callback the CRM writes "WhatsApp sent" and never learns otherwise, which
  // is exactly how two messages came to sit on a record having reached nobody.
  if (statusCallback) form.set('StatusCallback', statusCallback)
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

/**
 * Numbers this account is allowed to call.
 *
 * A TRIAL account may only dial numbers verified in the console, and the
 * failure arrives as a mid-call error rather than anything a person would
 * connect to the cause. Listing them turns "why did nothing ring?" into a
 * question that can be answered before the call is placed.
 */
export async function verifiedCallerIds(cfg: TwilioConfig): Promise<{ phone: string; name: string }[]> {
  const res = await fetch(`${API}/Accounts/${cfg.sid}/OutgoingCallerIds.json?PageSize=20`, {
    headers: { Authorization: authHeader(cfg) },
  })
  if (!res.ok) throw new Error(`Twilio refused the verified-number list (${res.status})`)
  const j = await res.json()
  return (j.outgoing_caller_ids ?? []).map((c: Record<string, unknown>) => ({
    phone: String(c.phone_number ?? ''), name: String(c.friendly_name ?? ''),
  }))
}

/** The last few messages, for working out why one did not land. */
export async function recentMessages(cfg: TwilioConfig): Promise<unknown[]> {
  const res = await fetch(`${API}/Accounts/${cfg.sid}/Messages.json?PageSize=10`, {
    headers: { Authorization: authHeader(cfg) },
  })
  if (!res.ok) throw new Error(`Twilio refused the message list (${res.status})`)
  const j = await res.json()
  return (j.messages ?? []).map((m: Record<string, unknown>) => ({
    sid: m.sid, from: m.from, to: m.to, status: m.status,
    errorCode: m.error_code, errorMessage: m.error_message,
    at: m.date_created, body: typeof m.body === 'string' ? m.body.slice(0, 40) : '',
  }))
}

/**
 * Twilio's own warnings and errors for this account.
 *
 * The Calls resource says a call was 'no-answer' whether it rang out or was
 * refused somewhere in the network — it carries no error code. The Monitor
 * API's alerts are where the actual reason shows up, so a call that "went
 * through" but never rang is only diagnosable here.
 */
export async function recentAlerts(cfg: TwilioConfig): Promise<unknown[]> {
  const res = await fetch('https://monitor.twilio.com/v1/Alerts?PageSize=15', {
    headers: { Authorization: authHeader(cfg) },
  })
  if (!res.ok) throw new Error(`Twilio refused the alert list (${res.status})`)
  const j = await res.json()
  return (j.alerts ?? []).map((a: Record<string, unknown>) => ({
    at: a.date_created, level: a.log_level, code: a.error_code,
    text: typeof a.alert_text === 'string' ? a.alert_text.slice(0, 220) : '',
    resource: a.resource_sid,
  }))
}

/**
 * May this account call a given country at all?
 *
 * Twilio blocks outbound voice to most countries by default — a protection
 * against toll fraud — and a blocked destination does not announce itself in
 * the call log. `+44…` is one of them until it is switched on in the console.
 */
export async function dialingPermission(cfg: TwilioConfig, isoCode: string): Promise<unknown> {
  const res = await fetch(`https://voice.twilio.com/v1/DialingPermissions/Countries/${encodeURIComponent(isoCode)}`, {
    headers: { Authorization: authHeader(cfg) },
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Twilio refused the dialing permissions (${res.status})`)
  return {
    country: j.name, iso: j.iso_code,
    lowRiskEnabled: j.low_risk_numbers_enabled,
    highRiskSpecialEnabled: j.high_risk_special_numbers_enabled,
    highRiskTollfraudEnabled: j.high_risk_tollfraud_numbers_enabled,
  }
}

/**
 * What kind of line is this number?
 *
 * The decisive question when a call "rang" and nobody's phone rang: a mobile
 * behaves as expected, while a VoIP or virtual number — a second-number app, a
 * calling card, a WhatsApp-only line — accepts the call at the network and may
 * never ring a handset at all. The call log cannot tell those apart; it reports
 * no-answer for both.
 */
export async function lookupNumber(cfg: TwilioConfig, phone: string): Promise<unknown> {
  const e164 = phone.replace(/[^\d+]/g, '')
  const res = await fetch(
    `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
    { headers: { Authorization: authHeader(cfg) } },
  )
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(String(j?.message ?? `Twilio refused the lookup (${res.status})`))
  const lt = (j.line_type_intelligence ?? {}) as Record<string, unknown>
  return {
    valid: j.valid, country: j.country_code,
    type: lt.type ?? 'unknown', carrier: lt.carrier_name ?? '', errorCode: lt.error_code ?? null,
  }
}

/** The last few calls, for working out why one did not land. */
export async function recentCalls(cfg: TwilioConfig): Promise<unknown[]> {
  // Twenty, not five: a single softphone call is TWO rows — the agent's browser
  // leg and the leg out to the customer — so a five-row window showed half of
  // the last few attempts and made them impossible to pair up.
  const res = await fetch(`${API}/Accounts/${cfg.sid}/Calls.json?PageSize=20`, {
    headers: { Authorization: authHeader(cfg) },
  })
  if (!res.ok) throw new Error(`Twilio refused the call list (${res.status})`)
  const j = await res.json()
  return (j.calls ?? []).map((c: Record<string, unknown>) => ({
    sid: c.sid,
    // Which browser leg a customer leg belongs to. Without it the two halves of
    // one call cannot be told apart from two separate attempts.
    parent: c.parent_call_sid,
    from: c.from, to: c.to, status: c.status,
    duration: c.duration, direction: c.direction,
    at: c.start_time, ended: c.end_time,
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
