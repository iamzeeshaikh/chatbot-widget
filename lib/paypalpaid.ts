// "X paid for your invoice" → the sports lead it belongs to. SPORTS ONLY.
//
// Why: a sports customer (Travis Cole / Kids Elevated, invoice 0474, $1,089)
// paid on 15 Oct and waited six days because nobody saw PayPal's mail — it
// lands in shopzillaltd738@gmail.com, which nobody on the sports team reads.
// On 2026-10-21 the owner set a Gmail filter there that forwards those mails
// (business name = one of the five sports sites) to info@thebaseballjerseys.com,
// the sports team's shared mailbox, which is Gmail-connected here with read
// access. This reads ONLY those mails (a fixed, narrow search — see
// searchPaypalPaidMail in lib/gmail.ts) and for each one:
//   1. finds the lead: the PayPal invoice code in the mail (INV2-XXXX-…)
//      against the lead's saved payment link (crm_pay_link) or a link an agent
//      sent; failing that, the payer's name + the amount against a sports
//      lead's invoice / quote — and only a UNIQUE hit counts;
//   2. writes a timeline note "Payment received $X · Invoice N · date",
//   3. moves the stage to Won (lib/stagechange.ts, the one stage writer),
//   4. adds the payment to the sports Sales ledger (sp_direct): onto the sale
//      linked to that lead, or a new sale when there is none,
//   5. pushes a notification to the sports dashboard.
// Every mail is recorded once in a `crm_paypal_paid` row (matched or not) on
// the reserved zeeops-crm site, keyed by Gmail's message id — so a run late,
// twice, or after a miss never pays twice. An unmatched payment is recorded
// and announced, never guessed onto a lead.
//
// To be replaced by a PayPal REST webhook once the owner's PayPal developer
// verification is done; the matcher below is what that webhook will call.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'
import { SPORTS_SITES } from './workspaces'
import { googleConfig, searchPaypalPaidMail, fetchThread, connectionFor } from './gmail'
import { readSales, writeSale } from './sales'
import { cleanSale, newId, type Sale } from './salescore'
import { applyStageChange } from './stagechange'
import { writeControlRow } from './leadrecord'
import { CRM_NOTE_ROLE, CRM_STAGE_ROLE, parseCrmStage, type CrmNoteEntry } from './crm'
import { sendPushToWorkspace } from './push'
import { extractQuoteAmount } from './opportunities'
import { quoteSessionId } from './quoteintake'

export const PAYPAL_MAILBOX = 'info@thebaseballjerseys.com'
export const CRM_PAYPAL_PAID_ROLE = 'crm_paypal_paid'
const LEDGER_SESSION = 'zeeops-paypal-paid'
const ACTOR = 'paypal-auto'
const PER_RUN = 20

// ── Reading the mail (pure) ─────────────────────────────────────────────────

export interface PaypalPaid {
  payer: string
  /** PayPal's own invoice number ("0474"), when the mail states one. */
  invoiceNumber: string | null
  amount: number | null
  currency: string
  /** INV2-XXXX-XXXX-XXXX-XXXX codes found anywhere in the mail. */
  codes: string[]
}

const INV_CODE = /INV2(?:-[A-Z0-9]{4}){4}/gi

export function invoiceCodes(text: string): string[] {
  return [...new Set((text.match(INV_CODE) ?? []).map((c) => c.toUpperCase()))]
}

/**
 * Is this PayPal's "paid for your invoice" mail, and what does it say?
 * Works on the original and on a forward ("Fwd: …", quoted headers above).
 */
