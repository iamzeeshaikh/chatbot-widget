// PayPal → ZeeOps for the PACKAGING ledger (owner, 2026-10-26: "PayPal ko
// integrate karte hen take aap ko bh pata chal sake").
//
// Every 30 minutes (cron) it reads the ZCB DIGITAL LTD invoices through the
// PayPal API (lib/paypalapi.ts) and, for each PAYMENT on a paid or part-paid
// invoice that the ledger does not have yet:
//   1. finds the Model Town sale: the invoice's code (PVYDCB5SB2V756VM, the
//      part of the payer link) or "PayPal 00NN" in the sale's reference/notes,
//      or a lead whose saved payment link carries that code;
//   2. adds the payment with PayPal's real fee (Transaction search);
//   3. writes a note on the lead, moves it to Won, and pushes the team.
// A payment is recorded once (payment id in a crm_paypal_sync row and on the
// payment itself). A paid invoice with no sale is reported and pushed — never
// guessed onto one. Unpaid invoices missing from the ledger are listed too.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'
import { PACKAGING_SITES } from './workspaces'
import { readSales, writeSale } from './sales'
import { cleanSale, type Sale } from './salescore'
import { applyStageChange } from './stagechange'
import { writeControlRow } from './leadrecord'
import { CRM_NOTE_ROLE, type CrmNoteEntry, type CrmStage } from './crm'
import { sendPushToWorkspace } from './push'
import { currentStage } from './paypalpaid'
import { listInvoices, invoiceDetail, feeFor, shortCode, paypalConfigured, listTransactions, gbpPkrOn, type PpInvoice } from './paypalapi'

export const CRM_PAYPAL_SYNC_ROLE = 'crm_paypal_sync'
const SESSION = 'zeeops-paypal-sync'
const ACTOR = 'paypal-sync'
const PAID = new Set(['PAID', 'PARTIALLY_PAID'])

