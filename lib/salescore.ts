// Sales records — the part that runs in the browser AND on the server.
//
// Three streams, kept apart on purpose, because the same Model Town team sold
// under two different arrangements and mixing them would make neither total
// mean anything:
//
//   pk_direct   Model Town packaging, sold and paid directly to us
//   pk_partner  orders from the OLD lead-selling partner — we sold them leads,
//               waived the fee, and they handed us the orders they closed to
//               produce. The partner owes the money, not the end customer.
//   sp_direct   the sports office's own jersey sales
//
// Both workspaces keep their own ledger; the master view (owners only) reads
// both. Everything here is pure — no database, no fetch — so the editor's live
// figures and the server's totals are computed by the SAME code and cannot
// disagree. Storage and the exchange-rate lookup live in lib/sales.ts.
//
// ── Money rules, decided with the owner (2026-09-16) ─────────────────────────
// • A sale has any number of PAYMENTS (partial payments are normal). Received,
//   fees, net and outstanding are all derived from them — never typed — so the
//   sheet cannot say "Paid" over a balance.
// • Every payment carries the PKR rate it was actually converted at. That rate
//   is locked on the payment: the profit on the record is the profit that was
//   really made, not whatever today's rate would make it. Until a rate is
//   entered, today's suggested rate stands in and the figure says "est."
// • Costs are a list too, each in its own currency. Production is normally
//   paid in PKR; the old partner sheet also has USD costs, which carry a rate
//   the same way a payment does.
// • Money totals cover OPEN sales. A refunded or cancelled sale stays on the
//   list with its own count, but does not inflate order value or outstanding.

import { hasFeature, type Workspace } from './workspaces'
import { CRM_CURRENCIES, type CrmCurrency } from './crm'
import type { Member } from './auth'

// ── Streams ─────────────────────────────────────────────────────────────────

export type SalesStream = 'pk_direct' | 'pk_partner' | 'sp_direct'

export interface StreamInfo {
  key: SalesStream
  label: string
  short: string
  workspace: Workspace
  blurb: string
}

export const STREAMS: Record<SalesStream, StreamInfo> = {
  pk_direct: {
    key: 'pk_direct', workspace: 'packaging',
    label: 'Model Town Packaging — Direct Sales', short: 'Model Town Direct',
    blurb: 'Packaging orders the Model Town team sold and was paid for directly.',
  },
  pk_partner: {
    key: 'pk_partner', workspace: 'packaging',
    label: 'Packaging — Old Lead Partner Orders (Hamdan)', short: 'Hamdan — Partner Orders',
    blurb: 'Orders the old lead-buying partner, Hamdan, closed from our leads and gave us to produce. The partner owes these payments.',
  },
  sp_direct: {
    key: 'sp_direct', workspace: 'sports',
    label: 'Sports Jerseys — Direct Sales', short: 'Sports Jerseys',
    blurb: 'Jersey orders the sports office sold directly.',
  },
}

export const STREAM_ORDER: SalesStream[] = ['pk_direct', 'pk_partner', 'sp_direct']

export function isSalesStream(v: unknown): v is SalesStream {
  return typeof v === 'string' && (STREAM_ORDER as string[]).includes(v)
}

export function streamsForWorkspace(ws: Workspace): SalesStream[] {
  return STREAM_ORDER.filter((k) => STREAMS[k].workspace === ws)
}

// ── Who may see what ────────────────────────────────────────────────────────
// Admins only, inside their own workspace: production cost and profit are not
// an agent's business. The master view — both businesses at once — is for the
// owner's own accounts only, and is the one deliberate exception to the rule
// that a workspace never sees the other's data.

export const SALES_OWNERS = ['shanimazhar82@gmail.com', 'zeeshanmzhr3@gmail.com']

export function canUseSales(m: Pick<Member, 'role' | 'workspace'> | null | undefined): boolean {
  return !!m && m.role === 'admin' && hasFeature(m.workspace, 'sales')
}

