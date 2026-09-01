// "Is this number even on WhatsApp?"
//
// THERE IS NO API THAT ANSWERS THIS. Meta's old On-Premise API had a contacts
// endpoint; it was withdrawn, and neither the Cloud API nor Twilio exposes a
// replacement. So the honest answer is assembled from evidence we already have,
// and where the evidence runs out this says "unknown" rather than guessing —
// an agent who is told "yes" and then watches a message fail learns to distrust
// the whole column.
//
// The evidence, strongest first:
//   • the customer has MESSAGED us on WhatsApp        → certain
//   • a message to them was delivered or read         → certain
//   • a message failed with 63003 / 63024             → certainly not
//   • Twilio Lookup says the line is a landline/VoIP  → almost certainly not
//   • Lookup says mobile                              → possible, nothing more
//
// The Lookup result is CACHED in a control row. It costs money per call and a
// number's line type does not change, so looking it up on every page load would
// be paying repeatedly for the same fact.

import { supabase } from './supabase'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from './crm'
import { parseWaMessage } from './whatsapp'
import { REMINDER_SITE } from './reminders'

import { CRM_WA_LOOKUP_ROLE } from './crm'

const LOOKUP_SESSION = 'zeeops-crm-wa-lookup'

export type WhatsAppState = 'yes' | 'no' | 'maybe' | 'unlikely' | 'unknown'

export interface WhatsAppStatus {
  state: WhatsAppState
  /** One sentence an agent can act on. */
  reason: string
}

interface LookupRow { key: string; type: string; carrier?: string; at?: string }

function parseLookup(message: string | null | undefined): LookupRow | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.key !== 'string') return null
    return { key: o.key, type: String(o.type ?? ''), carrier: String(o.carrier ?? ''), at: String(o.at ?? '') }
  } catch { return null }
}

/** Remember what Lookup said about a number, so it is only ever paid for once. */
export async function rememberLineType(key: string, type: string, carrier: string): Promise<void> {
  if (!key) return
  await supabase.from('chat_logs').insert([{
    session_id: LOOKUP_SESSION,
    site_id: REMINDER_SITE,
    role: CRM_WA_LOOKUP_ROLE,
    message: JSON.stringify({ key, type, carrier, at: new Date().toISOString() }),
  }])
}

export async function cachedLineType(key: string): Promise<LookupRow | null> {
  if (!key) return null
  const { data } = await supabase.from('chat_logs')
    .select('message')
    .eq('site_id', REMINDER_SITE).eq('session_id', LOOKUP_SESSION).eq('role', CRM_WA_LOOKUP_ROLE)
    .order('created_at', { ascending: false }).limit(400)
  for (const r of data ?? []) {
    const l = parseLookup(r.message)
    if (l?.key === key) return l
  }
  return null
}

/**
 * Work out the state from this lead's own WhatsApp history plus a cached line
 * type. Takes the rows it needs rather than fetching them, so the lead record —
 * which has already read them — does not query twice.
 */
export function whatsAppStateFrom(
  rows: { role: string; message: string }[],
  line: LookupRow | null,
  hasPhone: boolean,
): WhatsAppStatus {
  if (!hasPhone) return { state: 'unknown', reason: 'No phone number on file.' }

  let inbound = false
  let delivered = false
  let failedCode = 0
  for (const r of rows) {
    if (r.role === CRM_WA_IN_ROLE) { inbound = true; continue }
    if (r.role !== CRM_WA_OUT_ROLE) continue
    const w = parseWaMessage(r.message)
    if (!w) continue
    if (w.status === 'delivered' || w.status === 'read') delivered = true
    if (w.status === 'failed' || w.status === 'undelivered') failedCode = w.errorCode ?? -1
  }

  if (inbound) return { state: 'yes', reason: 'They have messaged this business on WhatsApp.' }
  if (delivered) return { state: 'yes', reason: 'A WhatsApp message to this number was delivered.' }
  // ── Only ONE code means "this number has no WhatsApp" ────────────────────
  // 63003 is it. Everything else is about the MESSAGE, not the account:
  //   • 63016 — outside the 24-hour window;
  //   • 63024 — WhatsApp refused this particular message (a business writing
  //     first without an approved template hits this constantly);
  //   • 63021 — the content was not something the channel accepts.
  // 63024 was read as "no" here and told the owner a number was not on WhatsApp
  // when it plainly was — he had the chat open. A verdict this confident has to
  // come from evidence that actually supports it.
  if (failedCode === 63003) {
    return { state: 'no', reason: 'WhatsApp reported this number as not reachable.' }
  }
  if (failedCode === 63024 || failedCode === 63021 || failedCode === 63016) {
    // A refusal proves the message was wrong, not the number — fall through to
    // the line-type evidence below rather than claiming either way.
  }

  const type = (line?.type ?? '').toLowerCase()
  if (type === 'landline' || type === 'fixedVoip'.toLowerCase() || type === 'tollfree') {
    return { state: 'unlikely', reason: `This is a ${line?.type} line — WhatsApp needs a mobile.` }
  }
  if (type === 'mobile') {
    return { state: 'maybe', reason: 'A mobile number, so WhatsApp is possible — nobody can confirm it until a message goes.' }
  }
  return { state: 'unknown', reason: 'Not checked yet. WhatsApp gives no way to test a number without messaging it.' }
}

export const WHATSAPP_STATE_LABEL: Record<WhatsAppState, string> = {
  yes: 'On WhatsApp',
  no: 'Not on WhatsApp',
  maybe: 'Mobile — WhatsApp possible',
  unlikely: 'Unlikely to have WhatsApp',
  unknown: 'WhatsApp unknown',
}
