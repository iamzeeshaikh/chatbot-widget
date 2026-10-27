// The price quote email, built from structured fields (Saifullah, 2026-10-22:
// "price table ki form mein bhejta hoon jo portal mein possible nahi — quote
// send karne ka format bana dein, details put karke Send quote dabayen").
// Pure: the page renders the preview with it and the send route builds the
// real email with the SAME function, so what the agent sees is what goes.
// The table is ours, built here — the composer's sanitizer would strip a
// pasted table, which is why quotes could not go from the portal before.

// Several products in one quote (Samir, 2026-10-22: a lipstick-box customer
// also wants mascara, lip balm and brush boxes — "neeche mascara box add kar
// dein, iske neeche lip balm" — every product with its own table, all on one
// page). Each item carries its own specs and quantity rows.

export interface QuoteRow { quantity: string; unitPrice: string }
export interface QuoteItem {
  product: string
  /** One detail per line: size, material, printing, finish… */
  specs: string
  rows: QuoteRow[]
  /** Which option this product belongs to ("Standard 18-22 days", "Rush").
   *  Products in different options are never added together (Saifullah,
   *  2026-10-23: two lead times in one quote, one total confused the customer). */
  option?: string
}
export interface PriceQuote {
  greetingName: string
  intro: string
  items: QuoteItem[]
  /** One per line: free shipping, mockups, no hidden charges… */
  included: string
  turnaround: string
  validity: string
  closing: string
  currency: string
  /** false hides every order total from the email and the PDF. */
  showTotal?: boolean
}

export const DEFAULT_INCLUDED = ['Free shipping to your doorstep', 'Free 2D and 3D mockups before printing', 'No extra or hidden charges'].join('\n')

export const blankItem = (product = ''): QuoteItem => ({ product, specs: '', rows: [{ quantity: '', unitPrice: '' }] })

export function blankQuote(name: string, product: string): PriceQuote {
  return {
    greetingName: (name || '').trim().split(/\s+/)[0] || '',
    intro: 'Thank you for your patience! Here is the price quote for your order:',
    items: [blankItem(product)],
    included: DEFAULT_INCLUDED, turnaround: '12-15 business days after artwork approval', validity: '30 days',
    closing: 'Please let me know which quantity works best for you, or if you would like any changes. I would be happy to help!',
    currency: 'USD',
  }
}

/** Accepts a quote in the old one-product shape (a draft saved before
 *  2026-10-22, or a stale tab posting it) and returns the items shape. */
export function normalizeQuote(raw: unknown): PriceQuote {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const base = blankQuote('', '')
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
  const rowsOf = (v: unknown): QuoteRow[] => (Array.isArray(v) ? v : []).map((r) => ({ quantity: str((r as QuoteRow)?.quantity, ''), unitPrice: str((r as QuoteRow)?.unitPrice, '') }))
  let items: QuoteItem[] = Array.isArray(o.items)
    ? (o.items as unknown[]).map((it) => { const i = (it ?? {}) as Record<string, unknown>; return { product: str(i.product, ''), specs: str(i.specs, ''), rows: rowsOf(i.rows), option: str(i.option, '').slice(0, 80) } })
    : [{ product: str(o.product, ''), specs: str(o.specs, ''), rows: rowsOf(o.rows) }]
  items = items.slice(0, 15).map((i) => (i.rows.length ? i : { ...i, rows: [{ quantity: '', unitPrice: '' }] }))
  if (!items.length) items = [blankItem()]
  return {
    greetingName: str(o.greetingName, ''), intro: str(o.intro, base.intro), items,
    included: str(o.included, base.included), turnaround: str(o.turnaround, base.turnaround),
    validity: str(o.validity, base.validity), closing: str(o.closing, base.closing), currency: (QUOTE_CURRENCIES as readonly string[]).includes(str(o.currency, '')) ? str(o.currency, '') : 'USD',
    showTotal: o.showTotal !== false,
  }
}

