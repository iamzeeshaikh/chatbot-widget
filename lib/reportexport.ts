// Report exports: CSV per breakdown, and a presentable PDF.
//
// The PDF is drawn with pdf-lib — pure JavaScript, no headless browser, so it
// runs in a Vercel serverless function. It is a designed document, not a
// screenshot of the UI: cover header, summary block, then the three tables with
// repeating column headers, page numbers and a generated-on PKT stamp.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { formatDateTime } from './datetime'
import { pct, durationLabel, type ReportData, type Metrics } from './report'

// ── CSV ──────────────────────────────────────────────────────────────────────
// Excel only respects UTF-8 in a CSV when the file opens with a BOM; without it
// a name like "Zeeshan Ahmed – Packaging" arrives mojibaked.
const BOM = '﻿'

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // Quote when the value contains a delimiter, a quote or a newline; double up
  // embedded quotes. A leading =, +, - or @ is prefixed with a tab so Excel
  // treats it as text rather than a formula.
  const risky = /^[=+\-@]/.test(s)
  const body = risky ? `\t${s}` : s
  return /[",\r\n]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const lines = [headers.map(cell).join(',')]
  for (const r of rows) lines.push(r.map(cell).join(','))
  // CRLF: the line ending Excel expects on every platform.
  return BOM + lines.join('\r\n') + '\r\n'
}

const rate = (v: number | null) => (v === null ? '' : (v * 100).toFixed(1))
const ms = (v: number | null) => (v === null ? '' : Math.round(v / 1000))

/** Raw numbers, not the display strings — these are meant to be re-summed. */
export function agentsCsv(d: ReportData): string {
  return toCsv(
    ['Agent', 'Chats handled', 'Replies', 'Leads credited', 'Avg response (s)', 'Slow replies', 'Measured replies', 'Active'],
    [
      ...d.agents.map((a) => [a.email, a.chats, a.replies, a.leads, ms(a.avgResponseMs), a.slowReplies, a.measuredReplies, a.active ? 'yes' : 'no']),
      ['TOTAL', d.agentTotals.chats, d.agentTotals.replies, d.agentTotals.leads, '', d.agentTotals.slowReplies, d.agentTotals.measuredReplies, ''],
    ],
  )
}

const metricCells = (m: Metrics) => [
  m.clicks, m.chats, m.picked, m.notPicked, m.leads, m.checkout, m.billable,
  rate(m.conversionRate), rate(m.pickupRate), ms(m.avgResponseMs),
]
const METRIC_HEADERS = ['Clicks', 'Chats', 'Picked up', 'Not picked', 'Leads', 'Checkout', 'Billable',
  'Conversion %', 'Pickup %', 'Avg response (s)']

export function sitesCsv(d: ReportData): string {
  return toCsv(
    ['Site', ...METRIC_HEADERS],
    [
      ...d.sites.map((s) => [s.siteName, ...metricCells(s)]),
      ['TOTAL', ...metricCells(d.totals)],
    ],
  )
}

export function dailyCsv(d: ReportData): string {
  return toCsv(
    ['Date (PKT)', ...METRIC_HEADERS],
    [
      ...d.days.map((x) => [x.date, ...metricCells(x)]),
      ['TOTAL', ...metricCells(d.totals)],
    ],
  )
}

// ── PDF ──────────────────────────────────────────────────────────────────────
const A4 = { w: 841.89, h: 595.28 } // landscape: the tables have ten columns
const MARGIN = 32
const INK = rgb(0.10, 0.12, 0.16)
const MUTED = rgb(0.45, 0.50, 0.58)
const RULE = rgb(0.85, 0.87, 0.90)
const BAND = rgb(0.96, 0.97, 0.98)
const ACCENT = rgb(0.15, 0.39, 0.92)

interface Ctx {
  doc: PDFDocument
  font: PDFFont
  bold: PDFFont
  pages: PDFPage[]
  page: PDFPage
  y: number
  data: ReportData
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([A4.w, A4.h])
  ctx.pages.push(ctx.page)
  ctx.y = A4.h - MARGIN
}

function need(ctx: Ctx, space: number): void {
  if (ctx.y - space < MARGIN + 24) newPage(ctx)
}

function text(ctx: Ctx, s: string, x: number, y: number, size: number, font = ctx.font, color = INK): void {
  ctx.page.drawText(s, { x, y, size, font, color })
}