export function parsePaypalPaid(subject: string, body: string): PaypalPaid | null {
  const subj = (subject || '').replace(/^\s*(fwd?|fw|re)\s*:\s*/gi, '').trim()
  const text = `${subj}\n${body || ''}`
  const head = subj.match(/^(.+?)\s+(?:has\s+)?paid\s+(?:for\s+)?your\s+invoice(?:\s+(?:number|no\.?|#))?\s*#?\s*([A-Z0-9-]+)?/i)
    ?? (body || '').match(/(?:^|\n)\s*([^\n]{2,80}?)\s+(?:has\s+)?paid\s+(?:for\s+)?your\s+invoice(?:\s+(?:number|no\.?|#))?\s*#?\s*([A-Z0-9-]+)?/i)
  if (!head) return null
  const payer = head[1].replace(/^(hello|hi)[^,]*,\s*/i, '').trim()
  const invoiceNumber = head[2] && /\d/.test(head[2]) ? head[2].replace(/[.,]$/, '') : null
  const m = text.match(/\$\s?([\d,]+(?:\.\d{2})?)\s*(USD|CAD|AUD)?/i)
    ?? text.match(/([\d,]+\.\d{2})\s*(USD|GBP|EUR|CAD|AUD)/i)
  const amount = m ? Number(m[1].replace(/,/g, '')) : null
  const currency = (m?.[2] || 'USD').toUpperCase()
  return { payer, invoiceNumber, amount: amount && Number.isFinite(amount) ? amount : null, currency, codes: invoiceCodes(text) }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/** Same person? Every word of the shorter name appears in the longer one. */
export function sameName(a: string, b: string): boolean {
  const x = norm(a).split(' ').filter((w) => w.length > 1)
  const y = norm(b).split(' ').filter((w) => w.length > 1)
  if (x.length === 0 || y.length === 0) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  return short.length >= 2 ? short.every((w) => long.includes(w)) : (long.length === 1 && long[0] === short[0])
}

export interface LeadRef { leadId: string; siteId: string; name: string; amounts: number[] }

export type MatchHow = 'invoice link' | 'name + amount'

/**
 * Which lead this payment belongs to. The invoice code is decisive; the
 * name + amount fallback needs exactly one candidate, or it matches nothing.
 */
export function matchPayment(p: PaypalPaid, byCode: Map<string, { leadId: string; siteId: string }>, leads: LeadRef[]):
  { leadId: string; siteId: string; how: MatchHow } | null {
  for (const c of p.codes) {
    const hit = byCode.get(c)
    if (hit) return { ...hit, how: 'invoice link' }
  }
  if (!p.payer || p.amount === null) return null
  const hits = leads.filter((l) => sameName(l.name, p.payer) && l.amounts.some((a) => Math.abs(a - (p.amount as number)) <= 1))
  const ids = [...new Set(hits.map((h) => h.leadId))]
  return ids.length === 1 ? { leadId: hits[0].leadId, siteId: hits[0].siteId, how: 'name + amount' } : null
}

// ── Running it ──────────────────────────────────────────────────────────────

export interface PaypalRunItem {
  gmailId: string
  subject: string
  parsed: PaypalPaid | null
  leadId: string | null
  how: MatchHow | null
  saleId?: string | null
  action: 'applied' | 'unmatched' | 'not a payment mail' | 'would apply' | 'would record unmatched' | 'error'
  error?: string
}

export interface PaypalRunResult {
  mailbox: string
  connected: boolean
  canRead: boolean
  searched: number
  alreadyDone: number
  items: PaypalRunItem[]
  errors: string[]
}

async function processedIds(): Promise<Set<string>> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('site_id', REMINDER_SITE).eq('session_id', LEDGER_SESSION).eq('role', CRM_PAYPAL_PAID_ROLE)
    .order('created_at', { ascending: false }).limit(2000)
  const out = new Set<string>()
  for (const r of data ?? []) { try { const o = JSON.parse(r.message); if (o?.gmailId) out.add(o.gmailId) } catch { /* skip */ } }
  return out
}

/** Every sports invoice code we know, and the lead it was sent to. */
export async function codeIndex(): Promise<Map<string, { leadId: string; siteId: string }>> {
  const out = new Map<string, { leadId: string; siteId: string }>()
  const { data: links } = await supabase.from('chat_logs').select('session_id, site_id, message')
    .eq('role', 'crm_pay_link').in('site_id', SPORTS_SITES).order('created_at', { ascending: true }).limit(2000)
  // A link an agent pasted straight into an email or a WhatsApp counts too.
  const { data: sent } = await supabase.from('chat_logs').select('session_id, site_id, message')
    .in('role', ['crm_email', 'crm_wa_out']).in('site_id', SPORTS_SITES).ilike('message', '%INV2-%')
    .order('created_at', { ascending: true }).limit(2000)
  for (const r of [...(sent ?? []), ...(links ?? [])]) {
    for (const c of invoiceCodes(r.message ?? '')) out.set(c, { leadId: r.session_id, siteId: r.site_id })
  }
  return out
}

/** Sports leads of the last six months with every amount they were quoted or invoiced. */
export async function leadRefs(): Promise<LeadRef[]> {
  const since = new Date(Date.now() - 183 * 86_400_000).toISOString()
  const [leadsRes, capRes, docsRes, quotedRes, contactRes] = await Promise.all([
    supabase.from('leads').select('id, site_id, name').in('site_id', SPORTS_SITES).gte('created_at', since).limit(5000),
    supabase.from('chat_logs').select('session_id, site_id, message').eq('role', 'lead_capture').in('site_id', SPORTS_SITES).gte('created_at', since).limit(5000),
    supabase.from('chat_logs').select('session_id, message').eq('role', 'crm_invoice_doc').in('site_id', SPORTS_SITES).limit(2000),
    supabase.from('chat_logs').select('session_id, message').in('role', ['crm_email', 'crm_wa_out', 'crm_invoice']).in('site_id', SPORTS_SITES).gte('created_at', since).ilike('message', '%$%').limit(5000),
    supabase.from('chat_logs').select('session_id, message').eq('role', 'contact').in('site_id', SPORTS_SITES).gte('created_at', since).limit(5000),
  ])
  // Other names the customer goes by: the invoice's Bill To and the contact
  // details an agent typed — a chat lead often has no name of its own.
  const altNames = new Map<string, string[]>()
  const addName = (id: string, n: unknown) => { if (typeof n === 'string' && n.trim()) altNames.set(id, [...(altNames.get(id) ?? []), n.trim()]) }
  for (const r of contactRes.data ?? []) { try { addName(r.session_id, JSON.parse(r.message).name) } catch { /* skip */ } }
  const amounts = new Map<string, number[]>()
  const push = (id: string, n: number | null) => { if (n && n > 0) amounts.set(id, [...(amounts.get(id) ?? []), n]) }
  for (const r of docsRes.data ?? []) {
    try {
      const o = JSON.parse(r.message)
      const items = Array.isArray(o.items) ? o.items : []
      const num = (v: unknown) => Number(String(v ?? '').replace(/[^0-9.]/g, '')) || 0
      push(r.session_id, Math.round(items.reduce((a: number, it: Record<string, unknown>) => a + num(it.quantity) * num(it.rate), 0) * (1 + num(o.taxPercent) / 100) * 100) / 100)
      push(r.session_id, num(o.amount))
      addName(r.session_id, o.billTo?.name ?? o.billTo)
    } catch { /* skip */ }
  }
  for (const r of quotedRes.data ?? []) {
    try { const o = JSON.parse(r.message); push(r.session_id, extractQuoteAmount(String(o.body ?? ''))); push(r.session_id, Number(String(o.amount ?? '').replace(/[^0-9.]/g, '')) || null) } catch { /* skip */ }
  }
  const out: LeadRef[] = []
  const add = (leadId: string, siteId: string, name: string) => {
    for (const n of [name, ...(altNames.get(leadId) ?? [])]) if (n) out.push({ leadId, siteId, name: n, amounts: amounts.get(leadId) ?? [] })
  }
  for (const l of leadsRes.data ?? []) add(quoteSessionId(l.id), l.site_id, l.name ?? '')
  for (const c of capRes.data ?? []) {
    try { add(c.session_id, c.site_id, JSON.parse(c.message).name ?? '') } catch { /* skip */ }
  }
  return out
}

async function currentStage(leadId: string): Promise<string | null> {
  const { data } = await supabase.from('chat_logs').select('message').eq('session_id', leadId).eq('role', CRM_STAGE_ROLE)
    .order('created_at', { ascending: false }).limit(1)
  return parseCrmStage(data?.[0]?.message)?.stage ?? null
}

function money(n: number | null, cur: string): string {
  if (n === null) return 'an unknown amount'
  return `${cur === 'USD' ? '$' : `${cur} `}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Add the payment to the sports ledger: the lead's sale, or a new one. */
async function recordInLedger(p: PaypalPaid, leadId: string, paidOn: string, gmailId: string): Promise<{ saleId: string | null; error: string | null }> {
  if (p.amount === null) return { saleId: null, error: 'no amount in the mail — ledger not touched' }
  const sales = await readSales('sports')
  const tag = `PayPal invoice ${p.invoiceNumber ?? p.codes[0] ?? ''} (auto, mail ${gmailId})`
  const existing = sales.find((s) => s.leadId === leadId && s.stream === 'sp_direct')
  const now = new Date().toISOString()
  if (existing) {
    if (existing.payments.some((x) => x.note.includes(gmailId))) return { saleId: existing.id, error: null }
    const next: Sale = {
      ...existing,
      payments: [...existing.payments, { id: newId('pay'), date: paidOn, amount: p.amount, fee: 0, method: 'paypal', rate: null, note: tag }],
      updatedAt: now, updatedBy: ACTOR,
    }
    const err = await writeSale(next)
    return { saleId: existing.id, error: err }
  }
  const made = cleanSale({
    stream: 'sp_direct', customer: p.payer || 'PayPal customer', orderDate: paidOn, currency: p.currency,
    orderAmount: p.amount, reference: p.invoiceNumber ? `PayPal ${p.invoiceNumber}` : (p.codes[0] ?? 'PayPal'),
    source: 'PayPal invoice (recorded automatically from the payment email)', leadId,
    payments: [{ date: paidOn, amount: p.amount, fee: 0, method: 'paypal', note: tag }],
    notes: 'Created automatically when PayPal reported the payment. Add the PayPal fee, the production cost and the rate when known.',
  }, null, ACTOR, 'sports')
  if ('error' in made) return { saleId: null, error: made.error }
  const err = await writeSale(made.sale)
  return { saleId: made.sale.id, error: err }
}

export async function runPaypalPaid(origin: string, opts: { dryRun?: boolean } = {}): Promise<PaypalRunResult> {
  const result: PaypalRunResult = { mailbox: PAYPAL_MAILBOX, connected: false, canRead: false, searched: 0, alreadyDone: 0, items: [], errors: [] }
  const conn = await connectionFor(PAYPAL_MAILBOX)
  result.connected = !!conn && !conn.revoked
  result.canRead = !!conn?.canRead && !conn.revoked
  if (!result.canRead) { result.errors.push(`${PAYPAL_MAILBOX} is not connected with read access — reconnect Gmail for it on the sports dashboard.`); return result }
  const cfg = googleConfig(origin)
  if (!cfg) { result.errors.push('Google OAuth is not configured'); return result }

  const hits = await searchPaypalPaidMail(PAYPAL_MAILBOX, cfg)
  result.searched = hits.length
  const done = await processedIds()
  const todo = hits.filter((h) => !done.has(h.id))
  result.alreadyDone = hits.length - todo.length
  if (todo.length === 0) return result

  const [byCode, refs] = await Promise.all([codeIndex(), leadRefs()])
  const threads = new Map<string, Awaited<ReturnType<typeof fetchThread>>>()

  for (const h of todo.slice(0, PER_RUN)) {
    try {
      let msgs = threads.get(h.threadId)
      if (!msgs) { msgs = await fetchThread(PAYPAL_MAILBOX, cfg, h.threadId); threads.set(h.threadId, msgs) }
      const m = msgs.find((x) => x.gmailId === h.id)
      if (!m) continue
      const parsed = parsePaypalPaid(m.subject, m.bodyText)
      const base: PaypalRunItem = { gmailId: h.id, subject: m.subject, parsed, leadId: null, how: null, action: 'not a payment mail' }
      if (!parsed) {
        if (!opts.dryRun) await writeLedger({ gmailId: h.id, subject: m.subject, matched: null, note: 'not a payment mail' })
        result.items.push(base); continue
      }
      const hit = matchPayment(parsed, byCode, refs)
      const paidOn = (m.at || new Date().toISOString()).slice(0, 10)
      if (!hit) {
        result.items.push({ ...base, action: opts.dryRun ? 'would record unmatched' : 'unmatched' })
        if (opts.dryRun) continue
        await writeLedger({ gmailId: h.id, subject: m.subject, matched: null, payer: parsed.payer, amount: parsed.amount, invoice: parsed.invoiceNumber, codes: parsed.codes })
        await sendPushToWorkspace('sports', {
          title: 'PayPal payment — no lead matched',
          body: `${parsed.payer} paid ${money(parsed.amount, parsed.currency)}${parsed.invoiceNumber ? ` (invoice ${parsed.invoiceNumber})` : ''}. Find the lead and record it in Sales.`,
          url: '/sales', tag: `paypal-${h.id}`, sticky: true,
        })
        continue
      }
      if (opts.dryRun) { result.items.push({ ...base, leadId: hit.leadId, how: hit.how, action: 'would apply' }); continue }

      // 1. Timeline.
      const note: CrmNoteEntry = {
        id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        body: `Payment received ${money(parsed.amount, parsed.currency)} · Invoice ${parsed.invoiceNumber ?? parsed.codes[0] ?? '—'} · ${paidOn} · paid by ${parsed.payer} (PayPal, matched by ${hit.how})`,
        author: ACTOR, at: new Date().toISOString(),
      }
      await writeControlRow({ sessionId: hit.leadId, siteId: hit.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(note) })
      // 2. Stage → Won (unless it already is).
      const prev = await currentStage(hit.leadId)
      if (prev !== 'won') await applyStageChange({ leadId: hit.leadId, siteId: hit.siteId, stage: 'won', previous: prev, actorEmail: ACTOR })
      // 3. Sales ledger.
      const ledger = await recordInLedger(parsed, hit.leadId, paidOn, h.id)
      if (ledger.error) result.errors.push(`${h.id}: ${ledger.error}`)
      // 4. Remember, then 5. tell the team.
      await writeLedger({ gmailId: h.id, subject: m.subject, matched: hit.leadId, how: hit.how, payer: parsed.payer, amount: parsed.amount, invoice: parsed.invoiceNumber, codes: parsed.codes, saleId: ledger.saleId })
      await sendPushToWorkspace('sports', {
        title: `Payment received — ${money(parsed.amount, parsed.currency)}`,
        body: `${parsed.payer} paid${parsed.invoiceNumber ? ` invoice ${parsed.invoiceNumber}` : ''}. Lead moved to Won and added to Sales.`,
        url: `/leads/${encodeURIComponent(hit.leadId)}`, tag: `paypal-${h.id}`, sticky: true,
      })
      result.items.push({ ...base, leadId: hit.leadId, how: hit.how, saleId: ledger.saleId, action: 'applied' })
    } catch (e) {
      result.errors.push(`${h.id}: ${e instanceof Error ? e.message : String(e)}`)
      result.items.push({ gmailId: h.id, subject: '', parsed: null, leadId: null, how: null, action: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

async function writeLedger(o: Record<string, unknown>) {
  await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE, session_id: LEDGER_SESSION, role: CRM_PAYPAL_PAID_ROLE,
    message: JSON.stringify({ ...o, at: new Date().toISOString() }),
  })
}
