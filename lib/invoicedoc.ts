// A real invoice, laid out like the ones the team sends (Invoice TPC-017,
// TWP-020, TDCS-019): logo and agent top left, INVOICE # top right, Bill To /
// Ship To, date-terms-PO block with Balance Due, an Item | Quantity | Rate |
// Amount table, Subtotal / Tax / Total, Notes and Terms.
//
// Client-safe: the invoice page, the API and the PDF builder all share these
// types and the arithmetic, so the preview, the saved copy and the PDF can
// never disagree about a total.
//
// Stored as `crm_invoice_doc` control rows on the lead — one row per save,
// newest per invoice id wins, deletion is a row with `deleted: true`. Several
// invoices per lead are allowed (a reorder, a sample, a second design).
// The older `crm_invoice` "invoice details" sheet (lib/invoice.ts) is what
// pre-fills a new one.

export const CRM_INVOICE_DOC_ROLE = 'crm_invoice_doc'

export interface InvoiceParty {
  name: string
  company: string
  /** Free lines: street, city/state/ZIP, country. */
  address: string
  phone: string
}

export interface InvoiceItem {
  name: string
  /** Grey lines under the name: size, printing, material. One per line. */
  details: string
  quantity: string
  rate: string
}

export interface InvoiceDoc {
  id: string
  /** Typed by the agent; each site keeps its own count (TPC-017). */
  number: string
  agentName: string
  date: string        // YYYY-MM-DD
  dueDate: string     // YYYY-MM-DD
  paymentTerms: string
  poNumber: string
  currency: string
  billTo: InvoiceParty
  shipTo: InvoiceParty
  shipSame: boolean
  items: InvoiceItem[]
  taxPercent: string
  notes: string
  terms: string
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
  deleted?: boolean
}

export const DEFAULT_NOTES = [
  'No extra or hidden charges',
  'Free shipping to your doorstep',
  'Free 2D and 3D mockups',
  'Free design support',
].join('\n')

export const DEFAULT_TERMS = 'Delivery within 12-15 business days after final approval of the spec sheet'

const blankParty = (): InvoiceParty => ({ name: '', company: '', address: '', phone: '' })

export function blankInvoice(): InvoiceDoc {
  return {
    id: '', number: '', agentName: '', date: '', dueDate: '', paymentTerms: 'Credit Card', poNumber: '',
    currency: 'USD', billTo: blankParty(), shipTo: blankParty(), shipSame: true,
    items: [{ name: '', details: '', quantity: '', rate: '' }],
    taxPercent: '0', notes: DEFAULT_NOTES, terms: DEFAULT_TERMS,
    createdBy: '', createdAt: '', updatedBy: '', updatedAt: '',
  }
}

export function newInvoiceId(): string {
  return `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── arithmetic ──────────────────────────────────────────────────────────────
/** "1,250" or "$0.52" typed into a box → a number; anything else → 0. */
export function num(v: string): number {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Line amount in cents, so 2000 × $0.52 is exactly $1,040.00. */
export function lineCents(it: InvoiceItem): number {
  return Math.round(num(it.quantity) * num(it.rate) * 100)
}

export function totals(doc: InvoiceDoc): { subtotal: number; tax: number; total: number } {
  const sub = doc.items.reduce((s, it) => s + lineCents(it), 0)
  const tax = Math.round(sub * num(doc.taxPercent) / 100)
  return { subtotal: sub / 100, tax: tax / 100, total: (sub + tax) / 100 }
}

const SYMBOL: Record<string, string> = { USD: '$', CAD: 'CA$', AUD: 'A$', GBP: '£', EUR: '€' }

export function money(v: number, currency = 'USD'): string {
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${v < 0 ? '-' : ''}${SYMBOL[currency] ?? `${currency} `}${s}`
}

/** A rate keeps the precision it was typed with — $0.155 per cup is real. */
export function rateLabel(v: string, currency = 'USD'): string {
  const n = num(v)
  const decimals = Math.min(4, Math.max(2, (String(v).split('.')[1] ?? '').replace(/\D/g, '').length))
  return `${SYMBOL[currency] ?? `${currency} `}${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

// ── the bits the team builds by hand today ──────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-08" → "Oct 8, 2026", as on the samples. */
export function dateLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '')
  if (!m) return iso || ''
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
}

/** The Paper Cups → TPC, The Die Cut Stickers → TDCS, Lip Boxes → LB. */
export function sitePrefix(siteName: string): string {
  const words = siteName.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  return words.map((w) => w[0].toUpperCase()).join('').slice(0, 5) || 'INV'
}

/** Steve Hayes → SH. */
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 3)
}

/** TPC-SH-10082026: the invoice's prefix, the agent's initials, the date. */
export function poNumber(prefix: string, agentName: string, dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso || '')
  const d = m ? `${m[2]}${m[3]}${m[1]}` : ''
  return [prefix, initials(agentName), d].filter(Boolean).join('-')
}

/** The prefix of a typed number ("TPC-017" → "TPC"), or the site's own. */
export function prefixOf(number: string, siteName: string): string {
  const m = /^([A-Za-z]{1,6})[-\s]?\d/.exec(number.trim())
  return m ? m[1].toUpperCase() : sitePrefix(siteName)
}

// ── cleaning what the browser sends ─────────────────────────────────────────
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max)
const party = (v: unknown): InvoiceParty => {
  const o = (v ?? {}) as Record<string, unknown>
  return { name: str(o.name, 120), company: str(o.company, 120), address: str(o.address, 400), phone: str(o.phone, 40) }
}

export function cleanInvoiceDoc(raw: unknown): InvoiceDoc {
  const o = (raw ?? {}) as Record<string, unknown>
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 30).map((x) => {
    const i = (x ?? {}) as Record<string, unknown>
    return { name: str(i.name, 200), details: str(i.details, 600), quantity: str(i.quantity, 20), rate: str(i.rate, 20) }
  })
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date)) ? String(o.date) : ''
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(o.dueDate)) ? String(o.dueDate) : date
  return {
    ...blankInvoice(),
    id: /^inv_[a-z0-9_]+$/.test(String(o.id)) ? String(o.id) : '',
    number: str(o.number, 40).trim(),
    agentName: str(o.agentName, 80).trim(),
    date, dueDate: due,
    paymentTerms: str(o.paymentTerms, 60).trim() || 'Credit Card',
    poNumber: str(o.poNumber, 60).trim(),
    currency: (str(o.currency, 4).toUpperCase() || 'USD'),
    billTo: party(o.billTo),
    shipTo: party(o.shipTo),
    shipSame: o.shipSame !== false,
    items: items.length ? items : blankInvoice().items,
    taxPercent: str(o.taxPercent, 8) || '0',
    notes: str(o.notes, 1500),
    terms: str(o.terms, 800),
  }
}

export function parseInvoiceDoc(message: string | null | undefined): InvoiceDoc | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    if (!o || typeof o.id !== 'string' || !o.id) return null
    return { ...cleanInvoiceDoc(o), id: o.id, createdBy: str(o.createdBy, 200), createdAt: str(o.createdAt, 40),
      updatedBy: str(o.updatedBy, 200), updatedAt: str(o.updatedAt, 40), deleted: o.deleted === true }
  } catch { return null }
}

/** Ship To as printed: Bill To again when the box says so. */
export function shipParty(doc: InvoiceDoc): InvoiceParty {
  return doc.shipSame ? doc.billTo : doc.shipTo
}
