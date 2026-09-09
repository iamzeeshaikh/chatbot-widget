import { supabase } from './supabase'
import { writeControlRow, type LeadRecord, type TimelineEvent } from './leadrecord'

/**
 * Everything needed to raise an invoice, on the record, in one block that can
 * be copied.
 *
 * The problem it solves: a sale is agreed across a WhatsApp thread, a couple of
 * emails and a note, and then somebody has to assemble a name, an address, a
 * quantity and an amount out of that to type into a payment page. The details
 * exist; they are just spread across the timeline and half of them were never
 * fields in the first place, because this CRM holds no prices.
 *
 * So this does two things:
 *
 *  1. Keeps a typed draft — what was sold, how many, for how much, ship-to —
 *     as an appended control row, so it is entered once rather than re-read out
 *     of a conversation every time.
 *  2. Reads the conversation for candidates and offers them. A quantity or a
 *     dollar figure that appears in the thread is a suggestion, never a value:
 *     "8 sets" in a customer's message might be what was ordered or what they
 *     first asked about, and only a person knows which.
 */
export const CRM_INVOICE_ROLE = 'crm_invoice'

export interface InvoiceDraft {
  item: string
  quantity: string
  amount: string
  currency: string
  billTo: string
  shipTo: string
  notes: string
  updatedAt: string
  updatedBy: string
}

export const BLANK_INVOICE: InvoiceDraft = {
  item: '', quantity: '', amount: '', currency: 'USD',
  billTo: '', shipTo: '', notes: '', updatedAt: '', updatedBy: '',
}

const LIMITS: Record<keyof InvoiceDraft, number> = {
  item: 300, quantity: 60, amount: 40, currency: 8,
  billTo: 200, shipTo: 500, notes: 1000, updatedAt: 40, updatedBy: 200,
}

export function cleanInvoice(raw: unknown, actor: string): InvoiceDraft {
  const src = (raw ?? {}) as Record<string, unknown>
  const out = { ...BLANK_INVOICE }
  for (const key of Object.keys(BLANK_INVOICE) as (keyof InvoiceDraft)[]) {
    if (key === 'updatedAt' || key === 'updatedBy') continue
    out[key] = String(src[key] ?? '').trim().slice(0, LIMITS[key])
  }
  out.currency = (out.currency || 'USD').toUpperCase()
  out.updatedAt = new Date().toISOString()
  out.updatedBy = actor
  return out
}

export async function readInvoice(sessionId: string): Promise<InvoiceDraft | null> {
  const { data, error } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('session_id', sessionId)
    .eq('role', CRM_INVOICE_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data?.length) return null
  try {
    const parsed = JSON.parse(String(data[0].message)) as Partial<InvoiceDraft>
    return { ...BLANK_INVOICE, ...parsed, updatedAt: parsed.updatedAt || String(data[0].created_at) }
  } catch {
    return null
  }
}

export async function writeInvoice(
  sessionId: string, siteId: string, draft: InvoiceDraft,
): Promise<{ error: string | null }> {
  return writeControlRow({
    sessionId, siteId, role: CRM_INVOICE_ROLE, message: JSON.stringify(draft),
  })
}

// ── Reading the conversation for candidates ─────────────────────────────────

export interface Suggestion {
  value: string
  /** Where it was said, so a person can judge it rather than trust it. */
  from: string
  at: string
}

export interface InvoiceSuggestions {
  quantity: Suggestion[]
  amount: Suggestion[]
  address: Suggestion[]
}

const CUSTOMER_KINDS = new Set(['message', 'email_in', 'wa_in', 'note', 'email', 'wa_out'])

/** "8 sets", "24 jerseys", "qty 30", "x 12" — how a quantity is actually written. */
const QTY = /\b(?:qty\.?|quantity)\s*[:=]?\s*(\d{1,4})\b|\b(\d{1,4})\s*(sets?|pcs?|pieces?|jerseys?|uniforms?|shirts?|kits?|units?)\b/gi
/** A currency amount, with or without a symbol. Bare integers are ignored on
 *  purpose — "24 jerseys" is not $24. */
