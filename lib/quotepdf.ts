// The price quote as a PDF, drawn to match the team's own sample (Shazzy,
// 2026-10-22: "Price Quotation - Hanna Ownen (Small Food Boxes)"): logo and
// PRICE QUOTATION header, customer + summary boxes, one itemized table for
// every product, the total, included services and terms. Built from the same
// PriceQuote the email uses, so the attachment and the email cannot disagree.
// pdf-lib + standard Helvetica, like lib/invoicepdf.ts — the same Latin-1 rule.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib'
import { cleanRows, filledItems, orderTotals, type PriceQuote } from './pricequote'
import { dateLabel, sitePrefix, initials } from './invoicedoc'

const INK = rgb(0.11, 0.13, 0.17)
const GREY = rgb(0.42, 0.45, 0.5)
const LINE = rgb(0.86, 0.88, 0.91)
const PANEL = rgb(0.973, 0.976, 0.984)
const WHITE = rgb(1, 1, 1)
const W = 612, H = 792, L = 48, R = 564

function safe(s: string): string {
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, '-')
    .replace(/•/g, '-').replace(/×/g, 'x').replace(/…/g, '...').replace(/✓/g, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')
}

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  for (const para of safe(s).split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next
      else { out.push(line); line = word }
    }
    if (line) out.push(line)
  }
  return out
}

