// The client-facing LEADS document — one PDF, every lead itemised.
//
// This is the thing an agency puts in front of the person paying: not agent
// stats, but "here is every lead we delivered this month, and here is exactly
// which ones you are charged for and why the rest are not."
//
// Design rules that follow from that:
//   • every lead appears, billable or not — nothing is quietly dropped, because
//     a client who spots a missing lead stops trusting the whole document
//   • the non-billable rows carry the REASON in plain words (a checkout order,
//     or a repeat of a customer already counted)
//   • leads are grouped by site, because a client owns one site and wants their
//     own section to be findable
//   • the customer's own enquiry text is included for quote leads — that is the
//     part that makes a lead feel real rather than a number in a table

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { formatDateTime, formatShortDateTime } from './datetime'
import type { ReportData, LeadDetail } from './report'

const A4 = { w: 841.89, h: 595.28 } // landscape — the lead table is wide
const MARGIN = 32
const INK = rgb(0.10, 0.12, 0.16)
const MUTED = rgb(0.45, 0.50, 0.58)
const RULE = rgb(0.86, 0.88, 0.91)
const BAND = rgb(0.96, 0.97, 0.98)
const ACCENT = rgb(0.15, 0.39, 0.92)
const GREEN = rgb(0.09, 0.55, 0.31)

interface Ctx { doc: PDFDocument; font: PDFFont; bold: PDFFont; pages: PDFPage[]; page: PDFPage; y: number }

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([A4.w, A4.h])
  ctx.pages.push(ctx.page)
  ctx.y = A4.h - MARGIN
}
function text(ctx: Ctx, s: string, x: number, y: number, size: number, font = ctx.font, color = INK) {
  ctx.page.drawText(s, { x, y, size, font, color })
}
function fit(s: string, font: PDFFont, size: number, width: number): string {
  if (!s) return ''
  // pdf-lib's StandardFonts are WinAnsi — a stray emoji or CJK glyph would throw
  // mid-render, so anything unencodable is replaced rather than risked.
  const safe = s.replace(/[^\x20-\x7E£€–—’‘“”]/g, '')
  if (font.widthOfTextAtSize(safe, size) <= width) return safe
  let cut = safe
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1)
  return `${cut}…`
}

interface Col { label: string; width: number; align?: 'right' | 'center' }

const COLS: Col[] = [
  { label: '#', width: 26, align: 'right' },
  { label: 'Date (PKT)', width: 86 },
  { label: 'Customer', width: 132 },
  { label: 'Email', width: 176 },
  { label: 'Phone', width: 88 },
  { label: 'Source', width: 54 },
  { label: 'Billable', width: 48, align: 'center' },
  { label: 'Note', width: 168 },
]