const norm = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const money = (n: number, cur: string) => `${cur === 'USD' ? '$' : `${cur} `}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface PaypalSyncResult {
  ok: boolean
  dryRun: boolean
  invoices: number
  applied: { invoice: string; customer: string; amount: number; fee: number | null; saleId: string; leadId: string | null }[]
  unmatchedPaid: { invoice: string; customer: string; amount: number }[]
  unpaidNotInLedger: { invoice: string; customer: string; amount: number; status: string }[]
  /** Rates locked from PayPal's own USD→GBP conversion (see lockRates). */
  ratesLocked: { customer: string; date: string; usdNet: number; gbp: number; rate: number }[]
  errors: string[]
}

/** Payments already handled, and those recorded as "no sale found" (which are
 *  retried once a sale exists, without a second push). */
async function doneIds(): Promise<Set<string> & { unmatched?: Set<string> }> {
  const { data } = await supabase.from('chat_logs').select('message').eq('session_id', SESSION).eq('role', CRM_PAYPAL_SYNC_ROLE)
    .order('created_at', { ascending: true }).range(0, 9999)
  const last = new Map<string, boolean>()
  for (const r of data ?? []) { try { const o = JSON.parse(r.message); if (o?.paymentId) last.set(o.paymentId, o.matched === null) } catch { /* skip */ } }
  const out: Set<string> & { unmatched?: Set<string> } = new Set([...last].filter(([, u]) => !u).map(([k]) => k))
  out.unmatched = new Set([...last].filter(([, u]) => u).map(([k]) => k))
  return out
}
async function remember(o: Record<string, unknown>) {
  await supabase.from('chat_logs').insert({ site_id: REMINDER_SITE, session_id: SESSION, role: CRM_PAYPAL_SYNC_ROLE, message: JSON.stringify({ ...o, at: new Date().toISOString() }) })
}

/** Invoice code → lead, from the payment links saved on packaging leads. */
async function linkIndex(): Promise<Map<string, { leadId: string; siteId: string }>> {
  const out = new Map<string, { leadId: string; siteId: string }>()
  const { data } = await supabase.from('chat_logs').select('session_id, site_id, message')
    .eq('role', 'crm_pay_link').in('site_id', [...PACKAGING_SITES]).order('created_at', { ascending: true }).limit(3000)
  for (const r of data ?? []) {
    const m = String(r.message ?? '').match(/invoice\/p\/#([A-Z0-9-]+)/i)
    if (m) out.set(norm(m[1]).replace(/^INV2/, ''), { leadId: r.session_id, siteId: r.site_id })
  }
  return out
}

function findSale(inv: PpInvoice, sales: Sale[], links: Map<string, { leadId: string; siteId: string }>): Sale | null {
  const code = shortCode(inv.id)
  const live = sales.filter((s) => s.stream === 'pk_direct' && !s.deleted)
  const byCode = live.find((s) => norm(`${s.reference} ${s.notes}`).includes(code))
  if (byCode) return byCode
  const byNumber = live.filter((s) => new RegExp(`PayPal(?: invoice)? ${inv.number}\\b`, 'i').test(`${s.reference} ${s.notes}`))
  if (byNumber.length === 1) return byNumber[0]
  const lead = links.get(code)
  if (lead) { const byLead = live.filter((s) => s.leadId === lead.leadId); if (byLead.length === 1) return byLead[0] }
  return null
}

export async function runPaypalSync(opts: { dryRun?: boolean } = {}): Promise<PaypalSyncResult> {
  const dryRun = !!opts.dryRun
  const res: PaypalSyncResult = { ok: true, dryRun, invoices: 0, applied: [], unmatchedPaid: [], unpaidNotInLedger: [], ratesLocked: [], errors: [] }
  if (!paypalConfigured()) { res.ok = false; res.errors.push('PAYPAL_PACKAGING_CLIENT_ID / SECRET are not set'); return res }
  const [invoices, sales, links, done] = await Promise.all([listInvoices(), readSales('packaging'), linkIndex(), doneIds()])
  res.invoices = invoices.length
  for (const inv of invoices) {
    try {
      let sale = findSale(inv, sales, links)
      // Paid, no sale yet, but the invoice was sent from a lead in ZeeOps (its
      // link sits on that lead): open the sale from the invoice instead of only
      // pushing "add it in Sales" (Taylor Buser, IH-029, 28 Oct 2026).
      const linked = links.get(shortCode(inv.id))
      if (!sale && PAID.has(inv.status) && linked && !dryRun) {
        const made = cleanSale({
          stream: 'pk_direct', customer: inv.name || inv.business || 'PayPal customer', company: inv.business || '', email: inv.email || '',
          orderDate: inv.date || new Date().toISOString().slice(0, 10), currency: inv.currency, orderAmount: inv.amount,
          reference: `PayPal ${inv.number} (${inv.id})`, leadId: linked.leadId,
          source: 'PayPal invoice sent from ZeeOps (sale opened automatically when it was paid)',
          notes: 'Opened automatically from the paid PayPal invoice. Add the production cost when known.',
          payments: [],
        }, null, ACTOR, 'packaging')
        if (!('error' in made)) {
          const err = await writeSale(made.sale)
          if (!err) { sale = made.sale; sales.push(made.sale) } else res.errors.push(`${inv.number}: could not open the sale (${err})`)
        }
      }
      if (!PAID.has(inv.status)) {
        if (!sale && ['SENT', 'UNPAID', 'SCHEDULED'].includes(inv.status)) res.unpaidNotInLedger.push({ invoice: inv.number, customer: inv.name || inv.business, amount: inv.amount, status: inv.status })
        continue
      }
      const payments = inv.payments.length ? inv.payments : await invoiceDetail(inv.id)
      for (const p of payments) {
        if (!p.paymentId || done.has(p.paymentId)) continue
        // Reported before as "not in Sales": only worth another pass once a sale exists.
        if (!sale && done.unmatched?.has(p.paymentId)) continue
        // Already there: by our id, by the transaction id in a note, or a
        // payment typed by hand for the same amount within a week (every
        // October payment was entered by hand before this sync existed).
        const near = (d: string) => Math.abs(Date.parse(d) - Date.parse(p.date || d)) <= 7 * 864e5
        if (sale && sale.payments.some((x) => x.id === `pay_pp_${p.paymentId}` || (x.note ?? '').includes(p.paymentId)
          || (Math.abs(x.amount - p.amount) < 0.01 && near(x.date)))) {
          if (!dryRun) await remember({ paymentId: p.paymentId, invoice: inv.number, saleId: sale.id, how: 'already in ledger' })
          continue
        }
        if (!sale) {
          res.unmatchedPaid.push({ invoice: inv.number, customer: inv.name || inv.business, amount: p.amount })
          if (!dryRun) {
            await remember({ paymentId: p.paymentId, invoice: inv.number, matched: null, customer: inv.name || inv.business, amount: p.amount })
            await sendPushToWorkspace('packaging', {
              title: `PayPal payment — not in Sales`, body: `${inv.name || inv.business} paid ${money(p.amount, inv.currency)} on invoice ${inv.number}. Add the sale in Sales.`,
              url: '/sales', tag: `ppsync-${p.paymentId}`, sticky: true,
            })
          }
          continue
        }
        const fee = await feeFor(p.paymentId, p.date).catch(() => null)
        res.applied.push({ invoice: inv.number, customer: sale.customer, amount: p.amount, fee, saleId: sale.id, leadId: sale.leadId ?? null })
        if (dryRun) continue
        const now = new Date().toISOString()
        sale.payments = [...sale.payments, {
          id: `pay_pp_${p.paymentId}`, date: p.date || now.slice(0, 10), amount: p.amount, fee: fee ?? 0, method: 'paypal', rate: null,
          note: `PayPal invoice ${inv.number}, transaction ${p.paymentId} (synced from PayPal)${fee === null ? ' — fee not found yet' : ''}`,
        }]
        sale.updatedAt = now; sale.updatedBy = ACTOR
        const failed = await writeSale(sale)
        if (failed) { res.errors.push(`${inv.number}: ledger write failed`); continue }
        await remember({ paymentId: p.paymentId, invoice: inv.number, saleId: sale.id, amount: p.amount, fee })
        if (sale.leadId) {
          const site = await supabase.from('chat_logs').select('site_id').eq('session_id', sale.leadId).limit(1)
          const siteId = site.data?.[0]?.site_id
          if (siteId) {
            const note: CrmNoteEntry = { id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, author: ACTOR, at: now,
              body: `Payment received ${money(p.amount, inv.currency)} · PayPal invoice ${inv.number} · ${p.date}${fee !== null ? ` · PayPal fee ${money(fee, inv.currency)}` : ''} (synced from PayPal)` }
            await writeControlRow({ sessionId: sale.leadId, siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(note) })
            const prev = await currentStage(sale.leadId)
            if (prev !== 'won') await applyStageChange({ leadId: sale.leadId, siteId, stage: 'won', previous: (prev ?? 'new') as CrmStage, actorEmail: ACTOR })
          }
        }
        await sendPushToWorkspace('packaging', {
          title: `Payment received — ${money(p.amount, inv.currency)}`,
          body: `${sale.customer} paid PayPal invoice ${inv.number}. Recorded in Sales${sale.leadId ? ' and the lead moved to Won' : ''}.`,
          url: sale.leadId ? `/leads/${encodeURIComponent(sale.leadId)}` : '/sales', tag: `ppsync-${p.paymentId}`, sticky: true,
        })
      }
    } catch (e) {
      res.errors.push(`${inv.number}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try { await lockRates(dryRun, res) } catch (e) { res.errors.push(`rates: ${e instanceof Error ? e.message : String(e)}`) }
  return res
}

