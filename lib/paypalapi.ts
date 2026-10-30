// PayPal REST, read-only, for the PACKAGING business account (ZCB DIGITAL LTD).
// Credentials: Vercel env PAYPAL_PACKAGING_CLIENT_ID / PAYPAL_PACKAGING_SECRET
// (an app with Invoicing + Transaction search, created 2026-10-26). Nothing
// here creates, sends or changes anything in PayPal.

const API = 'https://api-m.paypal.com'
let tok: { value: string; until: number } | null = null

export function paypalConfigured(): boolean {
  return !!(process.env.PAYPAL_PACKAGING_CLIENT_ID && process.env.PAYPAL_PACKAGING_SECRET)
}

async function token(): Promise<string> {
  if (tok && Date.now() < tok.until) return tok.value
  const id = process.env.PAYPAL_PACKAGING_CLIENT_ID ?? '', secret = process.env.PAYPAL_PACKAGING_SECRET ?? ''
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!r.ok) throw new Error(`PayPal token ${r.status}`)
  const j = await r.json() as { access_token: string; expires_in: number }
  tok = { value: j.access_token, until: Date.now() + (j.expires_in - 300) * 1000 }
  return tok.value
}

async function call<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; json: T | null; location: string | null }> {
  const r = await fetch(`${API}${path}`, {
    method, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`PayPal ${method} ${path.split('?')[0]} ${r.status}: ${text.slice(0, 300)}`)
  let json: T | null = null
  try { json = text ? JSON.parse(text) as T : null } catch { json = null }
  return { status: r.status, json, location: r.headers.get('location') }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await token()}` } })
  if (!r.ok) throw new Error(`PayPal ${path.split('?')[0]} ${r.status}: ${(await r.text()).slice(0, 160)}`)
  return r.json() as Promise<T>
}

export interface PpInvoice {
  id: string                 // INV2-PVYD-CB5S-B2V7-56VM
  number: string             // 0013
  status: string             // DRAFT SENT UNPAID PAID PARTIALLY_PAID MARKED_AS_PAID CANCELLED …
  date: string
  amount: number
  due: number
  currency: string
  name: string
  business: string
  email: string
  payments: { paymentId: string; date: string; amount: number; method: string }[]
}

/** "INV2-PVYD-CB5S-B2V7-56VM" → "PVYDCB5SB2V756VM", the code in the payer link. */
export const shortCode = (id: string) => id.replace(/^INV2-/i, '').replace(/-/g, '').toUpperCase()

/** Every invoice on the account, newest first (status + payments included). */
export async function listInvoices(max = 200): Promise<PpInvoice[]> {
  const out: PpInvoice[] = []
  for (let page = 1; out.length < max && page <= 10; page++) {
    const j = await get<{ items?: Record<string, unknown>[] }>(`/v2/invoicing/invoices?page=${page}&page_size=50&total_required=false&fields=amount`)
    const items = j.items ?? []
    for (const it of items) {
      const det = (it.detail ?? {}) as Record<string, unknown>
      const rec = ((it.primary_recipients as Record<string, unknown>[] | undefined)?.[0]?.billing_info ?? {}) as Record<string, unknown>
      const amt = (it.amount ?? {}) as { value?: string; currency_code?: string }
      const due = (it.due_amount ?? {}) as { value?: string }
      const pays = (((it.payments ?? {}) as { transactions?: Record<string, unknown>[] }).transactions ?? [])
      out.push({
        id: String(it.id ?? ''), number: String(det.invoice_number ?? ''), status: String(it.status ?? ''),
        date: String(det.invoice_date ?? ''), amount: Number(amt.value ?? 0), due: Number(due.value ?? 0),
        currency: String(amt.currency_code ?? 'USD'),
        name: String(((rec.name ?? {}) as { full_name?: string }).full_name ?? ''), business: String(rec.business_name ?? ''),
        email: String(rec.email_address ?? ''),
        payments: pays.map((p) => ({ paymentId: String(p.payment_id ?? ''), date: String(p.payment_date ?? ''), amount: Number(((p.amount ?? {}) as { value?: string }).value ?? 0), method: String(p.method ?? '') })),
      })
    }
    if (items.length < 50) break
  }
  return out
}

/** The full invoice (the list leaves payments out on some accounts). */
export async function invoiceDetail(id: string): Promise<PpInvoice['payments']> {
  const j = await get<{ payments?: { transactions?: Record<string, unknown>[] } }>(`/v2/invoicing/invoices/${encodeURIComponent(id)}`)
  return (j.payments?.transactions ?? []).map((p) => ({ paymentId: String(p.payment_id ?? ''), date: String(p.payment_date ?? ''), amount: Number(((p.amount ?? {}) as { value?: string }).value ?? 0), method: String(p.method ?? '') }))
}

/** PayPal's fee on one payment (positive number), or null when not found. */
export async function feeFor(paymentId: string, day: string): Promise<number | null> {
  const d = new Date(`${day}T00:00:00Z`)
  const from = new Date(+d - 2 * 864e5).toISOString().replace(/\.\d{3}Z$/, '-0000')
  const to = new Date(Math.min(Date.now(), +d + 3 * 864e5)).toISOString().replace(/\.\d{3}Z$/, '-0000')
  const j = await get<{ transaction_details?: { transaction_info: { transaction_id: string; fee_amount?: { value?: string } } }[] }>(
    `/v1/reporting/transactions?transaction_id=${encodeURIComponent(paymentId)}&start_date=${from}&end_date=${to}&fields=transaction_info`)
  const t = j.transaction_details?.find((x) => x.transaction_info.transaction_id === paymentId)
  const v = t?.transaction_info.fee_amount?.value
  return v === undefined ? null : Math.abs(Number(v))
}

export interface PpTxn { id: string; code: string; date: string; amount: number; currency: string; fee: number; ref: string }

/** Transactions between two days (the API allows 31 days per call). */
export async function listTransactions(fromDay: string, toDay: string): Promise<PpTxn[]> {
  const out: PpTxn[] = []
  let start = new Date(`${fromDay}T00:00:00Z`)
  const end = new Date(Math.min(Date.now(), +new Date(`${toDay}T23:59:59Z`)))
  while (start < end) {
    const stop = new Date(Math.min(+end, +start + 30 * 864e5))
    const f = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '-0000')
    for (let page = 1; page <= 20; page++) {
      const j = await get<{ transaction_details?: { transaction_info: Record<string, unknown> }[]; total_pages?: number }>(
        `/v1/reporting/transactions?start_date=${f(start)}&end_date=${f(stop)}&fields=transaction_info&page_size=500&page=${page}`)
      for (const x of j.transaction_details ?? []) {
        const t = x.transaction_info
        const a = (t.transaction_amount ?? {}) as { value?: string; currency_code?: string }
        out.push({ id: String(t.transaction_id ?? ''), code: String(t.transaction_event_code ?? ''), date: String(t.transaction_initiation_date ?? '').slice(0, 10),
          amount: Number(a.value ?? 0), currency: String(a.currency_code ?? ''), fee: Math.abs(Number(((t.fee_amount ?? {}) as { value?: string }).value ?? 0)), ref: String(t.paypal_reference_id ?? '') })
      }
      if (!j.total_pages || page >= j.total_pages) break
    }
    start = stop
  }
  return out
}

/** Mid-market GBP→PKR for a day (free daily rates, cached per process). */
const gbpPkrCache = new Map<string, number>()
export async function gbpPkrOn(day: string): Promise<number | null> {
  if (gbpPkrCache.has(day)) return gbpPkrCache.get(day)!
  for (const url of [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/gbp.json`, `https://${day}.currency-api.pages.dev/v1/currencies/gbp.json`]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!r.ok) continue
      const v = Number(((await r.json()) as { gbp?: { pkr?: number } }).gbp?.pkr)
      if (v > 0) { gbpPkrCache.set(day, v); return v }
    } catch { /* next */ }
  }
  return null
}