export async function buildLeadsPdf(d: ReportData, opts: { siteId?: string } = {}): Promise<Uint8Array> {
  const leads = opts.siteId ? d.leadDetail.filter((l) => l.siteId === opts.siteId) : d.leadDetail
  const siteLabel = opts.siteId
    ? (d.sites.find((s) => s.siteId === opts.siteId)?.siteName ?? opts.siteId)
    : null

  const doc = await PDFDocument.create()
  doc.setTitle(`Leads delivered — ${siteLabel ?? d.workspaceLabel}, ${d.periodLabel}`)
  doc.setAuthor(d.workspaceLabel)
  doc.setSubject(`Lead report for ${d.periodLabel}`)
  doc.setCreator('ZeeOps')

  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ctx: Ctx = { doc, font, bold, pages: [], page: null as unknown as PDFPage, y: 0 }
  newPage(ctx)

  const billable = leads.filter((l) => l.billable).length
  const checkout = leads.filter((l) => l.source === 'checkout').length
  const dupes = leads.filter((l) => l.reason === 'duplicate of an earlier lead').length
  const chat = leads.filter((l) => l.source === 'chat').length
  const quote = leads.filter((l) => l.source === 'quote').length

  // ── header ─────────────────────────────────────────────────────────────────
  ctx.page.drawRectangle({ x: 0, y: A4.h - 78, width: A4.w, height: 78, color: rgb(0.99, 0.99, 1) })
  ctx.page.drawRectangle({ x: 0, y: A4.h - 81, width: A4.w, height: 3, color: ACCENT })
  text(ctx, siteLabel ?? d.workspaceLabel, MARGIN, A4.h - 34, 18, bold)
  text(ctx, 'Leads delivered', MARGIN, A4.h - 51, 10, font, MUTED)
  const pw = bold.widthOfTextAtSize(d.periodLabel, 14)
  text(ctx, d.periodLabel, A4.w - MARGIN - pw, A4.h - 34, 14, bold)
  const stamp = `Prepared ${formatDateTime(d.generatedAt)} PKT`
  text(ctx, stamp, A4.w - MARGIN - font.widthOfTextAtSize(stamp, 7.5), A4.h - 51, 7.5, font, MUTED)
  ctx.y = A4.h - 100

  // ── the headline: what is being charged ────────────────────────────────────
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 44, width: A4.w - MARGIN * 2, height: 56, color: BAND })
  const tiles: [string, string, boolean][] = [
    ['Total leads', String(leads.length), false],
    ['Billable', String(billable), true],
    ['From chat', String(chat), false],
    ['From quote form', String(quote), false],
    ['Checkout orders', String(checkout), false],
    ['Repeat customers', String(dupes), false],
  ]
  const tw = (A4.w - MARGIN * 2) / tiles.length
  tiles.forEach(([label, value, hero], i) => {
    const x = MARGIN + i * tw
    text(ctx, label.toUpperCase(), x + 8, ctx.y - 4, 6.5, bold, MUTED)
    text(ctx, value, x + 8, ctx.y - 30, hero ? 22 : 18, bold, hero ? GREEN : INK)
    if (i > 0) ctx.page.drawLine({ start: { x, y: ctx.y - 44 }, end: { x, y: ctx.y + 12 }, thickness: 0.4, color: RULE })
  })
  ctx.y -= 60

  text(ctx, `You are charged for ${billable} lead${billable === 1 ? '' : 's'}.`, MARGIN, ctx.y, 9.5, bold)
  ctx.y -= 12
  // Wrapped, not drawn as one long line — pdf-lib does not wrap, so a single
  // drawText would simply run off the right edge of the page.
  for (const line of wrap('Every lead captured in the period is listed below, including the ones you are NOT charged for. '
    + 'Checkout orders are completed sales, not leads we generated. A repeat customer is someone who already '
    + 'appears earlier in this list, so they are only ever counted once.', font, 7.5, A4.w - MARGIN * 2)) {
    text(ctx, line, MARGIN, ctx.y, 7.5, font, MUTED)
    ctx.y -= 9.5
  }
  ctx.y -= 8

  // ── per-site summary, when the document covers more than one site ──────────
  if (!opts.siteId) {
    const bySite = new Map<string, { total: number; billable: number }>()
    for (const l of leads) {
      const e = bySite.get(l.siteName) ?? { total: 0, billable: 0 }
      e.total++
      if (l.billable) e.billable++
      bySite.set(l.siteName, e)
    }
    const ranked = Array.from(bySite.entries()).sort((a, b) => b[1].billable - a[1].billable)
    text(ctx, 'Leads by site', MARGIN, ctx.y, 10.5, bold)
    ctx.y -= 14
    const cols: Col[] = [{ label: 'Site', width: 300 }, { label: 'Total leads', width: 90, align: 'right' }, { label: 'Billable', width: 90, align: 'right' }]
    drawHeader(ctx, cols)
    for (const [name, v] of ranked) {
      if (ctx.y - 12 < MARGIN + 26) { newPage(ctx); drawHeader(ctx, cols) }
      drawRow(ctx, cols, [name, String(v.total), String(v.billable)])
    }
    drawTotal(ctx, cols, ['TOTAL', String(leads.length), String(billable)])
    ctx.y -= 14
  }

  // ── the itemised list ──────────────────────────────────────────────────────
  text(ctx, opts.siteId ? 'Every lead' : 'Every lead, newest first', MARGIN, ctx.y, 10.5, bold)
  ctx.y -= 14
  drawHeader(ctx, COLS)

  if (leads.length === 0) {
    text(ctx, 'No leads were captured in this period.', MARGIN + 3, ctx.y, 8, font, MUTED)
    ctx.y -= 14
  }

  // Numbered oldest-first so #1 is the first lead of the month, which is how a
  // client counts them, while the list itself reads newest-first.
  const total = leads.length
  leads.forEach((l, i) => {
    if (ctx.y - 13 < MARGIN + 26) { newPage(ctx); drawHeader(ctx, COLS) }
    drawLeadRow(ctx, l, total - i)
  })

  drawTotal(ctx, COLS, ['', '', `${leads.length} leads`, '', '', '', String(billable), 'billable'])

  // ── enquiries: the customers' own words ────────────────────────────────────
  const withText = leads
    .map((l) => ({ ...l, enquiry: l.enquiry ? cleanEnquiry(l.enquiry) : null }))
    .filter((l) => l.enquiry && l.enquiry.length > 12)
  if (withText.length > 0) {
    ctx.y -= 16
    if (ctx.y < MARGIN + 90) newPage(ctx)
    text(ctx, 'What these customers asked for', MARGIN, ctx.y, 10.5, bold)
    ctx.y -= 10
    text(ctx, 'Taken from the enquiry each customer submitted, so you can see the intent behind the numbers.',
      MARGIN, ctx.y, 7.5, font, MUTED)
    ctx.y -= 14

    for (const l of withText) {
      if (ctx.y - 30 < MARGIN + 26) newPage(ctx)
      const who = [cleanName(l.name), l.email].filter(Boolean).join(' · ')
      text(ctx, fit(`${who}  —  ${l.siteName}  ·  ${formatShortDateTime(l.capturedAt)}`, bold, 7.5, A4.w - MARGIN * 2), MARGIN, ctx.y, 7.5, bold)
      ctx.y -= 10
      // Wrap the enquiry to the page width rather than truncating it — the
      // detail is the point of this section.
      for (const line of wrap(l.enquiry ?? '', font, 7.5, A4.w - MARGIN * 2 - 8).slice(0, 4)) {
        if (ctx.y - 10 < MARGIN + 26) newPage(ctx)
        text(ctx, line, MARGIN + 8, ctx.y, 7.5, font, INK)
        ctx.y -= 9
      }
      ctx.y -= 5
      ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y + 2 }, end: { x: A4.w - MARGIN, y: ctx.y + 2 }, thickness: 0.3, color: RULE })
      ctx.y -= 5
    }
  }

  // ── footer ─────────────────────────────────────────────────────────────────
  ctx.pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${ctx.pages.length}`
    p.drawText(label, { x: A4.w - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN - 14, size: 7.5, font, color: MUTED })
    p.drawText(`${siteLabel ?? d.workspaceLabel} · Leads delivered · ${d.periodLabel}`,
      { x: MARGIN, y: MARGIN - 14, size: 7.5, font, color: MUTED })
  })

  return doc.save()
}

// ── drawing helpers ──────────────────────────────────────────────────────────
function drawHeader(ctx: Ctx, cols: Col[]) {
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 4, width: A4.w - MARGIN * 2, height: 15, color: BAND })
  let x = MARGIN
  for (const c of cols) {
    const label = fit(c.label, ctx.bold, 7, c.width - 6)
    const w = ctx.bold.widthOfTextAtSize(label, 7)
    const tx = c.align === 'right' ? x + c.width - 4 - w : c.align === 'center' ? x + (c.width - w) / 2 : x + 3
    ctx.page.drawText(label, { x: tx, y: ctx.y, size: 7, font: ctx.bold, color: MUTED })
    x += c.width
  }
  ctx.y -= 14
}

function drawRow(ctx: Ctx, cols: Col[], cells: string[]) {
  let x = MARGIN
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]
    const v = fit(cells[i] ?? '', ctx.font, 7.5, c.width - 6)
    const w = ctx.font.widthOfTextAtSize(v, 7.5)
    const tx = c.align === 'right' ? x + c.width - 4 - w : c.align === 'center' ? x + (c.width - w) / 2 : x + 3
    ctx.page.drawText(v, { x: tx, y: ctx.y, size: 7.5, font: ctx.font, color: INK })
    x += c.width
  }
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: A4.w - MARGIN, y: ctx.y - 4 }, thickness: 0.3, color: RULE })
  ctx.y -= 13
}

function drawLeadRow(ctx: Ctx, l: LeadDetail, index: number) {
  const cells = [
    String(index),
    formatShortDateTime(l.capturedAt),
    cleanName(l.name) ?? '—',
    l.email ?? '—',
    l.phone ?? '—',
    l.source === 'quote' ? 'Quote form' : l.source === 'checkout' ? 'Checkout' : 'Chat',
    l.billable ? 'Yes' : 'No',
    l.reason ? l.reason.charAt(0).toUpperCase() + l.reason.slice(1) : '',
  ]
  let x = MARGIN
  for (let i = 0; i < COLS.length; i++) {
    const c = COLS[i]
    const isBillableCol = i === 6
    const f = isBillableCol ? ctx.bold : ctx.font
    const v = fit(cells[i] ?? '', f, 7.5, c.width - 6)
    const w = f.widthOfTextAtSize(v, 7.5)
    const tx = c.align === 'right' ? x + c.width - 4 - w : c.align === 'center' ? x + (c.width - w) / 2 : x + 3
    ctx.page.drawText(v, {
      x: tx, y: ctx.y, size: 7.5, font: f,
      color: isBillableCol ? (l.billable ? GREEN : MUTED) : i === 7 ? MUTED : INK,
    })
    x += c.width
  }
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y - 4 }, end: { x: A4.w - MARGIN, y: ctx.y - 4 }, thickness: 0.3, color: RULE })
  ctx.y -= 13
}

function drawTotal(ctx: Ctx, cols: Col[], cells: string[]) {
  if (ctx.y - 16 < MARGIN + 26) { newPage(ctx); drawHeader(ctx, cols) }
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 4, width: A4.w - MARGIN * 2, height: 15, color: BAND })
  let x = MARGIN
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i]
    const v = fit(cells[i] ?? '', ctx.bold, 7.5, c.width - 6)
    const w = ctx.bold.widthOfTextAtSize(v, 7.5)
    const tx = c.align === 'right' ? x + c.width - 4 - w : c.align === 'center' ? x + (c.width - w) / 2 : x + 3
    ctx.page.drawText(v, { x: tx, y: ctx.y, size: 7.5, font: ctx.bold, color: INK })
    x += c.width
  }
  ctx.y -= 16
}

// The enquiry text is a forwarded form email, so it arrives wrapped in machinery
// the client should never have to read: inline-image placeholders, the user
// agent, the "respond within 2 hours" instruction meant for us, and a copyright
// footer. Stripping them leaves the part that matters — what the customer
// actually asked for. Display only; the stored lead is untouched.
export function cleanEnquiry(s: string): string {
  return s
    .replace(/\[image:[^\]]*\]/gi, ' ')
    .replace(/\*?ACTION REQUIRED:?\*?[^.]*\./gi, ' ')
    .replace(/This is an automated notification[^.]*\./gi, ' ')
    .replace(/(?:©|\(c\)|\b)\s*20\d{2}[^.]{0,60}All rights reserved\.?/gi, ' ')
    .replace(/User Agent:\s*\S.*?(?=(?:Timestamp|Page URL|Wall Type|Quantity|Accessories|REQUEST DETAILS|PRODUCT DETAILS|CUSTOMER|$))/gi, ' ')
    .replace(/CUSTOMER CONTACT INFORMATION\b/gi, ' ')
    .replace(/\b(?:REQUEST|PRODUCT) DETAILS\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Names occasionally arrive carrying the same email artefacts. */
export function cleanName(s: string | null): string | null {
  if (!s) return s
  const out = s.replace(/\[image:[^\]]*\]/gi, ' ').replace(/\s{2,}/g, ' ').trim()
  return out || null
}

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const words = s.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const safe = w.replace(/[^\x20-\x7E£€–—’‘“”]/g, '')
    if (!safe) continue
    const next = line ? `${line} ${safe}` : safe
    if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = safe }
    else line = next
  }
  if (line) lines.push(line)
  return lines
}