const SYMBOL: Record<string, string> = { USD: '$', CAD: 'CA$', AUD: 'A$', GBP: '£', EUR: '€' }
const sym = (c: string) => SYMBOL[c] ?? `${c} `
const money = (v: number, c: string) => sym(c) + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const unitLabel = (raw: string, v: number, c: string) => {
  const typed = (String(raw).split('.')[1] ?? '').replace(/\D/g, '').length
  const d = Math.min(4, Math.max(v < 1 ? 3 : 2, typed))
  return sym(c) + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** SFB-2026-1022-HO: the site's initials, the date, the customer's initials. */
export function quoteNumber(siteName: string, customerName: string, dayKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  const d = m ? `${m[1]}-${m[2]}${m[3]}` : ''
  return [sitePrefix(siteName), d, initials(customerName || '')].filter(Boolean).join('-')
}

/** "Price Quotation - Hanna Ownen (Small Food Boxes).pdf" */
export function quoteFileName(customerName: string, siteName: string): string {
  const n = `Price Quotation - ${customerName || 'Customer'} (${siteName})`.replace(/[^\w .()&-]/g, '').replace(/\s+/g, ' ').trim()
  return `${n}.pdf`
}

export interface QuotePdfOptions {
  logo?: Uint8Array | null
  siteName: string
  customerName: string
  customerEmail: string
  /** YYYY-MM-DD, Karachi day. */
  dayKey: string
  number?: string
  accent?: RGB
}

export async function buildQuotePdf(q: PriceQuote, o: QuotePdfOptions): Promise<Uint8Array> {
  const ACC = o.accent ?? rgb(0.13, 0.2, 0.33)
  const ACC_SOFT = rgb(0.93 + (ACC.red - 0.13) * 0.05, 0.95, 0.97)
  const cur = q.currency || 'USD'
  const number = o.number || quoteNumber(o.siteName, o.customerName, o.dayKey)
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Price Quotation ${number}`)
  pdf.setAuthor(o.siteName)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const pages: PDFPage[] = []
  let page: PDFPage = pdf.addPage([W, H]); pages.push(page)
  const t = (s: string, x: number, y: number, size: number, f = font, color = INK) => page.drawText(safe(s), { x, y, size, font: f, color })
  const tr = (s: string, right: number, y: number, size: number, f = font, color = INK) => t(s, right - f.widthOfTextAtSize(safe(s), size), y, size, f, color)
  const box = (x: number, y: number, w: number, h: number, fill: RGB, border?: RGB) =>
    page.drawRectangle({ x, y, width: w, height: h, color: fill, ...(border ? { borderColor: border, borderWidth: 0.8 } : {}) })

  // ── header: logo left, PRICE QUOTATION right ─────────────────────────────
  let img: PDFImage | null = null
  if (o.logo && o.logo.length > 8) {
    try {
      const b = o.logo
      img = b[0] === 0x89 && b[1] === 0x50 ? await pdf.embedPng(b) : (b[0] === 0xff && b[1] === 0xd8 ? await pdf.embedJpg(b) : null)
    } catch { img = null }
  }
  if (img) {
    const s = Math.min(170 / img.width, 70 / img.height)
    page.drawImage(img, { x: L, y: H - 40 - img.height * s, width: img.width * s, height: img.height * s })
  } else {
    t(o.siteName, L, H - 78, 20, bold, ACC)
  }
  tr('PRICE QUOTATION', R, H - 72, 22, bold)
  const meta = (k: string, v: string, y: number) => { const vw = font.widthOfTextAtSize(safe(v), 9.5); tr(v, R, y, 9.5, font, GREY); tr(k, R - vw - 4, y, 9.5, bold, GREY) }
  meta('Quote #:', number, H - 90)
  meta('Date:', dateLabel(o.dayKey), H - 104)
  page.drawRectangle({ x: L, y: H - 130, width: R - L, height: 2, color: ACC })

  // ── customer details / quote summary ─────────────────────────────────────
  const items = filledItems(q)
  const cardTop = H - 148, cardH = 70, gap = 14, cw = (R - L - gap) / 2
  const card = (x: number, title: string, rows: [string, string, RGB?][]) => {
    box(x, cardTop - cardH, cw, cardH, PANEL, LINE)
    t(title, x + 12, cardTop - 20, 10, bold, ACC)
    page.drawLine({ start: { x: x + 12, y: cardTop - 27 }, end: { x: x + cw - 12, y: cardTop - 27 }, thickness: 0.8, color: LINE })
    rows.forEach(([k, v, c], i) => {
      const y = cardTop - 43 - i * 15
      t(k, x + 12, y, 9.5, font, GREY)
      const lines = wrap(v, bold, 9.5, cw - 108)
      t(lines[0] ?? '', x + 96, y, 9.5, bold, c ?? INK)
    })
  }
  const custRows: [string, string][] = [['Name:', o.customerName || '-']]
  if (o.customerEmail) custRows.push(['Email:', o.customerEmail])
  card(L, 'CUSTOMER DETAILS', custRows)
  card(L + cw + gap, 'QUOTE SUMMARY', [['Total Items:', `${items.length} Product${items.length === 1 ? '' : 's'}`], ['Status:', 'Active Quote', ACC]])

  // ── itemized table ───────────────────────────────────────────────────────
  let y = cardTop - cardH - 30
  page.drawRectangle({ x: L, y: y - 3, width: 3, height: 15, color: ACC })
  t('CUSTOM PACKAGING ITEMIZED PROPOSAL', L + 10, y, 11, bold)
  y -= 18
  const COL_Q = 330, COL_U = 425, DESC_W = COL_Q - L - 24
  const head = () => {
    box(L, y - 22, R - L, 22, ACC)
    t('ITEM DESCRIPTION & SPECIFICATIONS', L + 10, y - 14.5, 8.5, bold, WHITE)
    t('QUANTITY', COL_Q, y - 14.5, 8.5, bold, WHITE)
    t('UNIT PRICE', COL_U, y - 14.5, 8.5, bold, WHITE)
    tr('TOTAL AMOUNT', R - 10, y - 14.5, 8.5, bold, WHITE)
    y -= 22
  }
  const newPage = () => { page = pdf.addPage([W, H]); pages.push(page); y = H - 50 }
  head()
  let stripe = 0
  items.forEach((it, n) => {
    const rows = cleanRows(it)
    const name = wrap(`${n + 1}. ${it.product.trim()}${(it.option ?? '').trim() ? ` (${(it.option ?? '').trim()})` : ''}`, bold, 9.5, DESC_W)
    const specs = wrap(it.specs.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' | '), font, 8.5, DESC_W)
    const textH = name.length * 12 + specs.length * 11
    const rowsH = rows.length * 15
    const h = Math.max(textH, rowsH) + 18
    if (y - h < 90) { newPage(); head() }
    box(L, y - h, R - L, h, stripe++ % 2 ? PANEL : WHITE)
    page.drawLine({ start: { x: L, y: y - h }, end: { x: R, y: y - h }, thickness: 0.6, color: LINE })
    let ty = y - 16
    for (const ln of name) { t(ln, L + 10, ty, 9.5, bold); ty -= 12 }
    for (const ln of specs) { t(ln, L + 10, ty, 8.5, font, GREY); ty -= 11 }
    const raw = it.rows.filter((r) => Number(String(r.quantity).replace(/[^0-9.]/g, '')) > 0 && Number(String(r.unitPrice).replace(/[^0-9.]/g, '')) > 0)
    rows.forEach((r, i) => {
      const ry = y - 16 - i * 15
      t(`${r.qty.toLocaleString('en-US')} units`, COL_Q, ry, 9.5)
      t(`${unitLabel(raw[i]?.unitPrice ?? '', r.unit, cur)} / unit`, COL_U, ry, 9.5)
      tr(money(r.total, cur), R - 10, ry, 9.5, bold, ACC)
    })
    y -= h
  })

  // ── total ────────────────────────────────────────────────────────────────
  let totals = orderTotals(q)
  if (!totals.length && q.showTotal !== false && items.length === 1 && cleanRows(items[0]).length === 1) totals = [{ label: '', count: 1, total: cleanRows(items[0])[0].total }]
  if (y < 230) newPage()
  page.drawRectangle({ x: L, y: y - 2, width: R - L, height: 2, color: ACC })
  if (totals.length) {
    for (const tt of totals) {
      box(L, y - 32, R - L, 30, ACC_SOFT)
      const lab = tt.label ? `TOTAL - ${tt.label.toUpperCase()}:` : 'TOTAL QUOTATION AMOUNT:'
      tr(lab.length > 60 ? lab.slice(0, 57) + '...:' : lab, 445, y - 21, 10.5, bold, ACC)
      tr(money(tt.total, cur), R - 10, y - 21, 11, bold, ACC)
      y -= 32
    }
  } else if (q.showTotal === false) {
    y -= 2
  } else {
    box(L, y - 30, R - L, 28, ACC_SOFT)
    t('Each quantity above is a separate option - choose the one that suits you best.', L + 10, y - 19, 9, font, ACC)
    y -= 30
  }

  // ── included services ────────────────────────────────────────────────────
  const inc = q.included.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (q.turnaround.trim()) inc.push(`Turnaround: ${q.turnaround.trim()}`)
  if (inc.length) {
    const colW = (R - L - 24) / 3
    const cells = inc.map((s) => wrap(s, font, 9, colW - 22))
    const lineRows: string[][][] = []
    for (let i = 0; i < cells.length; i += 3) lineRows.push(cells.slice(i, i + 3))
    const rowH = lineRows.map((r) => Math.max(...r.map((c) => c.length)) * 11 + 10)
    const h = 34 + rowH.reduce((a, b) => a + b, 0)
    y -= 18
    if (y - h < 60) newPage()
    box(L, y - h, R - L, h, ACC_SOFT, LINE)
    t('INCLUDED SERVICES & VALUE GUARANTEES', L + 12, y - 18, 9.5, bold, ACC)
    let ry = y - 36
    lineRows.forEach((r, ri) => {
      r.forEach((c, ci) => {
        const x = L + 12 + ci * colW
        page.drawCircle({ x: x + 6, y: ry - 2 + (c.length > 1 ? 0 : 0), size: 6, color: ACC })
        page.drawLine({ start: { x: x + 3, y: ry - 2 }, end: { x: x + 5.3, y: ry - 4.5 }, thickness: 1.3, color: WHITE })
        page.drawLine({ start: { x: x + 5.3, y: ry - 4.5 }, end: { x: x + 9.2, y: ry + 0.8 }, thickness: 1.3, color: WHITE })
        c.forEach((ln, li) => t(ln, x + 17, ry - 5 - li * 11, 9))
      })
      ry -= rowH[ri]
    })
    y -= h
  }

  // ── terms ────────────────────────────────────────────────────────────────
  const terms = [
    'Please carefully review the item specifications above. Production begins as soon as the final artwork is approved',
    q.turnaround.trim() ? `, and delivery is estimated at ${q.turnaround.trim()}.` : '.',
    q.validity.trim() ? ` This quote is valid for ${q.validity.trim()}.` : '',
  ].join('')
  const tl = wrap(`Terms & Instructions: ${terms}`, font, 8.5, R - L - 28)
  const th = tl.length * 11.5 + 18
  y -= 14
  if (y - th < 50) newPage()
  box(L, y - th, R - L, th, PANEL)
  page.drawRectangle({ x: L, y: y - th, width: 3, height: th, color: LINE })
  tl.forEach((ln, i) => {
    const yy = y - 15 - i * 11.5
    if (i === 0 && ln.startsWith('Terms & Instructions:')) {
      t('Terms & Instructions:', L + 14, yy, 8.5, bold, GREY)
      t(ln.slice('Terms & Instructions:'.length), L + 14 + bold.widthOfTextAtSize('Terms & Instructions:', 8.5), yy, 8.5, font, GREY)
    } else t(ln, L + 14, yy, 8.5, font, GREY)
  })

  // ── footer on every page ─────────────────────────────────────────────────
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: L, y: 46 }, end: { x: R, y: 46 }, thickness: 0.6, color: LINE })
    p.drawText(safe(`${o.siteName} - Custom Packaging Solutions`), { x: L, y: 30, size: 8.5, font, color: GREY })
    const s = `Page ${i + 1} of ${pages.length}`
    p.drawText(s, { x: R - font.widthOfTextAtSize(s, 8.5), y: 30, size: 8.5, font, color: GREY })
  })
  return pdf.save()
}
