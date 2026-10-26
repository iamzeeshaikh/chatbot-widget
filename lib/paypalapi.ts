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
