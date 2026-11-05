// Shazzy's packaging sales sheet → ZeeOps (owner, 2026-11-05: "shazzy
// packaging sales is men update karta rahe ga").
//
// The sheet is a Google Sheet with one tab per month ("SEP", "OCT", "NOV"…;
// cell A1 reads "Oct-26") and the columns CSR · Date · Invoice · Name · Email ·
// Number · Order amount · Status. Shazzy keeps the STATUS column current —
// "In Production", "Sample production", "Shipped", "Delivered" — and that is
// the one thing ZeeOps takes from it: the production status of the matching
// sale. Money never comes from the sheet (payments are recorded from PayPal /
// Payoneer / the owner), and nothing is created from it: a row ZeeOps cannot
// match is reported, so the sale gets entered properly, not invented.
//
// Read through the sheet's per-tab CSV export (link-shared, no API key). The
// sheet id lives in the environment: the repo is public and the sheet holds
// customer emails and phone numbers.

import { readSales, writeSale } from './sales'
import type { ProductionStatus, Sale } from './salescore'

export const SHEET_ACTOR = 'sales-sheet'

export interface SheetRow {
  tab: string
  csr: string
  date: string
  invoice: string
  name: string
  email: string
  phone: string
  amount: number
  status: string
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** The tabs worth reading: the last four months and the next one. */
export function tabsFor(now: Date): string[] {
  const out: string[] = []
  for (let k = -3; k <= 1; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1))
    out.push(MONTHS[d.getUTCMonth()])
  }
  return out
}

/** A small CSV parser: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function usDate(v: string): string {
  const m = v.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return ''
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`
}

/** Rows of one tab's CSV, or null when the export fell back to another tab
 *  (a missing tab name returns the FIRST sheet, so A1 is checked). */
export function rowsOfTab(tab: string, csv: string): SheetRow[] | null {
  const rows = parseCsv(csv)
  const a1 = (rows[0]?.[0] ?? '').trim().toUpperCase()
  if (!a1.startsWith(tab)) return null
  const out: SheetRow[] = []
  for (const r of rows.slice(1)) {
    const invoice = (r[2] ?? '').trim()
    if (!invoice || /^invoice$/i.test(invoice)) continue
    out.push({
      tab, csr: (r[0] ?? '').trim(), date: usDate(r[1] ?? ''), invoice,
      name: (r[3] ?? '').trim(), email: (r[4] ?? '').trim().toLowerCase(), phone: (r[5] ?? '').trim(),
      amount: Number(String(r[6] ?? '').replace(/[^0-9.]/g, '')) || 0,
      status: (r[7] ?? '').trim(),
    })
  }
  return out
}

export async function fetchSheetRows(sheetId: string, now = new Date()): Promise<{ rows: SheetRow[]; tabs: string[] }> {
  const rows: SheetRow[] = []
  const tabs: string[] = []
  for (const tab of tabsFor(now)) {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${tab}`
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), cache: 'no-store' }).catch(() => null)
    if (!res?.ok) continue
    const got = rowsOfTab(tab, await res.text())
    if (!got) continue
    tabs.push(tab)
    rows.push(...got)
  }
  return { rows, tabs }
}

/** What Shazzy's status means for the sale's production field; null = leave it. */
export function productionFor(status: string): ProductionStatus | null {
  const s = status.toLowerCase()
  if (/deliver/.test(s)) return 'delivered'
  if (/ship/.test(s)) return 'shipped'
  if (/production|sample|printing|in progress/.test(s)) return 'in_production'
  if (/hold/.test(s)) return 'on_hold'
  return null
}

const RANK: Record<string, number> = { not_started: 0, on_hold: 0, in_production: 1, completed: 2, shipped: 3, delivered: 4, cancelled: 0 }

function matchSale(row: SheetRow, sales: Sale[]): Sale | null {
  const inv = row.invoice.toUpperCase()
  const byRef = sales.find((s) => new RegExp(`(^|[^A-Z0-9])${inv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9])`, 'i').test(s.reference || ''))
  if (byRef) return byRef
  const first = row.name.toLowerCase().split(/\s+/)[0]
  if (!first) return null
  return sales.find((s) => s.customer.toLowerCase().split(/\s+/)[0] === first && Math.abs(s.orderAmount - row.amount) < 1) ?? null
}

export interface SheetSyncResult {
  ok: boolean
  tabs: string[]
  rows: number
  changed: { invoice: string; customer: string; from: string | null; to: ProductionStatus }[]
  unmatched: { tab: string; invoice: string; name: string; amount: number; status: string }[]
  dryRun: boolean
  why?: string
}

export async function syncSalesSheet(now = new Date(), opts: { dryRun?: boolean } = {}): Promise<SheetSyncResult> {
  const sheetId = process.env.SALES_SHEET_ID
  const base: SheetSyncResult = { ok: false, tabs: [], rows: 0, changed: [], unmatched: [], dryRun: !!opts.dryRun }
  if (!sheetId) return { ...base, why: 'SALES_SHEET_ID is not set' }
  const { rows, tabs } = await fetchSheetRows(sheetId, now)
  if (!tabs.length) return { ...base, why: 'the sheet could not be read (is it still link-shared?)' }
  // Model Town direct only: the sheet is Shazzy's own production list, and its
  // invoice numbers collide with the partner stream's (its "SCB-021" is Carly
  // Blake; ZeeOps's SCB-021 is Connie Raney, a Hamdan order).
  const sales = (await readSales('packaging')).filter((s) => s.stream === 'pk_direct')
  const out: SheetSyncResult = { ...base, ok: true, tabs, rows: rows.length }
  const day = now.toISOString().slice(0, 10)
  for (const row of rows) {
    const sale = matchSale(row, sales)
    if (!sale) {
      // A refund or a job that never ran is not a sale to chase.
      if (!/refund|no production|cancel/i.test(row.status)) out.unmatched.push({ tab: row.tab, invoice: row.invoice, name: row.name, amount: row.amount, status: row.status })
      continue
    }
    const to = productionFor(row.status)
    if (!to || sale.production === to) continue
    if (sale.statusOverride === 'refunded' || sale.statusOverride === 'cancelled') continue
    // The sheet only ever moves a job FORWARD. "Delivered" in ZeeOps (from a
    // carrier's tracking) is not undone by a sheet cell that still says Shipped.
    if ((RANK[sale.production ?? 'not_started'] ?? 0) > (RANK[to] ?? 0)) continue
    out.changed.push({ invoice: row.invoice, customer: sale.customer, from: sale.production, to })
    if (opts.dryRun) continue
    const stamp = now.toISOString()
    const updated: Sale = {
      ...sale, production: to, updatedAt: stamp, updatedBy: SHEET_ACTOR,
      notes: `${sale.notes ?? ''}\n${day}: Shazzy's sales sheet says "${row.status}" (${row.tab} tab) — production set to ${to}${sale.production ? ` (was ${sale.production})` : ''}.`.trim(),
    }
    const err = await writeSale(updated)
    if (err) { out.changed.pop(); console.error('[sales-sheet] write failed', row.invoice, err) }
  }
  return out
}