// The master view lives on the packaging dashboard only: on sports the owners
// see just the sports ledger, like everyone else there.
export function isSalesOwner(m: Pick<Member, 'role' | 'workspace' | 'email'> | null | undefined): boolean {
  return canUseSales(m) && m?.workspace === 'packaging' && SALES_OWNERS.includes(String(m?.email ?? '').trim().toLowerCase())
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const SALE_CURRENCIES = CRM_CURRENCIES
export type SaleCurrency = CrmCurrency

export const PAYMENT_METHODS = ['paypal', 'wise', 'payoneer', 'stripe', 'bank', 'cash', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  paypal: 'PayPal', wise: 'Wise', payoneer: 'Payoneer', stripe: 'Stripe',
  bank: 'Bank transfer', cash: 'Cash', other: 'Other',
}

export const PRODUCTION_STATUSES = ['not_started', 'in_production', 'completed', 'shipped', 'delivered', 'on_hold', 'cancelled'] as const
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number]
export const PRODUCTION_LABEL: Record<ProductionStatus, string> = {
  not_started: 'Not started', in_production: 'In production', completed: 'Completed',
  shipped: 'Shipped', delivered: 'Delivered', on_hold: 'On hold', cancelled: 'Cancelled',
}

export type PaymentStatus = 'pending' | 'partial' | 'paid' | 'refunded' | 'cancelled'
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Pending', partial: 'Partial', paid: 'Paid', refunded: 'Refunded', cancelled: 'Cancelled',
}
export const PAYMENT_STATUS_STYLE: Record<PaymentStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 border-amber-300',
  partial: 'bg-blue-100 text-blue-800 border-blue-300',
  paid: 'bg-green-100 text-green-800 border-green-300',
  refunded: 'bg-gray-100 text-gray-700 border-gray-300',
  cancelled: 'bg-gray-100 text-gray-700 border-gray-300',
}

// ── The record ──────────────────────────────────────────────────────────────

export interface SalePayment {
  id: string
  /** YYYY-MM-DD — the day the money arrived. */
  date: string
  /** In the ORDER's currency. */
  amount: number
  /** What the processor kept (PayPal/Wise fee), same currency. */
  fee: number
  method: PaymentMethod
  /** PKR per one unit of the order currency, locked for this payment. */
  rate: number | null
  note: string
}

export interface SaleCost {
  id: string
  label: string
  amount: number
  currency: SaleCurrency
  /** PKR per one unit of `currency`; ignored for PKR costs. */
  rate: number | null
  note: string
}

export interface Sale {
  id: string
  stream: SalesStream
  workspace: Workspace
  /** The order number / sale id people already use (SCB-015, MT-SCB-…). */
  reference: string
  customer: string
  company: string
  email: string
  phone: string
  country: string
  /** YYYY-MM-DD */
  orderDate: string
  product: string
  size: string
  material: string
  printing: string
  quantity: string
  currency: SaleCurrency
  orderAmount: number
  /**
   * PKR per one unit of the order currency, when the DEAL fixed one — the old
   * lead-partner orders were all worked out at 275. It converts the unpaid
   * amount, any payment without a rate of its own, and any cost in the order's
   * currency, and none of those is an estimate while it is set. Absent on
   * sales saved before it existed.
   */
  rate?: number | null
  /**
   * The profit exactly as the deal or the source sheet states it ("172k pkr",
   * "$2,496"). When set it IS the profit — shown as written, not recomputed
   * from revenue minus costs. Absent on sales saved before it existed.
   */
  agreedProfit?: { amount: number; currency: SaleCurrency } | null
  payments: SalePayment[]
  costs: SaleCost[]
  /** Set by hand; otherwise the status follows the payments. */
  statusOverride: 'refunded' | 'cancelled' | null
  production: ProductionStatus | null
  salesPerson: string
  /** How the sale came about. */
  source: string
  /** Who owes the money when it is not the customer — the partner, for pk_partner. */
  counterparty: string
  /** The CRM lead it was won from, if any. */
  leadId: string | null
  notes: string
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
  deleted?: boolean
}

export type PkrRates = Partial<Record<SaleCurrency, number>>

