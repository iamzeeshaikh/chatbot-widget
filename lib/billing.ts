import crypto from 'node:crypto'
import { supabase } from './supabase'
import { writeControlRow } from './leadrecord'
import { appSecret } from './auth'

/**
 * Billing details for an invoice, collected from the customer rather than typed
 * out of a WhatsApp thread by an agent.
 *
 * Two things drove the shape of this:
 *
 * 1. **A US school or university pays against a purchase order.** An invoice
 *    with no PO number on it is rejected by accounts payable, and the agent
 *    finds out three weeks later when nobody has paid. So the PO field exists
 *    and the form says out loud what it is for.
 * 2. **No card numbers.** Nothing here takes one, and the form says so. A card
 *    number arriving in a form post is a card number sitting in a database and
 *    in an inbox, with no defence against a chargeback. Payment goes through a
 *    link from the payment processor, which is the one place it belongs.
 *
 * Stored the way everything else in this CRM stores: one appended control row
 * on chat_logs, newest wins on read. No migration, no new table.
 */
export const CRM_BILLING_ROLE = 'crm_billing'

export interface BillingDetails {
  /** The entity that PAYS. Frequently not the person who asked for the quote. */
  billTo: string
  contactName: string
  contactEmail: string
  contactPhone: string
  billingAddress: string
  /** Blank means "same as billing" — the form ticks that by default. */
  shipAddress: string
  poNumber: string
  taxExempt: 'yes' | 'no' | ''
  taxExemptId: string
  paymentMethod: string
  notes: string
  submittedAt: string
}

export const BLANK_BILLING: BillingDetails = {
  billTo: '', contactName: '', contactEmail: '', contactPhone: '',
  billingAddress: '', shipAddress: '', poNumber: '', taxExempt: '',
  taxExemptId: '', paymentMethod: '', notes: '', submittedAt: '',
}

// ── The link an agent sends ──────────────────────────────────────────────────
/**
 * A signed token, not a lead id.
 *
 * The form is unauthenticated by necessity — the customer has no login — so the
 * URL is the only credential. A raw id in the URL means anybody who can count
 * can read and overwrite another customer's billing details, which is the exact
 * shape of the staging-bypass mistake this codebase has made before. An HMAC
 * over the id makes the link unguessable and lets the server reject a tampered
 * one without a database round trip.
 */
export function billingToken(leadId: string): string {
  // Domain-separated by the `billing:` prefix, so a signature minted here can
  // never be replayed as a session token and vice versa.
  const sig = crypto.createHmac('sha256', appSecret()).update(`billing:${leadId}`).digest('base64url').slice(0, 24)
  return `${Buffer.from(leadId).toString('base64url')}.${sig}`
}

export function leadFromToken(token: string): string | null {
  const [head, sig] = String(token ?? '').split('.')
  if (!head || !sig) return null
  let id: string
  try {
    id = Buffer.from(head, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!id) return null
  const want = billingToken(id).split('.')[1]
  // Constant-time: a length mismatch would throw, so check that first.
  if (sig.length !== want.length) return null
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? id : null
}

// ── Read and write ───────────────────────────────────────────────────────────
export async function readBilling(sessionId: string): Promise<BillingDetails | null> {
  const { data, error } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('session_id', sessionId)
    .eq('role', CRM_BILLING_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data?.length) return null
  try {
    const parsed = JSON.parse(String(data[0].message)) as Partial<BillingDetails>
    return { ...BLANK_BILLING, ...parsed, submittedAt: parsed.submittedAt || String(data[0].created_at) }
  } catch {
    return null
  }
}

const LIMITS: Record<keyof BillingDetails, number> = {
  billTo: 200, contactName: 120, contactEmail: 200, contactPhone: 40,
  billingAddress: 500, shipAddress: 500, poNumber: 80, taxExempt: 3,
  taxExemptId: 80, paymentMethod: 40, notes: 2000, submittedAt: 40,
}

/** Trim, cap and drop anything the form did not define. Never trust a post. */
export function cleanBilling(raw: unknown): BillingDetails {
  const src = (raw ?? {}) as Record<string, unknown>
  const out = { ...BLANK_BILLING }
  for (const key of Object.keys(BLANK_BILLING) as (keyof BillingDetails)[]) {
    if (key === 'submittedAt') continue
    const v = String(src[key] ?? '').trim().slice(0, LIMITS[key])
    // @ts-expect-error narrowed per key by LIMITS above
    out[key] = key === 'taxExempt' ? (v === 'yes' || v === 'no' ? v : '') : v
  }
  out.submittedAt = new Date().toISOString()
  return out
}

export async function writeBilling(
  sessionId: string, siteId: string, details: BillingDetails,
): Promise<{ error: string | null }> {
  return writeControlRow({
    sessionId, siteId, role: CRM_BILLING_ROLE, message: JSON.stringify(details),
  })
}

/** What is still missing before an invoice can actually be raised. */
export function billingGaps(d: BillingDetails | null): string[] {
  if (!d) return ['Nothing submitted yet']
  const gaps: string[] = []
  if (!d.billTo) gaps.push('Bill-to name')
  if (!d.contactEmail) gaps.push('Billing email')
  if (!d.billingAddress) gaps.push('Billing address')
  if (!d.poNumber) gaps.push('PO number')
  if (d.taxExempt === 'yes' && !d.taxExemptId) gaps.push('Exemption certificate number')
  return gaps
}