/** What a PayPal → Wise → bank PKR transfer keeps on the Wise leg (GBP→PKR). */
export const WISE_GBP_PKR_CUT = 0.006

/**
 * The real rate on PayPal payments (owner, 2026-10-26). PayPal converts every
 * USD sale to GBP at once (a T0200 pair whose paypal_reference_id is the sale)
 * — that leg, where PayPal's ~3.5% margin sits, is now EXACT from PayPal's own
 * record. The GBP then goes to Wise and on to PKR; that leg is the day's
 * mid-market GBP→PKR less Wise's ~0.6% until Wise itself is connected. The
 * result is locked onto the payment as PKR per USD of its NET amount, which is
 * what the ledger multiplies (lib/salescore.ts), so profit stops being an
 * estimate at a flat 4% haircut. Only payments with no rate yet are touched.
 */
async function lockRates(dryRun: boolean, res: PaypalSyncResult): Promise<void> {
  const sales = (await readSales('packaging')).filter((s) => s.stream === 'pk_direct' && !s.deleted && s.currency === 'USD')
  const open = sales.flatMap((s) => s.payments.filter((p) => p.method === 'paypal' && !p.rate).map((p) => ({ s, p })))
  if (!open.length) return
  const first = open.map((x) => x.p.date).sort()[0]
  const from = new Date(Math.max(+new Date(`${first}T00:00:00Z`) - 3 * 864e5, Date.now() - 360 * 864e5)).toISOString().slice(0, 10)
  const txns = await listTransactions(from, new Date().toISOString().slice(0, 10))
  const sales0006 = txns.filter((t) => (t.code === 'T0006' || t.code === 'T0007' || t.code === 'T0011') && t.currency === 'USD' && t.amount > 0)
  const touched = new Set<Sale>()
  for (const { s, p } of open) {
    const txId = (p.note ?? '').match(/transaction ([A-Z0-9]{17})/)?.[1]
      ?? p.id.replace(/^pay_pp_/, '')
    let sale = sales0006.find((t) => t.id === txId)
    if (!sale) {
      const near = sales0006.filter((t) => Math.abs(t.amount - p.amount) < 0.01 && Math.abs(Date.parse(t.date) - Date.parse(p.date)) <= 3 * 864e5)
      if (near.length === 1) sale = near[0]
    }
    if (!sale) continue
    const gbp = txns.find((t) => t.code === 'T0200' && t.currency === 'GBP' && t.amount > 0 && t.ref === sale!.id)
    if (!gbp) continue
    const gbpPkr = await gbpPkrOn(gbp.date)
    if (!gbpPkr) continue
    const usdNet = p.amount - p.fee
    if (usdNet <= 0) continue
    const rate = Math.round((gbp.amount * gbpPkr * (1 - WISE_GBP_PKR_CUT) / usdNet) * 100) / 100
    res.ratesLocked.push({ customer: s.customer, date: p.date, usdNet, gbp: gbp.amount, rate })
    if (dryRun) continue
    p.rate = rate
    p.note = `${p.note ? `${p.note} · ` : ''}rate ${rate} PKR/USD: PayPal turned $${usdNet.toFixed(2)} into £${gbp.amount.toFixed(2)} (txn ${sale.id}); £→PKR at mid-market ${gbpPkr.toFixed(2)} on ${gbp.date} less Wise ~0.6%`
    touched.add(s)
  }
  for (const s of touched) {
    s.updatedAt = new Date().toISOString(); s.updatedBy = ACTOR
    const failed = await writeSale(s)
    if (failed) res.errors.push(`rates: could not save ${s.customer}`)
  }
}