export interface NewPpInvoice {
  number?: string
  currency: string
  date: string            // YYYY-MM-DD
  dueDate?: string
  recipient: { email: string; name: string; company: string; address: string; phone: string }
  shipTo?: { name: string; company: string; address: string } | null
  items: { name: string; description: string; quantity: number; unitPrice: number }[]
  taxPercent: number
  note: string
  terms: string
  reference: string
  /** Allow part payment with this minimum (a deposit), or null for full only. */
  minimumDue: number | null
}

/**
 * The next number in the account's OWN series ("0017"): the highest all-digit
 * invoice number + 1, same width. Not PayPal's generate-next-invoice-number —
 * that follows the LAST number used, and one test draft named "TEST-…" made it
 * hand out "TEST-mvp0bf90" (2026-10-26).
 */
export async function nextInvoiceNumber(): Promise<string> {
  const all = await listInvoices(500)
  const nums = all.map((i) => i.number).filter((n) => /^\d{1,8}$/.test(n))
  if (!nums.length) return '0001'
  const max = Math.max(...nums.map(Number))
  const width = Math.max(4, ...nums.map((n) => n.length))
  return String(max + 1).padStart(width, '0')
}

/** Cancel a SENT invoice (PayPal tells the customer it is cancelled). */
export async function cancelInvoice(id: string, note = 'Cancelled'): Promise<void> {
  await call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, { subject: 'Invoice cancelled', note, send_to_invoicer: false, send_to_recipient: true })
}