/** Truncate to fit a column, with an ellipsis — never let text run into its neighbour. */
function fit(s: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(s, size) <= width) return s
  let cut = s
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1)
  return `${cut}…`
}

interface Col { label: string; width: number; align?: 'right' }

function table(ctx: Ctx, title: string, cols: Col[], rows: string[][], totalRow?: string[]): void {
  need(ctx, 90)
  ctx.y -= 6
  text(ctx, title, MARGIN, ctx.y, 11, ctx.bold)
  ctx.y -= 14

  const drawHead = () => {
    let x = MARGIN
    ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 4, width: A4.w - MARGIN * 2, height: 15, color: BAND })
    for (const c of cols) {
      const label = fit(c.label, ctx.bold, 7.5, c.width - 6)
      const tx = c.align === 'right' ? x + c.width - 4 - ctx.bold.widthOfTextAtSize(label, 7.5) : x + 3
      text(ctx, label, tx, ctx.y, 7.5, ctx.bold, MUTED)
      x += c.width
    }
    ctx.y -= 14
  }
  drawHead()

  const line = (cells: string[], bold = false) => {
    const f = bold ? ctx.bold : ctx.font
    let x = MARGIN
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]
      const v = fit(cells[i] ?? '', f, 7.5, c.width - 6)
      const tx = c.align === 'right' ? x + c.width - 4 - f.widthOfTextAtSize(v, 7.5) : x + 3
      text(ctx, v, tx, ctx.y, 7.5, f)
      x += c.width
    }
    ctx.y -= 12
  }

  for (const r of rows) {
    if (ctx.y - 12 < MARGIN + 24) { newPage(ctx); drawHead() }
    line(r)
    ctx.page.drawLine({
      start: { x: MARGIN, y: ctx.y + 8 }, end: { x: A4.w - MARGIN, y: ctx.y + 8 },
      thickness: 0.3, color: RULE,
    })
  }

  if (totalRow) {
    if (ctx.y - 16 < MARGIN + 24) { newPage(ctx); drawHead() }
    ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 3, width: A4.w - MARGIN * 2, height: 14, color: BAND })
    line(totalRow, true)
  }
  ctx.y -= 8
}

