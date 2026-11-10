// Shipping status + tracking onto a direct SALE, and from there onto PayPal.
//
// One function, two doors:
//   • the Costing page (/api/costing/shipping) — the owner or the costing
//     person types the tracking against the order;
//   • a production JOB (/api/jobs/[id]) — production types it into the job's
//     shipping block (J-0026, J-0023 on 2026-11-10), which used to stop there:
//     the sale never got the number and PayPal never got the tracker, so the
//     new-account hold that delivery tracking lifts stayed on.
//
// Putting tracking on every PayPal transaction the sale was paid on
// (`pay_pp_<txn>` payments) is the point — that is what PayPal wants before it
// releases the money. Idempotent: a number the sale already carries is not
// re-sent, and before each post PayPal is asked whether it already holds that
// tracker on that transaction (a hand fix, or an earlier run).

import { readSales, writeSale } from './sales'
import type { Sale } from './salescore'
import type { ShippingStatus } from './costing'
import type { Job } from './jobs'
import { addTracking, carrierFor, hasTracker, paypalConfigured, type Carrier } from './paypalapi'

export interface SaleShippingResult {
  updated: Sale
  /** False when there was nothing to change — nothing was written. */
  changed: boolean
  paypalNote: string
  paypal: { done: string[]; already: string[]; failed: string[] }
  error: string | null
}

/** Apply a production status and/or tracking number to one sale. */
export async function applySaleShipping(
  sale: Sale,
  u: { production: ShippingStatus; tracking: string; carrier?: Carrier; by: string; source: string; dryRun?: boolean },
): Promise<SaleShippingResult> {
  const now = new Date().toISOString()
  const day = now.slice(0, 10)
  const who = u.by.split('@')[0]
  const nextTracking = u.tracking || sale.tracking || ''
  const lines: string[] = []
  const paypal = { done: [] as string[], already: [] as string[], failed: [] as string[] }
  if (u.production !== sale.production) lines.push(`${day}: ${who} set production to ${u.production}${sale.production ? ` (was ${sale.production})` : ''}.`)
  let paypalNote = ''
  if (nextTracking && nextTracking !== (sale.tracking ?? '')) {
    const carrier = u.carrier && u.carrier !== 'OTHER' ? u.carrier : carrierFor(nextTracking)
    if (paypalConfigured()) {
      for (const p of sale.payments) {
        if (p.method !== 'paypal' || !p.id.startsWith('pay_pp_')) continue
        const txn = p.id.slice('pay_pp_'.length)
        if ((await hasTracker(txn, nextTracking)) === true) { paypal.already.push(txn); continue }
        if (u.dryRun) { paypal.done.push(`${txn} (dry run)`); continue }
        const err = await addTracking(txn, nextTracking, u.production === 'delivered' ? 'DELIVERED' : 'SHIPPED', carrier)
          .catch((e: unknown) => (e instanceof Error ? e.message : 'failed'))
        if (err) paypal.failed.push(`${txn} (${err.slice(0, 80)})`); else paypal.done.push(txn)
      }
    }
    lines.push(`${day}: SHIPPED — ${carrier} tracking ${nextTracking} (entered by ${who} on ${u.source})`
      + `${paypal.done.length ? `; PayPal tracking added on ${paypal.done.join(', ')}` : ''}`
      + `${paypal.already.length ? `; PayPal already had it on ${paypal.already.join(', ')}` : ''}`
      + `${paypal.failed.length ? `; PayPal refused on ${paypal.failed.join(', ')}` : ''}.`)
    paypalNote = paypal.done.length ? `Tracking added to ${paypal.done.length} PayPal payment${paypal.done.length === 1 ? '' : 's'}.`
      : paypal.failed.length ? `PayPal did not take the tracking: ${paypal.failed[0]}`
      : paypal.already.length ? 'PayPal already had this tracking.' : ''
  }
  const updated: Sale = {
    ...sale,
    production: u.production,
    tracking: nextTracking,
    shippedAt: sale.shippedAt || (u.production !== 'in_production' ? day : ''),
    notes: lines.length ? `${sale.notes ?? ''}\n${lines.join('\n')}`.trim() : sale.notes,
    updatedAt: now, updatedBy: u.by,
  }
  const changed = lines.length > 0 || updated.shippedAt !== sale.shippedAt
  const error = changed && !u.dryRun ? await writeSale(updated) : null
  return { updated, changed, paypalNote, paypal, error }
}