/** Create a DRAFT invoice on the packaging PayPal account. Returns its id. */
export async function createDraft(i: NewPpInvoice): Promise<{ id: string; number: string }> {
  const [given, ...rest] = i.recipient.name.trim().split(/\s+/)
  const lines = (a: string) => a.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  const addr = lines(i.recipient.address)
  const body = {
    detail: {
      invoice_number: i.number || undefined,
      reference: i.reference.slice(0, 120) || undefined,
      invoice_date: i.date, currency_code: i.currency,
      note: i.note.slice(0, 4000) || undefined, term: i.terms.slice(0, 4000) || undefined,
      payment_term: i.dueDate && i.dueDate !== i.date ? { due_date: i.dueDate } : { term_type: 'DUE_ON_RECEIPT' },
    },
    primary_recipients: [{
      billing_info: {
        name: { given_name: given || i.recipient.name, surname: rest.join(' ') || undefined },
        business_name: i.recipient.company || undefined,
        email_address: i.recipient.email,
        additional_info: addr.length ? addr.join(', ').slice(0, 400) : undefined,
      },
      ...(i.shipTo ? { shipping_info: { name: { given_name: i.shipTo.name || given }, business_name: i.shipTo.company || undefined } } : {}),
    }],
    items: i.items.map((it) => {
      // PayPal keeps 2 decimals on a unit price and CUTS the rest: 7,000 at
      // $0.248 became $0.24, and Amouage's $3,581 invoice came out $3,480
      // (TPC-030, 2026-10-30). Such a line goes as ONE unit of its exact
      // total, with the real quantity and rate written in the description.
      const exact = Math.abs(Math.round(it.unitPrice * 100) - it.unitPrice * 100) < 1e-6
      const total = Math.round(it.quantity * it.unitPrice * 100) / 100
      const rate = `${it.quantity.toLocaleString('en-US')} × $${it.unitPrice}`
      return {
        name: it.name.slice(0, 200),
        description: (exact ? it.description : [rate, it.description].filter(Boolean).join('\n')).slice(0, 1000) || undefined,
        quantity: exact ? String(it.quantity) : '1',
        unit_amount: { currency_code: i.currency, value: (exact ? it.unitPrice : total).toFixed(2) },
        ...(i.taxPercent > 0 ? { tax: { name: 'Tax', percent: String(i.taxPercent) } } : {}),
        unit_of_measure: exact ? 'QUANTITY' : 'AMOUNT',
      }
    }),
    configuration: {
      allow_tip: false, tax_inclusive: false,
      ...(i.minimumDue && i.minimumDue > 0 ? { partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: i.currency, value: i.minimumDue.toFixed(2) } } } : {}),
    },
  }
  const r = await call<{ id?: string; href?: string; detail?: { invoice_number?: string } }>('POST', '/v2/invoicing/invoices', body)
  const id = r.json?.id ?? String(r.json?.href ?? r.location ?? '').split('/').pop() ?? ''
  if (!id) throw new Error('PayPal did not return an invoice id')
  return { id, number: r.json?.detail?.invoice_number ?? i.number ?? '' }
}

/** Send a draft: PayPal emails the customer. Returns the payer link. */
export async function sendInvoice(id: string): Promise<string> {
  await call('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, { send_to_invoicer: true, send_to_recipient: true })
  const d = await get<{ detail?: { metadata?: { recipient_view_url?: string } } }>(`/v2/invoicing/invoices/${encodeURIComponent(id)}`)
  return d.detail?.metadata?.recipient_view_url ?? `https://www.paypal.com/invoice/p/#${shortCode(id)}`
}

/** Delete a DRAFT (tests, or an agent changing their mind before sending). */
export async function deleteDraft(id: string): Promise<void> {
  await call('DELETE', `/v2/invoicing/invoices/${encodeURIComponent(id)}`)
}