export interface RateInfo {
  /** PKR per one unit of each currency. */
  rates: PkrRates
  asOf: string
  source: string
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

interface Pkr { value: number; estimated: boolean; missing: boolean }

/** One amount in PKR: at its own locked rate, else today's (estimated), else unknown. */
function toPkr(amount: number, currency: SaleCurrency, locked: number | null, suggested: PkrRates | null): Pkr {
  if (!amount) return { value: 0, estimated: false, missing: false }
  if (currency === 'PKR') return { value: amount, estimated: false, missing: false }
  if (locked && locked > 0) return { value: amount * locked, estimated: false, missing: false }
  const r = suggested?.[currency]
  if (r && r > 0) return { value: amount * r, estimated: true, missing: false }
  return { value: 0, estimated: false, missing: true }
}

export interface SaleFigures {
  received: number
  fees: number
  net: number
  outstanding: number
  status: PaymentStatus
  closed: boolean
  /** Net received in PKR, at each payment's own rate. */
  netPkr: number
  /** Outstanding in PKR — at the agreed rate if the deal fixed one, else today's (an estimate). */
  outstandingPkr: number
  revenuePkr: number
  costPkr: number
  profitPkr: number
  /** The profit to show, in its own currency — the agreed one when set, else profitPkr in PKR. */
  profit: { amount: number; currency: SaleCurrency }
  /**
   * False while the costing has not come in (no cost, no agreed profit): the
   * profit is unknown, not "everything received". profitPkr is 0 then and
   * must be shown as pending, never as a number.
   */
  profitKnown: boolean
  /** The profit's PKR figure leans on today's rate. */
  profitEstimated: boolean
  /** Some part used today's rate instead of a locked one. */
  estimated: boolean
  /** Some part could not be converted at all. */
  incomplete: boolean
  /** What still needs a real rate, in words. */
  needsRate: string[]
}

export function figures(s: Sale, suggested: PkrRates | null): SaleFigures {
  const received = round2(s.payments.reduce((a, p) => a + p.amount, 0))
  const fees = round2(s.payments.reduce((a, p) => a + p.fee, 0))
  const net = round2(received - fees)
  const closed = s.statusOverride === 'refunded' || s.statusOverride === 'cancelled'
  const outstanding = closed ? 0 : round2(Math.max(s.orderAmount - received, 0))
  const status: PaymentStatus = s.statusOverride
    ?? (received <= 0 ? 'pending' : received + 0.005 < s.orderAmount ? 'partial' : 'paid')

  let estimated = false
  let incomplete = false
  const needsRate: string[] = []

  // A payment's own rate beats the agreed one: it is what that money was
  // actually converted at.
  const agreed = s.currency === 'PKR' ? null : (s.rate ?? null)

  let netPkr = 0
  for (const p of s.payments) {
    const v = toPkr(p.amount - p.fee, s.currency, p.rate ?? agreed, suggested)
    netPkr += v.value
    if (v.estimated || v.missing) needsRate.push(`payment of ${p.date || 'unknown date'}`)
    estimated ||= v.estimated
    incomplete ||= v.missing
  }
  const out = toPkr(outstanding, s.currency, agreed, suggested)
  estimated ||= out.estimated
  incomplete ||= out.missing

  let costPkr = 0
  for (const c of s.costs) {
    const v = toPkr(c.amount, c.currency, c.rate ?? (c.currency === s.currency ? agreed : null), suggested)
    costPkr += v.value
    if (v.estimated || v.missing) needsRate.push(`${c.label || 'cost'} (${c.currency})`)
    estimated ||= v.estimated
    incomplete ||= v.missing
  }

  const revenuePkr = netPkr + out.value
  let profitPkr = revenuePkr - costPkr
  let profit: { amount: number; currency: SaleCurrency } = { amount: Math.round(profitPkr), currency: 'PKR' }
  let profitEstimated = estimated || incomplete
  const profitKnown = closed || !!s.agreedProfit || s.costs.length > 0
  if (!profitKnown) {
    profitPkr = 0
    profit = { amount: 0, currency: 'PKR' }
    profitEstimated = false
  } else if (s.agreedProfit && !closed) {
    const a = s.agreedProfit
    const v = toPkr(a.amount, a.currency, a.currency === s.currency ? agreed : null, suggested)
    profitPkr = v.value
    profit = { amount: a.amount, currency: a.currency }
    profitEstimated = v.estimated || v.missing
    estimated ||= v.estimated
    incomplete ||= v.missing
  }
  return {
    received, fees, net, outstanding, status, closed,
    netPkr: Math.round(netPkr),
    outstandingPkr: Math.round(out.value),
    revenuePkr: Math.round(revenuePkr),
    costPkr: Math.round(costPkr),
    profitPkr: Math.round(profitPkr),
    profit, profitKnown, profitEstimated,
    estimated, incomplete, needsRate,
  }
}

export interface SaleView { sale: Sale; fig: SaleFigures }

export interface StreamTotals {
  orders: number
  open: number
  closed: number
  /** Money totals are in USD; a non-USD sale is converted through PKR. */
  orderValueUsd: number
  receivedUsd: number
  feesUsd: number
  netUsd: number
  outstandingUsd: number
  revenuePkr: number
  costPkr: number
  /** Summed over open sales whose costing is in; the rest are counted in awaitingCosting. */
  profitPkr: number
  profitSales: number
  awaitingCosting: number
  profitEstimated: boolean
  awaitingPayment: number
  needsRate: number
  estimated: boolean
  incomplete: boolean
}

/** An amount in USD, via today's PKR rates. Null when it cannot be converted. */
function toUsd(amount: number, currency: SaleCurrency, suggested: PkrRates | null): number | null {
  if (currency === 'USD' || !amount) return amount
  const src = currency === 'PKR' ? 1 : suggested?.[currency]
  const usd = suggested?.USD
  if (!src || !usd) return null
  return (amount * src) / usd
}

export function totals(views: SaleView[], suggested: PkrRates | null): StreamTotals {
  const t: StreamTotals = {
    orders: views.length, open: 0, closed: 0,
    orderValueUsd: 0, receivedUsd: 0, feesUsd: 0, netUsd: 0, outstandingUsd: 0,
    revenuePkr: 0, costPkr: 0, profitPkr: 0, profitSales: 0, awaitingCosting: 0, profitEstimated: false,
    awaitingPayment: 0, needsRate: 0, estimated: false, incomplete: false,
  }
  for (const { sale: s, fig: f } of views) {
    if (f.closed) { t.closed++; continue }
    t.open++
    const usd = (n: number) => {
      const v = toUsd(n, s.currency, suggested)
      if (v === null) { t.incomplete = true; return 0 }
      return v
    }
    t.orderValueUsd += usd(s.orderAmount)
    t.receivedUsd += usd(f.received)
    t.feesUsd += usd(f.fees)
    t.netUsd += usd(f.net)
    t.outstandingUsd += usd(f.outstanding)
    t.revenuePkr += f.revenuePkr
    t.costPkr += f.costPkr
    if (f.profitKnown) {
      t.profitPkr += f.profitPkr
      t.profitSales++
      t.profitEstimated ||= f.profitEstimated
    } else t.awaitingCosting++
    if (f.status === 'pending' || f.status === 'partial') t.awaitingPayment++
    if (f.needsRate.length) t.needsRate++
    t.estimated ||= f.estimated
    t.incomplete ||= f.incomplete
  }
  for (const k of ['orderValueUsd', 'receivedUsd', 'feesUsd', 'netUsd', 'outstandingUsd'] as const) t[k] = round2(t[k])
  return t
}

// ── Cleaning what a browser sends ───────────────────────────────────────────

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

const MAX_AMOUNT = 1_000_000_000
const MAX_RATE = 100_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** "12,500" / "$12500" / 12500 → 12500. Negative and absurd values refused. */
export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  // Text with no digit in it is not an amount. Stripping it first used to
  // leave an empty string, and Number('') is 0 — so "abc" in the order amount
  // saved a $0 sale instead of being refused.
  const cleaned = typeof v === 'number' ? null : String(v).replace(/[^0-9.-]/g, '')
  if (cleaned !== null && !/\d/.test(cleaned)) return null
  // "31.8k" / "172k pkr" — how the sheets write thousands.
  const thousands = typeof v === 'string' && /\d\s*k\b/i.test(v)
  const n = typeof v === 'number' ? v : Number(cleaned) * (thousands ? 1000 : 1)
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return null
  return round2(n)
}