export async function buildPdf(d: ReportData): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${d.workspaceLabel} — Performance report, ${d.periodLabel}`)
  doc.setAuthor(d.workspaceLabel)
  doc.setSubject(`Performance report for ${d.periodLabel}`)
  doc.setCreator('ZeeOps')

  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ctx: Ctx = { doc, font, bold, pages: [], page: null as unknown as PDFPage, y: 0, data: d }
  newPage(ctx)

  // ── cover header ───────────────────────────────────────────────────────────
  ctx.page.drawRectangle({ x: 0, y: A4.h - 74, width: A4.w, height: 74, color: rgb(0.99, 0.99, 1) })
  ctx.page.drawRectangle({ x: 0, y: A4.h - 77, width: A4.w, height: 3, color: ACCENT })
  text(ctx, d.workspaceLabel, MARGIN, A4.h - 34, 17, bold)
  text(ctx, 'Performance report', MARGIN, A4.h - 50, 10, font, MUTED)
  const periodW = bold.widthOfTextAtSize(d.periodLabel, 13)
  text(ctx, d.periodLabel, A4.w - MARGIN - periodW, A4.h - 34, 13, bold)
  const stamp = `Generated ${formatDateTime(d.generatedAt)} PKT`
  text(ctx, stamp, A4.w - MARGIN - font.widthOfTextAtSize(stamp, 7.5), A4.h - 50, 7.5, font, MUTED)
  ctx.y = A4.h - 96

  // ── summary block ──────────────────────────────────────────────────────────
  const tiles: [string, string][] = [
    ['Clicks', String(d.totals.clicks)],
    ['Chats', String(d.totals.chats)],
    ['Picked up', String(d.totals.picked)],
    ['Not picked', String(d.totals.notPicked)],
    ['Leads', String(d.totals.leads)],
    ['Checkout', String(d.totals.checkout)],
    ['Billable', String(d.totals.billable)],
    ['Conversion', pct(d.totals.conversionRate)],
    ['Pick-up rate', pct(d.totals.pickupRate)],
    ['Avg response', durationLabel(d.totals.avgResponseMs)],
  ]
  const tileW = (A4.w - MARGIN * 2) / tiles.length
  ctx.page.drawRectangle({ x: MARGIN, y: ctx.y - 34, width: A4.w - MARGIN * 2, height: 44, color: BAND })
  tiles.forEach(([label, value], i) => {
    const x = MARGIN + i * tileW
    text(ctx, label.toUpperCase(), x + 6, ctx.y - 2, 6, bold, MUTED)
    text(ctx, value, x + 6, ctx.y - 22, 14, bold)
    if (i > 0) {
      ctx.page.drawLine({ start: { x, y: ctx.y - 34 }, end: { x, y: ctx.y + 10 }, thickness: 0.4, color: RULE })
    }
  })
  ctx.y -= 52

  text(ctx, 'Billable excludes checkout orders and de-duplicates the same customer across chat and quote. '
    + 'Clicks are widget sessions with automated bursts removed.',
    MARGIN, ctx.y, 7.5, font, MUTED)
  ctx.y -= 10
  // Said plainly because the number invites the wrong reading: leads arrive by
  // email as well as by chat, so this ratio is NOT a chat-to-lead rate.
  text(ctx, 'Conversion is leads ÷ chats. Leads include quote and checkout leads that arrive by email without any chat, '
    + 'so it is not the share of chats that became leads.',
    MARGIN, ctx.y, 7.5, font, MUTED)
  ctx.y -= 14

  // ── tables ─────────────────────────────────────────────────────────────────
  const metricCols = (first: Col): Col[] => [
    first,
    { label: 'Clicks', width: 52, align: 'right' },
    { label: 'Chats', width: 48, align: 'right' },
    { label: 'Picked', width: 48, align: 'right' },
    { label: 'Not picked', width: 58, align: 'right' },
    { label: 'Leads', width: 48, align: 'right' },
    { label: 'Checkout', width: 55, align: 'right' },
    { label: 'Billable', width: 52, align: 'right' },
    { label: 'Conv %', width: 50, align: 'right' },
    { label: 'Pickup %', width: 55, align: 'right' },
    { label: 'Avg resp', width: 55, align: 'right' },
  ]
  const metricRow = (m: Metrics) => [
    String(m.clicks), String(m.chats), String(m.picked), String(m.notPicked),
    String(m.leads), String(m.checkout), String(m.billable),
    pct(m.conversionRate), pct(m.pickupRate), durationLabel(m.avgResponseMs),
  ]

  table(ctx, 'Per agent',
    [
      { label: 'Agent', width: 210 },
      { label: 'Chats handled', width: 78, align: 'right' },
      { label: 'Replies', width: 62, align: 'right' },
      { label: 'Leads', width: 55, align: 'right' },
      { label: 'Avg response', width: 76, align: 'right' },
      { label: 'Slow replies', width: 70, align: 'right' },
      { label: 'Measured', width: 66, align: 'right' },
      { label: 'Active', width: 50, align: 'right' },
    ],
    d.agents.map((a) => [
      a.email, String(a.chats), String(a.replies), String(a.leads),
      durationLabel(a.avgResponseMs), String(a.slowReplies), String(a.measuredReplies), a.active ? 'Yes' : '—',
    ]),
    ['TOTAL', String(d.agentTotals.chats), String(d.agentTotals.replies), String(d.agentTotals.leads),
      '', String(d.agentTotals.slowReplies), String(d.agentTotals.measuredReplies), ''],
  )
  text(ctx, 'A chat replied to by two agents is credited to both, so agent totals can exceed the workspace figure.',
    MARGIN, ctx.y, 7, font, MUTED)
  ctx.y -= 14

  table(ctx, 'Per site', metricCols({ label: 'Site', width: 220 }),
    d.sites.map((s) => [s.siteName, ...metricRow(s)]),
    ['TOTAL', ...metricRow(d.totals)])

  table(ctx, 'Daily trend', metricCols({ label: 'Date (PKT)', width: 220 }),
    d.days.map((x) => [x.date, ...metricRow(x)]),
    ['TOTAL', ...metricRow(d.totals)])

  // ── page numbers ───────────────────────────────────────────────────────────
  ctx.pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${ctx.pages.length}`
    p.drawText(label, {
      x: A4.w - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN - 14,
      size: 7.5, font, color: MUTED,
    })
    p.drawText(`${d.workspaceLabel} · ${d.periodLabel}`, { x: MARGIN, y: MARGIN - 14, size: 7.5, font, color: MUTED })
  })

  return doc.save()
}
