import { supabase } from './supabase'
import { writeControlRow, type LeadRecord, type TimelineEvent } from './leadrecord'
import type { Workspace } from './workspaces'

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
  item: Suggestion[]
  quantity: Suggestion[]
  amount: Suggestion[]
  address: Suggestion[]
}

const CUSTOMER_KINDS = new Set(['message', 'email_in', 'wa_in', 'note', 'email', 'wa_out'])
/**
 * Where a SHIPPING address may be read from.
 *
 * Only what the customer said, plus notes an agent wrote. Never our own
 * outbound email: every one of those carries the site's address in its
 * signature, so an outbound message is guaranteed to offer the factory's
 * address as the place to ship to.
 */
const ADDRESS_KINDS = new Set(['message', 'email_in', 'wa_in', 'note'])

/**
 * A quantity, WITH the thing being counted.
 *
 * "8" is not a useful quantity on an invoice — "8 sets" is, and "23 custom
 * long-sleeve shirts" is better still. The first version captured only the
 * number and the bare unit, so an email saying "Quantity: 8" produced "8" and
 * a note saying "23 custom long-sleeve shirts" produced nothing at all,
 * because two describing words sat between the number and the noun.
 *
 * Up to three describing words are allowed between the two, which is what
 * catches "1 Xl Jersey" and "23 custom long-sleeve shirts" while still
 * refusing "2 games possibly 3" and "1.5-2 weeks prior".
 */
// "unit" is deliberately absent. It is a street word before it is a counting
// word, and with it in the list "3101 Lynn Ave unit" was offered as a
// quantity — the customer's own address, read as how many jerseys they wanted.
const UNIT = 'sets?|pcs?|pieces?|jerseys?|uniforms?|shirts?|kits?|shorts?|socks?|hoodies?|tops?|pants?|jackets?|caps?|bags?'
const DESCRIBED = new RegExp(`\\b([1-9]\\d{0,2})\\s+((?:[A-Za-z][A-Za-z-]{1,14}\\s+){0,3}(?:${UNIT}))\\b`, 'gi')
/** "Quantity: 8", where the noun may or may not follow. */
const LABELLED = new RegExp(`\\b(?:qty\\.?|quantity)\\s*[:=]?\\s*([1-9]\\d{0,2})\\s*((?:[A-Za-z][A-Za-z-]{1,14}\\s+){0,3}(?:${UNIT}))?`, 'gi')

/** A currency amount, with or without a symbol. Bare integers are ignored on
 *  purpose — "24 jerseys" is not $24. */
const AMOUNT = /(?:\$|usd\s*)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+\.\d{2})\b/gi
/**
 * A US-shaped address: number, street, a street type, then a locality — and it
 * must end in a state or a ZIP.
 *
 * The loose version matched "80 total. If required within 15 days, customer
 * must increase order to at least" out of a note, and, worse, matched OUR OWN
 * address out of the email signature on every message we send. A shipping
 * address that is the factory's address is the kind of mistake that only shows
 * up when a parcel comes back.
 */
const ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace)\b[.,]?(?:\s*(?:apt|apartment|suite|ste|unit|#)\s*[\w-]+[.,]?)?(?:\s*,?\s*[A-Za-z .'-]{2,30})?\s*,?\s*(?:[A-Z]{2}\b\s*\d{5}(?:-\d{4})?|\d{5}(?:-\d{4})?|[A-Z]{2}\b)/gi
/** What was being talked about: "custom soccer uniforms", "baseball jerseys". */
const ITEM = /\b((?:custom|sublimated|reversible|blank|youth|team)?\s*(?:football|soccer|basketball|baseball|softball|volleyball)\s+(?:uniforms?|jerseys?|kits?|shorts?|shirts?|pants?|hoodies?|warm[- ]?ups?))\b/gi

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
  const out: InvoiceSuggestions = { item: [], quantity: [], amount: [], address: [] }
  const events = [...timeline]
    .filter((e) => CUSTOMER_KINDS.has(e.kind))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))

  for (const e of events) {
    const text = [e.body, e.title, e.email?.body, e.inbound?.body].filter(Boolean).join('\n')
    if (!text) continue
    const where = e.kind === 'note' ? 'note'
      : e.kind.startsWith('wa') ? 'WhatsApp'
      : e.kind.startsWith('email') ? 'email' : 'chat'

    // "23 custom long-sleeve shirts Shirts" — a heading immediately followed
    // by the same noun. Both patterns can produce it, so both get tidied.
    const tidy = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/\b(\w+)\s+\1\b/gi, '$1')
    for (const m of text.matchAll(DESCRIBED)) push(out.quantity, tidy(`${m[1]} ${m[2]}`), where, e.at)
    for (const m of text.matchAll(LABELLED)) push(out.quantity, tidy(`${m[1]} ${m[2] ?? ''}`), where, e.at)
    for (const m of text.matchAll(AMOUNT)) push(out.amount, `$${m[1]}`, where, e.at)
    for (const m of text.matchAll(ITEM)) {
      const t = m[1].replace(/\s+/g, ' ').trim()
      push(out.item, t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(), where, e.at)
    }
    if (ADDRESS_KINDS.has(e.kind)) {
      for (const m of text.matchAll(ADDRESS)) {
        const a = m[0].replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
        if (a.length >= 14) push(out.address, a, where, e.at)
      }
    }
  }
  // A quantity that names what is being counted beats a bare number, whoever
  // said it first. "8 sets" is an invoice line; "8" is a number somebody has
  // to go back to the thread to understand.
  out.quantity.sort((a, b) => Number(/\d\s+\S/.test(b.value)) - Number(/\d\s+\S/.test(a.value)))
  return out
}

// ── The sheet ───────────────────────────────────────────────────────────────

export interface InvoiceSheet {
  /** Fields whose value came from the conversation rather than being typed. */
  autofilled: string[]
  /** Where each auto-filled value was said. */
  sources: Record<string, string>
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

/**
 * The sheet, with anything not yet typed taken from the conversation.
 *
 * A typed value always wins — it is the one somebody decided. An empty field
 * is filled from the newest thing in the thread that looks like it, and the
 * field is listed in `autofilled` with where it came from, so the panel can
 * show its provenance instead of pretending a person entered it.
 */
export function buildSheet(
  record: LeadRecord, draft: InvoiceDraft | null, sug?: InvoiceSuggestions,
): InvoiceSheet {
  const d = draft ?? BLANK_INVOICE
  const value = record.value?.won ?? record.value?.estimated ?? null
  const autofilled: string[] = []
  const sources: Record<string, string> = {}
  const fill = (field: string, typed: string, from?: Suggestion, strip?: RegExp) => {
    if (typed) return typed
    if (!from) return ''
    autofilled.push(field)
    sources[field] = from.from
    return strip ? from.value.replace(strip, '') : from.value
  }
  const sheet: InvoiceSheet = {
    autofilled,
    sources,
    name: record.contact.name || '',
    email: record.contact.email || '',
    phone: record.contact.phone || '',
    billTo: d.billTo || record.contact.name || '',
    shipTo: fill('shipTo', d.shipTo, sug?.address[0]),
    item: fill('item', d.item, sug?.item[0]),
    quantity: fill('quantity', d.quantity, sug?.quantity[0]),
    // A deal value already recorded on the pipeline is the amount unless
    // somebody typed a different one here.
    amount: d.amount || (value !== null ? String(value) : fill('amount', '', sug?.amount[0], /^\$/)),
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

// ── The example text in the empty fields ─────────────────────────────────────
// These were written while the panel was being built against a sports lead —
// "Thunder soccer uniforms", "8 sets", "Club or school that pays" — and this
// dashboard serves two workspaces off one component. So a packaging agent
// opening a wax-paper enquiry was shown a soccer team as the example of what
// they had just sold. A placeholder is read as instruction, and the wrong one
// makes a correct panel look like somebody else's product.
export interface InvoiceHints { item: string; quantity: string; amount: string; billTo: string }

export function invoiceHints(workspace: Workspace): InvoiceHints {
  return workspace === 'sports'
    ? {
        item: 'Thunder soccer uniforms', quantity: '8 sets', amount: '429.00',
        billTo: 'Club or school that pays, if not the contact',
      }
    : {
        item: 'Custom printed sandwich papers', quantity: '5,000 sheets', amount: '429.00',
        billTo: 'Company that pays, if not the contact',
      }
}
