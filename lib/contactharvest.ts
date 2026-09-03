// Contact details a customer writes INSIDE a message — "call me on 410 918
// 8549", an email address at the foot of a WhatsApp text — pulled out and
// filled into the lead's empty fields.
//
// Chat has done this since the beginning (lib/leadtracking.ts); email replies
// and WhatsApp did not, so a phone number sat in plain sight in the message
// while the record's Phone field stayed empty — and in the contact-privacy
// workspace the agent could not even read the message to copy it out by hand.
//
// TWO RULES THAT MAKE THIS SAFE:
//   • Only an EMPTY field is ever filled. A value somebody chose — or an
//     earlier capture — is never overwritten by something parsed from prose.
//   • Our own numbers are never captured. Every reply quotes our signature,
//     and the signature now carries the company line; harvesting it would
//     stamp our own phone onto the customer.

import { supabase } from './supabase'
import { CRM_FIELD_ROLE } from './crm'
import { isQuoteSessionId } from './quoteintake'
import { parseLeadCapture } from './leadtracking'

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/
// 10-15 digits with the separators people actually type. TEN as the floor, not
// seven: order numbers, prices and zip codes live below it and each one would
// become somebody's "phone".
const PHONE_RE = /(?:\+?\(?\d[\d\s().-]{8,18}\d)/

const OWN_NUMBERS = ['5033580443', '5034614788', '2134493746', '447458651107']

function digitsOf(v: string): string { return v.replace(/\D/g, '') }

function isOwn(digits: string): boolean {
  return digits.length >= 9 && OWN_NUMBERS.some((n) => n.slice(-9) === digits.slice(-9))
}

export function extractEmail(text: string): string | null {
  const m = EMAIL_RE.exec(text ?? '')
  return m ? m[0] : null
}

export function extractPhone(text: string): string | null {
  for (const m of (text ?? '').matchAll(new RegExp(PHONE_RE, 'g'))) {
    const digits = digitsOf(m[0])
    if (digits.length < 10 || digits.length > 15) continue
    if (isOwn(digits)) continue
    return m[0].trim()
  }
  return null
}

/** The lead's current email/phone, honouring crm_field overrides — the same
 *  precedence the record page reads with, only the two fields this needs. */
async function currentContact(sessionId: string): Promise<{ email: string; phone: string }> {
  let email = '', phone = ''
  if (isQuoteSessionId(sessionId)) {
    const { data } = await supabase.from('leads').select('email, phone')
      .eq('id', sessionId.slice('quote-'.length)).maybeSingle()
    email = data?.email ?? ''; phone = data?.phone ?? ''
  }
  const { data: rows } = await supabase.from('chat_logs')
    .select('role, message, created_at')
    .eq('session_id', sessionId).in('role', [CRM_FIELD_ROLE, 'lead_capture'])
    .order('created_at', { ascending: true }).limit(200)
  for (const r of rows ?? []) {
    if (r.role === 'lead_capture') {
      const c = parseLeadCapture(r.message)
      if (c?.email && !email) email = c.email
      if (c?.phone && !phone) phone = c.phone
      continue
    }
    try {
      const o = JSON.parse(r.message ?? '')
      // An override wins even when it CLEARS the field — that is what an
      // override is — so later rows simply replace, empty included.
      if (o?.field === 'email') email = String(o.value ?? '')
      if (o?.field === 'phone') phone = String(o.value ?? '')
    } catch { /* malformed row */ }
  }
  return { email: email.trim(), phone: phone.trim() }
}

/**
 * Fill whatever is missing from what the customer just wrote. Fire-and-forget
 * from the message paths — a capture failing must never fail the message.
 */
export async function harvestContact(sessionId: string, siteId: string, text: string): Promise<void> {
  try {
    if (!text?.trim()) return
    const found = { email: extractEmail(text), phone: extractPhone(text) }
    if (!found.email && !found.phone) return
    const cur = await currentContact(sessionId)
    const at = new Date().toISOString()
    const rows: { field: string; value: string }[] = []
    if (found.email && !cur.email) rows.push({ field: 'email', value: found.email })
    if (found.phone && !cur.phone) rows.push({ field: 'phone', value: found.phone })
    if (rows.length === 0) return
    await supabase.from('chat_logs').insert(rows.map((r) => ({
      site_id: siteId, session_id: sessionId, role: CRM_FIELD_ROLE,
      // 'auto-capture' rather than an agent's email, so the timeline says what
      // actually happened instead of crediting whoever's sweep ran.
      message: JSON.stringify({ ...r, updated_by: 'auto-capture', at }),
    })))
  } catch { /* never let a capture break the message path */ }
}
