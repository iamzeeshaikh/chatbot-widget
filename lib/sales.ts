// Sales records — storage and the exchange rate. Server only; everything a
// browser also needs lives in lib/salescore.ts.
//
// No DDL, so a sale is a control row like the rest of the CRM: one JSON
// snapshot per save, on a reserved session per workspace, newest snapshot per
// sale id wins. An edit is a further row and a delete is a snapshot marked
// deleted — the history of who changed which number, and when, stays readable.
// The reserved `zeeops-crm` site is in nobody's site scope, so these rows can
// never reach a conversation list or a preview; `crm_sale` is registered in
// CRM_ROLES as the second line of defence.

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { REMINDER_SITE } from './reminders'
import type { Workspace } from './workspaces'
import { SALE_CURRENCIES, type PkrRates, type RateInfo, type Sale } from './salescore'

export const CRM_SALE_ROLE = 'crm_sale'
export const salesSession = (ws: Workspace) => `zeeops-sales-${ws}`

// A save is one row; a busy year is a few thousand. Sized well past that, and
// said out loud if it is ever reached — this query is oldest-first, so a hit
// cap would drop the NEWEST edits (see warnIfCapped).
const MAX_ROWS = 20_000

export async function readSales(ws: Workspace): Promise<Sale[]> {
  const rows = await fetchAllPages<{ message: string; created_at: string }>(
    () => supabase.from('chat_logs')
      .select('message, created_at')
      .eq('site_id', REMINDER_SITE)
      .eq('session_id', salesSession(ws))
      .eq('role', CRM_SALE_ROLE)
      .order('created_at', { ascending: true }),
    MAX_ROWS,
  )
  warnIfCapped('sales', rows.length, MAX_ROWS)
  const byId = new Map<string, Sale>()
  for (const r of rows) {
    try {
      const s = JSON.parse(r.message) as Sale
      // The workspace is checked on read as well as on write: a row that
      // somehow sits in the wrong ledger is ignored rather than shown.
      if (s?.id && s.workspace === ws) byId.set(s.id, s)
    } catch { /* malformed row — skip */ }
  }
  return Array.from(byId.values())
    .filter((s) => !s.deleted)
    .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '') || b.createdAt.localeCompare(a.createdAt))
}

export async function writeSale(sale: Sale): Promise<string | null> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE,
    session_id: salesSession(sale.workspace),
    role: CRM_SALE_ROLE,
    message: JSON.stringify(sale),
  })
  return error?.message ?? null
}

// ── Today's rate, as a suggestion ───────────────────────────────────────────
// A mid-market rate from a free, keyless source. It is only ever offered: the
// rate a payment was really converted at is typed onto the payment and locked
// there. Cached for six hours per instance; a failed lookup returns null and
// the page asks for a rate instead of inventing one.
const RATE_TTL_MS = 6 * 60 * 60 * 1000
let rateCache: { at: number; info: RateInfo } | null = null

export async function suggestedRates(): Promise<RateInfo | null> {
  if (rateCache && Date.now() - rateCache.at < RATE_TTL_MS) return rateCache.info
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) })
    const j = await res.json().catch(() => null) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string } | null
    const perUsd = j?.rates
    const pkrPerUsd = perUsd?.PKR
    if (!res.ok || j?.result !== 'success' || !perUsd || !pkrPerUsd) return rateCache?.info ?? null
    // The source quotes every currency per ONE USD. PKR per one unit of X is
    // therefore PKR-per-USD divided by X-per-USD.
    const rates: PkrRates = {}
    for (const c of SALE_CURRENCIES) {
      if (c === 'PKR') { rates.PKR = 1; continue }
      const x = perUsd[c]
      if (x && x > 0) rates[c] = Math.round((pkrPerUsd / x) * 100) / 100
    }
    const info: RateInfo = { rates, asOf: j?.time_last_update_utc ?? '', source: 'open.er-api.com (mid-market)' }
    rateCache = { at: Date.now(), info }
    return info
  } catch {
    // A stale rate is still a better suggestion than none.
    return rateCache?.info ?? null
  }
}
