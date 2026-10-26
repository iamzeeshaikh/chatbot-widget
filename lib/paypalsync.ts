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
import type { Sale } from './salescore'
import { applyStageChange } from './stagechange'
import { writeControlRow } from './leadrecord'
import { CRM_NOTE_ROLE, type CrmNoteEntry, type CrmStage } from './crm'
import { sendPushToWorkspace } from './push'
import { currentStage } from './paypalpaid'
import { listInvoices, invoiceDetail, feeFor, shortCode, paypalConfigured, type PpInvoice } from './paypalapi'

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
  errors: string[]
}

async function doneIds(): Promise<Set<string>> {
  const { data } = await supabase.from('chat_logs').select('message').eq('session_id', SESSION).eq('role', CRM_PAYPAL_SYNC_ROLE).limit(5000)
  const out = new Set<string>()
  for (const r of data ?? []) { try { const o = JSON.parse(r.message); if (o?.paymentId) out.add(o.paymentId) } catch { /* skip */ } }
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
  const res: PaypalSyncResult = { ok: true, dryRun, invoices: 0, applied: [], unmatchedPaid: [], unpaidNotInLedger: [], errors: [] }
  if (!paypalConfigured()) { res.ok = false; res.errors.push('PAYPAL_PACKAGING_CLIENT_ID / SECRET are not set'); return res }
  const [invoices, sales, links, done] = await Promise.all([listInvoices(), readSales('packaging'), linkIndex(), doneIds()])
  res.invoices = invoices.length
  for (const inv of invoices) {
    try {
      const sale = findSale(inv, sales, links)
      if (!PAID.has(inv.status)) {
        if (!sale && ['SENT', 'UNPAID', 'SCHEDULED'].includes(inv.status)) res.unpaidNotInLedger.push({ invoice: inv.number, customer: inv.name || inv.business, amount: inv.amount, status: inv.status })
        continue
      }
      const payments = inv.payments.length ? inv.payments : await invoiceDetail(inv.id)
      for (const p of payments) {
        if (!p.paymentId || done.has(p.paymentId)) continue
        if (sale && sale.payments.some((x) => x.id === `pay_pp_${p.paymentId}` || (x.note ?? '').includes(p.paymentId))) {
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
  return res
}
