// The invoice as a PDF, drawn to match the team's samples (TPC-017 et al.).
// pdf-lib with the standard Helvetica fonts, like lib/leadspdf.ts — so the
// same WinAnsi rule applies: anything outside Latin-1 is swapped or dropped
// rather than allowed to throw halfway through a customer's invoice.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
import { dateLabel, money, rateLabel, lineCents, shipParty, totals, num, type InvoiceDoc, type InvoiceParty } from './invoicedoc'

const INK = rgb(0.2, 0.2, 0.2)
const GREY = rgb(0.47, 0.47, 0.47)
const BAR = rgb(0.23, 0.23, 0.23)
const SHADE = rgb(0.955, 0.955, 0.955)
const W = 612, H = 792, L = 48, R = 564

function safe(s: string): string {
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, '-')
    .replace(/•/g, '-').replace(/×/g, 'x').replace(/…/g, '...')
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
    out.push(line)
  }
  return out
}

export async function buildInvoicePdf(doc: InvoiceDoc, opts: { logo?: Uint8Array | null; siteName: string }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Invoice ${doc.number}`)
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  let page: PDFPage = pdf.addPage([W, H])
  const t = (s: string, x: number, y: number, size: number, f = font, color = INK) =>
    page.drawText(safe(s), { x, y, size, font: f, color })
  const tr = (s: string, right: number, y: number, size: number, f = font, color = INK) =>
    t(s, right - f.widthOfTextAtSize(safe(s), size), y, size, f, color)

  // ── header ────────────────────────────────────────────────────────────────
  let img: PDFImage | null = null
  if (opts.logo && opts.logo.length > 8) {
    try {
      const b = opts.logo
      img = b[0] === 0x89 && b[1] === 0x50 ? await pdf.embedPng(b) : (b[0] === 0xff && b[1] === 0xd8 ? await pdf.embedJpg(b) : null)
    } catch { img = null }
  }
  if (img) {
    const s = Math.min(170 / img.width, 48 / img.height)
    page.drawImage(img, { x: L - 6, y: H - 44 - img.height * s, width: img.width * s, height: img.height * s })
  } else {
    t(opts.siteName, L, H - 70, 16, bold)
  }
  tr('INVOICE', R, H - 78, 34, font, INK)
  tr(`# ${doc.number}`, R, H - 100, 13, font, GREY)
  t(doc.agentName, L + 6, H - 120, 10.5, bold)

  // ── bill to / ship to ─────────────────────────────────────────────────────
  const partyBlock = (label: string, p: InvoiceParty, x: number, width: number): number => {
    let y = H - 175
    t(label, x, y, 10, font, GREY); y -= 15
    for (const ln of wrap(p.name, bold, 10.5, width)) { t(ln, x, y, 10.5, bold); y -= 13.5 }
    for (const src of [p.company, p.address, p.phone]) {
      if (!src.trim()) continue
      for (const ln of wrap(src, font, 10.5, width)) { t(ln, x, y, 10.5); y -= 13.5 }
    }
    return y
  }
  const leftEnd = Math.min(partyBlock('Bill To:', doc.billTo, L + 6, 140), partyBlock('Ship To:', shipParty(doc), L + 148, 140))

  // ── date / terms / PO / balance due ───────────────────────────────────────
  const { subtotal, tax, total } = totals(doc)
  let y = H - 175
  const row = (k: string, v: string) => { tr(k, 450, y, 10.5, font, GREY); tr(v, R - 10, y, 10.5); y -= 24 }
  row('Date:', dateLabel(doc.date))
  row('Payment Terms:', doc.paymentTerms)
  row('Due Date:', dateLabel(doc.dueDate || doc.date))
  if (doc.poNumber) row('PO Number:', doc.poNumber)
  page.drawRectangle({ x: 318, y: y - 9, width: R - 318 + 6, height: 28, color: SHADE })
  tr('Balance Due:', 450, y, 12, bold); tr(money(total, doc.currency), R - 10, y, 12, bold)
  const rightEnd = y - 20

  // ── items ─────────────────────────────────────────────────────────────────
  y = Math.min(leftEnd, rightEnd) - 26
  const header = () => {
    page.drawRectangle({ x: L - 8, y: y - 7, width: R - L + 16, height: 22, color: BAR })
    t('Item', L + 6, y, 10.5, font, rgb(1, 1, 1))
    t('Quantity', 380, y, 10.5, font, rgb(1, 1, 1))
    tr('Rate', 482, y, 10.5, font, rgb(1, 1, 1))
    tr('Amount', R - 10, y, 10.5, font, rgb(1, 1, 1))
    y -= 30
  }
  header()
  for (const it of doc.items) {
    if (!it.name.trim() && !num(it.quantity) && !num(it.rate)) continue
    const nameLines = wrap(it.name, bold, 10.5, 300)
    const detailLines = it.details.trim() ? wrap(it.details, font, 10, 300) : []
    const need = (nameLines.length + detailLines.length) * 15 + 12
    if (y - need < 60) { page = pdf.addPage([W, H]); y = H - 60; header() }
    t(it.quantity, 380, y, 10.5)
    tr(rateLabel(it.rate, doc.currency), 482, y, 10.5)
    tr(money(lineCents(it) / 100, doc.currency), R - 10, y, 10.5)
    for (const ln of nameLines) { t(ln, L + 6, y, 10.5, bold); y -= 15 }
    for (const ln of detailLines) { t(ln, L + 6, y, 10, font, GREY); y -= 15 }
    y -= 12
  }

  // ── totals ────────────────────────────────────────────────────────────────
  if (y < 150) { page = pdf.addPage([W, H]); y = H - 60 }
  y -= 28
  const tot = (k: string, v: string) => { tr(k, 450, y, 10.5, font, GREY); tr(v, R - 10, y, 10.5); y -= 21 }
  tot('Subtotal:', money(subtotal, doc.currency))
  tot(`Tax (${num(doc.taxPercent)}%):`, money(tax, doc.currency))
  tot('Total:', money(total, doc.currency))

  // ── notes / terms ─────────────────────────────────────────────────────────
  y -= 26
  const block = (label: string, body: string) => {
    if (!body.trim()) return
    const lines = wrap(body, font, 10.5, R - L - 10)
    if (y - (lines.length + 2) * 14 < 40) { page = pdf.addPage([W, H]); y = H - 60 }
    t(label, L + 6, y, 10, font, GREY); y -= 16
    for (const ln of lines) { t(ln, L + 6, y, 10.5); y -= 14.5 }
    y -= 14
  }
  block('Notes:', doc.notes)
  block('Terms:', doc.terms)

  return pdf.save()
}