export const num = (v: string): number => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0 }
// The currencies an agent can quote in (Saifullah, 2026-10-27: a UK customer
// needs the quote in pounds). USD stays the default; a UK site opens on GBP.
export const QUOTE_CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD'] as const
export const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$' }
export const currencySymbol = (cur: string) => CURRENCY_SYMBOL[cur] ?? `${cur} `
export const money = (v: number, cur = 'USD') => currencySymbol(cur) + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const unit = (v: number, cur: string) => currencySymbol(cur) + (v < 1 ? v.toFixed(3).replace(/0$/, '') : v.toFixed(2))

export function cleanRows(item: QuoteItem): { qty: number; unit: number; total: number }[] {
  return item.rows.map((r) => ({ qty: num(r.quantity), unit: num(r.unitPrice) })).filter((r) => r.qty > 0 && r.unit > 0)
    .map((r) => ({ ...r, total: Math.round(r.qty * r.unit * 100) / 100 }))
}

/** Items that will actually appear: a name and at least one priced row. */
export const filledItems = (q: PriceQuote) => q.items.filter((i) => i.product.trim() && cleanRows(i).length > 0)

/** "Lipstick Boxes", "Lipstick Boxes & Mascara Boxes", "Lipstick Boxes + 3 more". */
export function quoteTitle(q: PriceQuote): string {
  const names = q.items.map((i) => i.product.trim()).filter(Boolean)
  if (names.length <= 2) return names.join(' & ')
  return `${names[0]} + ${names.length - 1} more`
}

const optionOf = (i: QuoteItem) => (i.option ?? '').trim()

/** The products grouped by option, in the order the agent wrote them. */
export function optionGroups(q: PriceQuote): { label: string; items: QuoteItem[] }[] {
  const out: { label: string; items: QuoteItem[] }[] = []
  for (const it of filledItems(q)) {
    const label = optionOf(it)
    let g = out.find((x) => x.label.toLowerCase() === label.toLowerCase())
    if (!g) { g = { label, items: [] }; out.push(g) }
    g.items.push(it)
  }
  return out
}

/**
 * The totals the customer sees: none when the agent switched them off; one per
 * option when the quote has options (never one across options); otherwise a
 * single order total for 2+ products. A total only means something when every
 * product in it has ONE quantity.
 */
export function orderTotals(q: PriceQuote): { label: string; count: number; total: number }[] {
  if (q.showTotal === false) return []
  const groups = optionGroups(q)
  const many = groups.length > 1
  return groups
    .filter((g) => (many || g.items.length >= 2) && g.items.every((i) => cleanRows(i).length === 1))
    .map((g) => ({ label: many ? g.label : '', count: g.items.length, total: Math.round(g.items.reduce((a, i) => a + cleanRows(i)[0].total, 0) * 100) / 100 }))
}

/** Back-compat: the single order total, when there is exactly one. */
export function grandTotal(q: PriceQuote): number | null {
  const t = orderTotals(q)
  return t.length === 1 && !t[0].label ? t[0].total : null
}

/** Deal value recorded on send: the first quantity of every product in the
 *  FIRST option (options are alternatives, not additions). */
export const dealValue = (q: PriceQuote) => Math.round((optionGroups(q)[0]?.items ?? []).reduce((a, i) => a + cleanRows(i)[0].total, 0))

const totalLine = (t: { label: string; count: number }) => t.label ? `Total — ${t.label} (${t.count} product${t.count === 1 ? '' : 's'})` : `Order total (all ${t.count} products)`

export function quoteProblems(q: PriceQuote): string[] {
  const out: string[] = []
  if (!q.items.some((i) => i.product.trim())) out.push('the product')
  if (filledItems(q).length === 0) out.push('at least one quantity with a unit price')
  const half = q.items.findIndex((i) => (i.product.trim() || i.specs.trim() || cleanRows(i).length) && !(i.product.trim() && cleanRows(i).length))
  if (half >= 0 && filledItems(q).length > 0) out.push(`a name and a price for product ${half + 1} (or remove it)`)
  return out
}