const AMOUNT = /(?:\$|usd\s*)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})\b/gi
/** A US-shaped address line: number, street, and something after it. */
const ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s*,\s*[A-Za-z .'-]{2,},?\s*(?:[A-Z]{2}\s*\d{5}(?:-\d{4})?)?/g

function push(into: Suggestion[], value: string, from: string, at: string) {
  const v = value.trim()
  if (!v || into.some((s) => s.value.toLowerCase() === v.toLowerCase())) return
  if (into.length >= 6) return
  into.push({ value: v, from, at })
}

/**
 * Candidates from the thread, newest first — what was agreed is usually said
 * later than what was asked.
 */
export function suggestFromTimeline(timeline: TimelineEvent[]): InvoiceSuggestions {
  const out: InvoiceSuggestions = { quantity: [], amount: [], address: [] }
  const events = [...timeline]
    .filter((e) => CUSTOMER_KINDS.has(e.kind))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))

  for (const e of events) {
    const text = [e.body, e.title, e.email?.body, e.inbound?.body].filter(Boolean).join('\n')
    if (!text) continue
    const where = e.kind === 'note' ? 'note'
      : e.kind.startsWith('wa') ? 'WhatsApp'
      : e.kind.startsWith('email') ? 'email' : 'chat'

    for (const m of text.matchAll(QTY)) {
      push(out.quantity, m[1] ? m[1] : `${m[2]} ${m[3]}`, where, e.at)
    }
    for (const m of text.matchAll(AMOUNT)) push(out.amount, `$${m[1]}`, where, e.at)
    for (const m of text.matchAll(ADDRESS)) {
      // A street address is long; a bare "12, ok" is not.
      if (m[0].trim().length >= 14) push(out.address, m[0].replace(/\s+/g, ' ').trim(), where, e.at)
    }
  }
  return out
}

// ── The sheet ───────────────────────────────────────────────────────────────

export interface InvoiceSheet {
  name: string
  email: string
  phone: string
  billTo: string
  shipTo: string
  item: string
  quantity: string
  amount: string
  currency: string
  notes: string
  /** What still stops an invoice being raised. */
  gaps: string[]
}

export function buildSheet(record: LeadRecord, draft: InvoiceDraft | null): InvoiceSheet {
  const d = draft ?? BLANK_INVOICE
  const value = record.value?.won ?? record.value?.estimated ?? null
  const sheet: InvoiceSheet = {
    name: record.contact.name || '',
    email: record.contact.email || '',
    phone: record.contact.phone || '',
    billTo: d.billTo || record.contact.name || '',
    shipTo: d.shipTo,
    item: d.item,
    quantity: d.quantity,
    // A deal value already recorded on the pipeline is the amount unless
    // somebody typed a different one here.
    amount: d.amount || (value !== null ? String(value) : ''),
    currency: d.currency || record.value?.currency || 'USD',
    notes: d.notes,
    gaps: [],
  }
  if (!sheet.email) sheet.gaps.push('Email address')
  if (!sheet.item) sheet.gaps.push('What was sold')
  if (!sheet.amount) sheet.gaps.push('Amount')
  if (!sheet.shipTo) sheet.gaps.push('Shipping address')
  return sheet
}

/** The block that gets pasted into a payment page. Plain text on purpose. */
export function sheetToText(s: InvoiceSheet): string {
  const line = (label: string, value: string) => (value ? `${label}: ${value}` : null)
  return [
    line('Bill to', s.billTo),
    line('Email', s.email),
    line('Phone', s.phone),
    line('Ship to', s.shipTo.replace(/\s*\n\s*/g, ', ')),
    '',
    line('Item', s.item),
    line('Quantity', s.quantity),
    line('Amount', s.amount ? `${s.currency} ${s.amount}` : ''),
    line('Notes', s.notes),
  ].filter((l) => l !== null).join('\n')
}
