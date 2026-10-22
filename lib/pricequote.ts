// The price quote email, built from structured fields (Saifullah, 2026-10-22:
// "price table ki form mein bhejta hoon jo portal mein possible nahi — quote
// send karne ka format bana dein, details put karke Send quote dabayen").
// Pure: the page renders the preview with it and the send route builds the
// real email with the SAME function, so what the agent sees is what goes.
// The table is ours, built here — the composer's sanitizer would strip a
// pasted table, which is why quotes could not go from the portal before.

export interface QuoteRow { quantity: string; unitPrice: string }
export interface PriceQuote {
  greetingName: string
  intro: string
  product: string
  /** One detail per line: size, material, printing, finish… */
  specs: string
  rows: QuoteRow[]
  /** One per line: free shipping, mockups, no hidden charges… */
  included: string
  turnaround: string
  validity: string
  closing: string
  currency: string
}

export const DEFAULT_INCLUDED = ['Free shipping to your doorstep', 'Free 2D and 3D mockups before printing', 'No extra or hidden charges'].join('\n')

export function blankQuote(name: string, product: string): PriceQuote {
  return {
    greetingName: (name || '').trim().split(/\s+/)[0] || '',
    intro: 'Thank you for your patience! Here is the price quote for your order:',
    product, specs: '', rows: [{ quantity: '', unitPrice: '' }],
    included: DEFAULT_INCLUDED, turnaround: '12-15 business days after artwork approval', validity: '30 days',
    closing: 'Please let me know which quantity works best for you, or if you would like any changes. I would be happy to help!',
    currency: 'USD',
  }
}

export const num = (v: string): number => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : 0 }
export const money = (v: number, cur = 'USD') => (cur === 'USD' ? '$' : `${cur} `) + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const unit = (v: number, cur: string) => (cur === 'USD' ? '$' : `${cur} `) + (v < 1 ? v.toFixed(3).replace(/0$/, '') : v.toFixed(2))

export function cleanRows(q: PriceQuote): { qty: number; unit: number; total: number }[] {
  return q.rows.map((r) => ({ qty: num(r.quantity), unit: num(r.unitPrice) })).filter((r) => r.qty > 0 && r.unit > 0)
    .map((r) => ({ ...r, total: Math.round(r.qty * r.unit * 100) / 100 }))
}

export function quoteProblems(q: PriceQuote): string[] {
  const out: string[] = []
  if (!q.product.trim()) out.push('the product')
  if (cleanRows(q).length === 0) out.push('at least one quantity with a unit price')
  return out
}

const esc = (v: string) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const lines = (v: string) => String(v ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)

export function quoteText(q: PriceQuote): string {
  const rows = cleanRows(q)
  const out = [
    q.greetingName ? `Hello ${q.greetingName},` : 'Hello,', '', q.intro, '',
    q.product, ...lines(q.specs).map((l) => `- ${l}`), '',
    'Quantity | Unit price | Total',
    ...rows.map((r) => `${r.qty.toLocaleString('en-US')} | ${unit(r.unit, q.currency)} | ${money(r.total, q.currency)}`), '',
  ]
  const inc = lines(q.included)
  if (inc.length) out.push('Included:', ...inc.map((l) => `- ${l}`), '')
  if (q.turnaround.trim()) out.push(`Turnaround: ${q.turnaround.trim()}`)
  if (q.validity.trim()) out.push(`Quote valid for: ${q.validity.trim()}`)
  out.push('', q.closing, '', 'Warm regards,')
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function quoteHtml(q: PriceQuote): string {
  const rows = cleanRows(q)
  const p = (t: string) => `<p style="margin:0 0 14px 0;">${esc(t)}</p>`
  const th = 'padding:9px 14px;border:1px solid #d1d5db;background:#111827;color:#ffffff;font-weight:600;text-align:'
  const td = 'padding:9px 14px;border:1px solid #d1d5db;text-align:'
  const specs = lines(q.specs)
  const inc = lines(q.included)
  return [
    p(q.greetingName ? `Hello ${q.greetingName},` : 'Hello,'),
    p(q.intro),
    `<p style="margin:0 0 6px 0;"><b>${esc(q.product)}</b></p>`,
    specs.length ? `<ul style="margin:0 0 14px 18px;padding:0;color:#374151;">${specs.map((l) => `<li style="margin:2px 0;">${esc(l)}</li>`).join('')}</ul>` : '',
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px 0;font-size:14px;">`,
    `<tr><th style="${th}left;">Quantity</th><th style="${th}right;">Unit price</th><th style="${th}right;">Total</th></tr>`,
    ...rows.map((r, i) => `<tr style="background:${i % 2 ? '#f9fafb' : '#ffffff'};"><td style="${td}left;">${r.qty.toLocaleString('en-US')}</td><td style="${td}right;">${esc(unit(r.unit, q.currency))}</td><td style="${td}right;font-weight:600;">${esc(money(r.total, q.currency))}</td></tr>`),
    `</table>`,
    inc.length ? `<p style="margin:0 0 4px 0;"><b>Included with your order:</b></p><ul style="margin:0 0 14px 18px;padding:0;">${inc.map((l) => `<li style="margin:2px 0;">${esc(l)}</li>`).join('')}</ul>` : '',
    q.turnaround.trim() ? `<p style="margin:0 0 4px 0;"><b>Turnaround:</b> ${esc(q.turnaround.trim())}</p>` : '',
    q.validity.trim() ? `<p style="margin:0 0 14px 0;"><b>Quote valid for:</b> ${esc(q.validity.trim())}</p>` : '',
    p(q.closing),
    p('Warm regards,'),
  ].join('')
}