const esc = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const lines = (v: string) => String(v ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

export const PDF_LINE = 'The full quotation is attached as a PDF for your records.'

export function quoteText(q: PriceQuote, opts: { pdf?: boolean } = {}): string {
  const items = filledItems(q)
  const many = items.length > 1
  const out = [q.greetingName ? `Hello ${q.greetingName},` : 'Hello,', '', q.intro, '']
  items.forEach((it, n) => {
    const opt = optionOf(it) ? ` — ${optionOf(it)}` : ''
    out.push(many ? `${n + 1}. ${it.product}${opt}` : `${it.product}${opt}`, ...lines(it.specs).map((l) => `- ${l}`), '',
      'Quantity | Unit price | Total',
      ...cleanRows(it).map((r) => `${r.qty.toLocaleString('en-US')} | ${unit(r.unit, q.currency)} | ${money(r.total, q.currency)}`), '')
  })
  for (const t of orderTotals(q)) out.push(`${totalLine(t)}: ${money(t.total, q.currency)}`)
  if (orderTotals(q).length) out.push('')
  if (opts.pdf) out.push(PDF_LINE, '')
  const inc = lines(q.included)
  if (inc.length) out.push('Included:', ...inc.map((l) => `- ${l}`), '')
  if (q.turnaround.trim()) out.push(`Turnaround: ${q.turnaround.trim()}`)
  if (q.validity.trim()) out.push(`Quote valid for: ${q.validity.trim()}`)
  out.push('', q.closing, '', 'Warm regards,')
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function quoteHtml(q: PriceQuote, opts: { pdf?: boolean } = {}): string {
  const items = filledItems(q)
  const many = items.length > 1
  const p = (t: string) => `<p style="margin:0 0 14px 0;">${esc(t)}</p>`
  const th = 'padding:9px 14px;border:1px solid #d1d5db;background:#111827;color:#ffffff;font-weight:600;text-align:'
  const td = 'padding:9px 14px;border:1px solid #d1d5db;text-align:'
  const inc = lines(q.included)
  const totals = orderTotals(q)
  const block = (it: QuoteItem, n: number) => {
    const specs = lines(it.specs)
    return [
      `<p style="margin:0 0 6px 0;"><b>${many ? `${n + 1}. ` : ''}${esc(it.product)}</b>${optionOf(it) ? ` <span style="color:#6b7280;">— ${esc(optionOf(it))}</span>` : ''}</p>`,
      specs.length ? `<ul style="margin:0 0 10px 18px;padding:0;color:#374151;">${specs.map((l) => `<li style="margin:2px 0;">${esc(l)}</li>`).join('')}</ul>` : '',
      `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 ${many ? 20 : 16}px 0;font-size:14px;">`,
      `<tr><th style="${th}left;">Quantity</th><th style="${th}right;">Unit price</th><th style="${th}right;">Total</th></tr>`,
      ...cleanRows(it).map((r, i) => `<tr style="background:${i % 2 ? '#f9fafb' : '#ffffff'};"><td style="${td}left;">${r.qty.toLocaleString('en-US')}</td><td style="${td}right;">${esc(unit(r.unit, q.currency))}</td><td style="${td}right;font-weight:600;">${esc(money(r.total, q.currency))}</td></tr>`),
      `</table>`,
    ].join('')
  }
  return [
    p(q.greetingName ? `Hello ${q.greetingName},` : 'Hello,'),
    p(q.intro),
    ...items.map(block),
    ...totals.map((t, i) => `<p style="margin:0 0 ${i === totals.length - 1 ? 16 : 4}px 0;font-size:15px;"><b>${esc(totalLine(t))}: ${esc(money(t.total, q.currency))}</b></p>`),
    opts.pdf ? p(PDF_LINE) : '',
    inc.length ? `<p style="margin:0 0 4px 0;"><b>Included with your order:</b></p><ul style="margin:0 0 14px 18px;padding:0;">${inc.map((l) => `<li style="margin:2px 0;">${esc(l)}</li>`).join('')}</ul>` : '',
    q.turnaround.trim() ? `<p style="margin:0 0 4px 0;"><b>Turnaround:</b> ${esc(q.turnaround.trim())}</p>` : '',
    q.validity.trim() ? `<p style="margin:0 0 14px 0;"><b>Quote valid for:</b> ${esc(q.validity.trim())}</p>` : '',
    p(q.closing),
    p('Warm regards,'),
  ].join('')
}