function parseRate(v: unknown): number | null {
  const n = parseAmount(v)
  return n && n > 0 && n <= MAX_RATE ? n : null
}

const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max)
const date = (v: unknown) => { const s = text(v, 10); return DATE_RE.test(s) ? s : '' }
const currency = (v: unknown): SaleCurrency => {
  const c = text(v, 3).toUpperCase()
  return (SALE_CURRENCIES as readonly string[]).includes(c) ? (c as SaleCurrency) : 'USD'
}

/**
 * The sale as it may be stored, or the reason it may not.
 *
 * `prev` is the stored version when editing — it keeps who created it and when,
 * and it is what pins the workspace: a sale never moves between businesses.
 */
export function cleanSale(
  raw: unknown, prev: Sale | null, actor: string, ws: Workspace,
): { sale: Sale } | { error: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  const stream = r.stream
  if (!isSalesStream(stream)) return { error: 'Choose which sales stream this belongs to.' }
  if (STREAMS[stream].workspace !== ws) return { error: 'That stream belongs to the other workspace.' }
  if (prev && prev.workspace !== ws) return { error: 'That sale belongs to the other workspace.' }

  const customer = text(r.customer, 200)
  if (!customer) return { error: 'A customer name is required.' }
  const orderAmount = parseAmount(r.orderAmount)
  if (orderAmount === null) return { error: 'The order amount must be a number.' }
  const cur = currency(r.currency)

  const payments: SalePayment[] = []
  for (const p of (Array.isArray(r.payments) ? r.payments : []).slice(0, 50)) {
    const o = (p ?? {}) as Record<string, unknown>
    const amount = parseAmount(o.amount)
    if (!amount) continue
    const fee = parseAmount(o.fee) ?? 0
    if (fee > amount) return { error: 'A payment fee cannot be larger than the payment.' }
    payments.push({
      id: text(o.id, 40) || newId('pay'),
      date: date(o.date),
      amount, fee,
      method: (PAYMENT_METHODS as readonly string[]).includes(String(o.method)) ? (o.method as PaymentMethod) : 'other',
      rate: cur === 'PKR' ? null : parseRate(o.rate),
      note: text(o.note, 300),
    })
  }

  const costs: SaleCost[] = []
  for (const c of (Array.isArray(r.costs) ? r.costs : []).slice(0, 50)) {
    const o = (c ?? {}) as Record<string, unknown>
    const amount = parseAmount(o.amount)
    if (!amount) continue
    const cc = currency(o.currency)
    costs.push({
      id: text(o.id, 40) || newId('cost'),
      label: text(o.label, 80) || 'Production',
      amount, currency: cc,
      rate: cc === 'PKR' ? null : parseRate(o.rate),
      note: text(o.note, 300),
    })
  }

  const ap = (r.agreedProfit ?? null) as Record<string, unknown> | null
  const apAmount = ap ? parseAmount(ap.amount) : null
  const agreedProfit = ap && apAmount ? { amount: apAmount, currency: currency(ap.currency) } : null

  const override = r.statusOverride === 'refunded' || r.statusOverride === 'cancelled' ? r.statusOverride : null
  const production = (PRODUCTION_STATUSES as readonly string[]).includes(String(r.production))
    ? (r.production as ProductionStatus) : null
  const now = new Date().toISOString()

  return {
    sale: {
      id: prev?.id ?? newId('sale'),
      stream, workspace: ws,
      reference: text(r.reference, 80),
      customer,
      company: text(r.company, 200),
      email: text(r.email, 200),
      phone: text(r.phone, 60),
      country: text(r.country, 60),
      orderDate: date(r.orderDate),
      product: text(r.product, 200),
      size: text(r.size, 120),
      material: text(r.material, 120),
      printing: text(r.printing, 120),
      quantity: text(r.quantity, 60),
      currency: cur,
      orderAmount,
      rate: cur === 'PKR' ? null : parseRate(r.rate),
      agreedProfit,
      payments, costs,
      statusOverride: override,
      production,
      salesPerson: text(r.salesPerson, 200),
      source: text(r.source, 300),
      counterparty: text(r.counterparty, 200),
      leadId: text(r.leadId, 80) || null,
      notes: text(r.notes, 3000),
      createdAt: prev?.createdAt ?? now,
      createdBy: prev?.createdBy ?? actor,
      updatedAt: now,
      updatedBy: actor,
    },
  }
}

// ── Display ─────────────────────────────────────────────────────────────────

export function money(n: number, cur: SaleCurrency | 'PKR'): string {
  const sym = cur === 'PKR' ? 'Rs ' : cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : `${cur} `
  const neg = n < 0
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: cur === 'PKR' ? 0 : 2,
    maximumFractionDigits: cur === 'PKR' ? 0 : 2,
  })
  return `${neg ? '−' : ''}${sym}${body}`
}

/** "2026-09-16" → "16 Sep 2026", with no timezone involved at all. */
export function shortDate(ymd: string): string {
  if (!DATE_RE.test(ymd)) return '—'
  const [y, m, d] = ymd.split('-').map(Number)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
  return `${d} ${mon} ${y}`
}