// ── From a production job ────────────────────────────────────────────────────

const CARRIER_WORDS: [RegExp, Carrier][] = [[/\bDHL\b/i, 'DHL'], [/\bUPS\b/i, 'UPS'], [/\bFED\s*EX\b/i, 'FEDEX'], [/\bUSPS\b/i, 'USPS']]

/** The tracking number out of what production typed — "DHL 6101788490",
 *  "6101788490", "1Z999AA10123456784 (UPS)" — and the carrier, from the number's
 *  shape first and the words (or the job's "via") second. */
export function trackingFromText(text: string, via = ''): { tracking: string; carrier: Carrier } | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const tokens = raw.toUpperCase().split(/[\s,;/()#:]+/).filter(Boolean)
  let tracking = tokens.find((t) => /^1Z[0-9A-Z]{16}$/.test(t) || /^JD\d{18}$/.test(t) || (/^[0-9A-Z]{8,34}$/.test(t) && (t.match(/\d/g) ?? []).length >= 8)) ?? ''
  if (!tracking) {
    const joined = raw.replace(/\s+/g, '')
    if (/^\d{8,34}$/.test(joined)) tracking = joined
  }
  if (!tracking) return null
  let carrier = carrierFor(tracking)
  if (carrier === 'OTHER') carrier = CARRIER_WORDS.find(([re]) => re.test(`${raw} ${via}`))?.[1] ?? 'OTHER'
  return { tracking, carrier }
}

const leadKey = (id: string | null | undefined) => String(id ?? '').trim().replace(/^quote-/, '')

export interface JobSaleSync {
  action: 'none' | 'no-sale' | 'unchanged' | 'updated' | 'error'
  reason?: string
  saleId?: string
  tracking?: string
  production?: ShippingStatus
  paypal?: SaleShippingResult['paypal']
  paypalNote?: string
}

/**
 * A production job carrying tracking (or marked shipped) → its direct sale.
 * Never throws; a job with no matching sale does nothing and says so.
 */
export async function syncJobShippingToSale(job: Job, by: string, opts: { dryRun?: boolean } = {}): Promise<JobSaleSync> {
  try {
    if (job.track !== 'production' || job.deleted) return { action: 'none', reason: 'not a production job' }
    const ship = job.production?.shipping
    const parsed = trackingFromText(ship?.tracking ?? '', ship?.via ?? '')
    if (!parsed && job.status !== 'shipped') return { action: 'none', reason: 'no tracking and not shipped' }
    const key = leadKey(job.leadId)
    if (!key) { console.warn(`[job→sale] ${job.number}: no lead on the job`); return { action: 'no-sale', reason: 'job has no lead' } }
    const matches = (await readSales('packaging'))
      .filter((s) => s.stream === 'pk_direct' && !s.statusOverride && leadKey(s.leadId) === key)
      .sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)))
    if (matches.length === 0) { console.warn(`[job→sale] ${job.number}: no direct sale for lead ${job.leadId}`); return { action: 'no-sale', reason: `no direct sale for ${job.leadId}` } }
    // A repeat customer can have more than one order on a lead: the newest is
    // the one in production. Said in the log so a wrong pick can be found.
    if (matches.length > 1) console.warn(`[job→sale] ${job.number}: ${matches.length} sales on ${job.leadId}, using the newest (${matches[0].id})`)
    const sale = matches[0]
    const production: ShippingStatus = sale.production === 'delivered' ? 'delivered' : 'shipped'
    const tracking = parsed?.tracking ?? ''
    if ((!tracking || tracking === (sale.tracking ?? '')) && sale.production === production && sale.shippedAt) {
      return { action: 'unchanged', saleId: sale.id, tracking: sale.tracking ?? '', production }
    }
    const r = await applySaleShipping(sale, { production, tracking, carrier: parsed?.carrier, by, source: `job ${job.number}`, dryRun: opts.dryRun })
    if (r.error) return { action: 'error', reason: r.error, saleId: sale.id }
    return { action: r.changed ? 'updated' : 'unchanged', saleId: sale.id, tracking: r.updated.tracking, production, paypal: r.paypal, paypalNote: r.paypalNote }
  } catch (e) {
    console.error(`[job→sale] ${job.number} failed:`, e)
    return { action: 'error', reason: e instanceof Error ? e.message : 'failed' }
  }
}
