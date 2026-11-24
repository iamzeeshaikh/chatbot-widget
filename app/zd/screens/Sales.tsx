'use client'

// ZeeDesk: the sales ledger. One team, one ledger: every order that was won,
// what has been paid against it, what it cost and what is still owed, with
// the withdrawals and the office's expenses on their own tabs.
//
// Admins only, and the server is what enforces that: every endpoint here
// answers 403 to anybody else, and this screen then says so plainly.
//
// No money is worked out in this file. Received, fees, balance, status and
// profit come from figures() and totals() in lib/salescore.ts, the same code
// the server and the CSV export use, so the tiles, the rows and the
// spreadsheet cannot disagree.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Plus, Trash2 } from 'lucide-react'
import type { Workspace } from '@/lib/workspaces'
import { pktDayKey } from '@/lib/datetime'
import { SITE_DOMAINS } from '@/lib/sitedomains'
import {
  SALE_CURRENCIES, PAYMENT_METHODS, PAYMENT_METHOD_LABEL, PRODUCTION_STATUSES, PRODUCTION_LABEL,
  PAYMENT_STATUS_LABEL, SALE_LEAD_KIND_LABEL, PAYOUT_ROUTES, PAYOUT_ROUTE_LABEL,
  EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL,
  figures, totals, money, shortDate, newId, parseAmount, streamsForWorkspace,
  type Sale, type SaleView, type SaleFigures, type StreamInfo, type SalesStream, type RateInfo, type PkrRates,
  type SaleCurrency, type PaymentMethod, type PaymentStatus, type ProductionStatus,
  type Payout, type PayoutRoute, type Expense, type ExpenseCategory,
} from '@/lib/salescore'
import {
  BTN_DANGER, BTN_PLAIN, BTN_PRIMARY, CARD, Chip, Drawer, Empty, INPUT, LABEL, Notice, PageHead, Table, TEXTAREA,
  postJson, short, type ZdScreenProps,
} from '../ui'

interface Payload {
  workspace: Workspace
  streams: StreamInfo[]
  sales: SaleView[]
  rates: RateInfo | null
  members: string[]
}

type Status = 'loading' | 'ok' | 'error' | 'forbidden'
type TabId = 'sales' | 'payouts' | 'expenses'

// Numbers stay text until they are saved, so a half-typed amount is never
// rounded under the person typing it.
interface PayForm { id: string; date: string; amount: string; fee: string; method: PaymentMethod; rate: string; note: string }
interface CostForm { id: string; label: string; amount: string; currency: SaleCurrency; rate: string; note: string }
interface SaleForm {
  id: string
  stream: SalesStream
  reference: string
  customer: string; company: string; email: string; phone: string; country: string
  orderDate: string
  product: string; size: string; material: string; printing: string; quantity: string
  currency: SaleCurrency
  orderAmount: string
  rate: string
  profitAmount: string
  profitCurrency: SaleCurrency
  payments: PayForm[]
  costs: CostForm[]
  statusOverride: '' | 'refunded' | 'cancelled'
  production: '' | ProductionStatus
  tracking: string
  shippedAt: string
  salesPerson: string; source: string; counterparty: string
  leadId: string
  notes: string
}

const OFFLINE = 'Could not reach the server. Check your connection and try again.'
const SELECT = `${INPUT} cursor-pointer`
const CELL = 'px-4 py-2.5 align-top whitespace-nowrap'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const today = () => pktDayKey(new Date())
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))
const person = (v: string) => (v.includes('@') ? short(v) : v)
/** YYYY-MM of an order date, or '' when the date is missing. */
const monthKey = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd.slice(0, 7) : '')
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return y && m ? `${MONTHS[m - 1]} ${y}` : key
}

function blankForm(stream: SalesStream): SaleForm {
  return {
    id: '', stream, reference: '',
    customer: '', company: '', email: '', phone: '', country: '',
    orderDate: today(),
    product: '', size: '', material: '', printing: '', quantity: '',
    currency: 'USD', orderAmount: '', rate: '', profitAmount: '', profitCurrency: 'PKR',
    payments: [], costs: [],
    statusOverride: '', production: '', tracking: '', shippedAt: '',
    salesPerson: '', source: '', counterparty: '', leadId: '', notes: '',
  }
}

function formFromSale(s: Sale): SaleForm {
  return {
    id: s.id, stream: s.stream, reference: s.reference,
    customer: s.customer, company: s.company, email: s.email, phone: s.phone, country: s.country,
    orderDate: s.orderDate,
    product: s.product, size: s.size, material: s.material, printing: s.printing, quantity: s.quantity,
    currency: s.currency, orderAmount: str(s.orderAmount), rate: str(s.rate ?? null),
    profitAmount: str(s.agreedProfit?.amount ?? null), profitCurrency: s.agreedProfit?.currency ?? 'PKR',
    payments: s.payments.map((p) => ({ id: p.id, date: p.date, amount: str(p.amount), fee: str(p.fee), method: p.method, rate: str(p.rate), note: p.note })),
    costs: s.costs.map((c) => ({ id: c.id, label: c.label, amount: str(c.amount), currency: c.currency, rate: str(c.rate), note: c.note })),
    statusOverride: s.statusOverride ?? '',
    production: s.production ?? '',
    tracking: s.tracking ?? '', shippedAt: s.shippedAt ?? '',
    salesPerson: s.salesPerson, source: s.source, counterparty: s.counterparty,
    leadId: s.leadId ?? '', notes: s.notes,
  }
}

/** The form as a Sale, for the live figures: the same parsing the server applies. */
function saleFromForm(f: SaleForm, ws: Workspace): Sale {
  const profit = parseAmount(f.profitAmount)
  return {
    id: f.id || 'draft', stream: f.stream, workspace: ws, reference: f.reference,
    customer: f.customer, company: f.company, email: f.email, phone: f.phone, country: f.country,
    orderDate: f.orderDate, product: f.product, size: f.size, material: f.material, printing: f.printing,
    quantity: f.quantity, currency: f.currency, orderAmount: parseAmount(f.orderAmount) ?? 0,
    rate: f.currency === 'PKR' ? null : parseAmount(f.rate),
    agreedProfit: profit ? { amount: profit, currency: f.profitCurrency } : null,
    payments: f.payments
      .map((p) => ({ id: p.id, date: p.date, amount: parseAmount(p.amount) ?? 0, fee: parseAmount(p.fee) ?? 0, method: p.method, rate: f.currency === 'PKR' ? null : parseAmount(p.rate), note: p.note }))
      .filter((p) => p.amount > 0),
    costs: f.costs
      .map((c) => ({ id: c.id, label: c.label, amount: parseAmount(c.amount) ?? 0, currency: c.currency, rate: c.currency === 'PKR' ? null : parseAmount(c.rate), note: c.note }))
      .filter((c) => c.amount > 0),
    statusOverride: f.statusOverride || null,
    production: f.production || null,
    tracking: f.tracking, shippedAt: f.shippedAt,
    salesPerson: f.salesPerson, source: f.source, counterparty: f.counterparty,
    leadId: f.leadId || null, notes: f.notes,
    createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
  }
}

/** What POST /api/sales is sent. The server cleans and validates every field again. */
function payloadOf(f: SaleForm) {
  const profit = parseAmount(f.profitAmount)
  return {
    id: f.id || undefined, stream: f.stream, reference: f.reference,
    customer: f.customer, company: f.company, email: f.email, phone: f.phone, country: f.country,
    orderDate: f.orderDate, product: f.product, size: f.size, material: f.material, printing: f.printing,
    quantity: f.quantity, currency: f.currency, orderAmount: f.orderAmount, rate: f.rate,
    agreedProfit: profit ? { amount: profit, currency: f.profitCurrency } : null,
    payments: f.payments, costs: f.costs,
    statusOverride: f.statusOverride || null, production: f.production || null,
    tracking: f.tracking, shippedAt: f.shippedAt,
    salesPerson: f.salesPerson, source: f.source, counterparty: f.counterparty,
    leadId: f.leadId || null, notes: f.notes,
  }
}

/** One write. Resolves to the parsed answer, or an error message. */
async function send(url: string, init: RequestInit, fallback: string): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init)
    const d = await res.json().catch(() => ({}))
    if (res.ok) return { ok: true, data: d }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Sales is for admins.' }
    return { ok: false, error: typeof d?.error === 'string' && d.error ? d.error : fallback }
  } catch {
    return { ok: false, error: OFFLINE }
  }
}

const STATUS_TONE: Record<PaymentStatus, 'grey' | 'blue' | 'green' | 'amber'> = { pending: 'amber', partial: 'blue', paid: 'green', refunded: 'grey', cancelled: 'grey' }
const PRODUCTION_TONE: Record<ProductionStatus, 'grey' | 'blue' | 'green' | 'red' | 'amber'> = {
  not_started: 'grey', in_production: 'blue', completed: 'green', shipped: 'green', delivered: 'green', on_hold: 'amber', cancelled: 'red',
}

interface Filters { month: string; status: string; agent: string }
const NO_FILTERS: Filters = { month: '', status: '', agent: '' }

export default function Sales({ me, openLead, fromLead }: ZdScreenProps & {
  /** A lead record id to start a new sale from (`#sales/lead/<id>`). */
  fromLead?: string
}) {
  const isAdmin = me.role === 'admin'
  const [data, setData] = useState<Payload | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<TabId>('sales')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [editing, setEditing] = useState<{ form: SaleForm; view: SaleView | null; key: string } | null>(null)
  const [paying, setPaying] = useState<SaleView | null>(null)
  const prefilled = useRef('')

  const load = useCallback(async (): Promise<Payload | null> => {
    try {
      const res = await fetch('/api/sales')
      if (res.status === 401 || res.status === 403) { setStatus('forbidden'); return null }
      const j = await res.json().catch(() => null)
      if (!res.ok || !j) { setError(typeof j?.error === 'string' && j.error ? j.error : 'The sales could not be loaded.'); setStatus('error'); return null }
      setData(j as Payload); setStatus('ok'); setError('')
      return j as Payload
    } catch {
      setError(OFFLINE); setStatus('error')
      return null
    }
  }, [])

  const mineOf = (j: Payload): SalesStream[] => (j.streams?.length ? j.streams.map((s) => s.key) : streamsForWorkspace(j.workspace))
  const openSale = (v: SaleView) => setEditing({ form: formFromSale(v.sale), view: v, key: v.sale.id })

  // First load, and "add this lead to sales": the server fills the form from
  // the lead's own invoice, or hands back the sale the lead already has.
  useEffect(() => {
    if (!isAdmin) return
    let alive = true
    void (async () => {
      const j = await load()
      if (!alive || !j || !fromLead || prefilled.current === fromLead) return
      prefilled.current = fromLead
      // The lead is taken once: a reload must not start the same sale again.
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#sales`)
      const r = await send(`/api/sales/prefill?lead=${encodeURIComponent(fromLead)}`, {}, 'That lead could not be turned into a sale.')
      if (!alive) return
      if (!r.ok) { setError(r.error); return }
      const existing = typeof r.data.existingId === 'string' ? j.sales.find((x) => x.sale.id === r.data.existingId) : null
      if (existing) { openSale(existing); return }
      const d = (r.data.draft ?? null) as Record<string, unknown> | null
      const mine = mineOf(j)
      if (!d || !mine[0]) { setError('That lead could not be turned into a sale.'); return }
      const s = (k: string) => String(d[k] ?? '')
      setEditing({
        view: null, key: `lead-${fromLead}`,
        form: {
          ...blankForm(mine.includes(d.stream as SalesStream) ? (d.stream as SalesStream) : mine[0]),
          leadId: s('leadId') || fromLead, customer: s('customer'), company: s('company'), email: s('email'), phone: s('phone'),
          country: s('country'), orderDate: s('orderDate') || today(), product: s('product'), quantity: s('quantity'),
          orderAmount: s('orderAmount'),
          currency: (SALE_CURRENCIES as readonly string[]).includes(s('currency')) ? (s('currency') as SaleCurrency) : 'USD',
          salesPerson: s('salesPerson'),
          // The server words the source after the other dashboard; this team's ledger says where the lead came from, nothing else.
          source: s('source').replace(/^\s*\S+\s+lead\s*[—-]\s*/i, 'Website lead: '),
          notes: s('notes'),
        },
      })
    })()
    return () => { alive = false }
  }, [isAdmin, load, fromLead])

  const rates = data?.rates?.rates ?? null
  const all = useMemo(() => [...(data?.sales ?? [])].sort((a, b) => (b.sale.orderDate || '').localeCompare(a.sale.orderDate || '') || (b.sale.createdAt || '').localeCompare(a.sale.createdAt || '')), [data])

  const options = useMemo(() => {
    const months = new Map<string, number>()
    const agents = new Map<string, number>()
    for (const v of all) {
      const m = monthKey(v.sale.orderDate); if (m) months.set(m, (months.get(m) ?? 0) + 1)
      const a = v.sale.salesPerson.trim().toLowerCase(); if (a) agents.set(a, (agents.get(a) ?? 0) + 1)
    }
    return {
      months: [...months].sort((a, b) => b[0].localeCompare(a[0])),
      agents: [...agents].sort((a, b) => person(a[0]).localeCompare(person(b[0]))),
    }
  }, [all])

  const inMonth = useMemo(() => all.filter((v) => !filters.month || monthKey(v.sale.orderDate) === filters.month), [all, filters.month])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return inMonth.filter((v) => {
      const s = v.sale
      if (filters.agent && s.salesPerson.trim().toLowerCase() !== filters.agent) return false
      if (filters.status === '@owed') { if (v.fig.closed || !(v.fig.outstanding > 0)) return false }
      else if (filters.status && v.fig.status !== filters.status) return false
      return !q || [s.customer, s.company, s.reference, s.product, s.email, s.phone, s.salesPerson, s.tracking ?? ''].some((x) => x.toLowerCase().includes(q))
    })
  }, [inMonth, filters.agent, filters.status, search])

  // The tiles follow whatever the list is narrowed to: the same arithmetic over fewer rows.
  const t = useMemo(() => totals(rows, rates), [rows, rates])
  // Expenses belong to the office, not to an agent or a search, so their "net
  // after expenses" is set against the whole month.
  const monthProfit = useMemo(() => (filters.month ? totals(inMonth, rates).profitPkr : null), [filters.month, inMonth, rates])

  if (!isAdmin || status === 'forbidden') {
    return (
      <main className="flex-1 min-w-0 overflow-y-auto text-[13px] text-[#2f3941]">
        <PageHead title="Sales" />
        <div className="px-6 pb-8"><Empty text={isAdmin ? 'Sales is for admins, and it is not turned on for this account yet.' : 'Sales is for admins.'} /></div>
      </main>
    )
  }

  const mine = data ? mineOf(data) : []
  const narrowed = !!search.trim() || !!(filters.status || filters.agent)
  const period = filters.month ? monthLabel(filters.month) : 'All time'
  const est = t.estimated || t.incomplete
  const afterSave = () => { setEditing(null); setPaying(null); void load() }

  return (
    <main className="flex-1 min-w-0 overflow-y-auto text-[13px] text-[#2f3941]">
      <PageHead title="Sales" sub={status === 'ok' ? `${period} · ${rows.length}${rows.length !== inMonth.length ? ` of ${inMonth.length}` : ''} sale${inMonth.length === 1 ? '' : 's'}` : 'Loading…'}
        actions={
          <>
            <select value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })} aria-label="Period" className={`${SELECT} !w-auto !h-8`}>
              <option value="">All time</option>
              {options.months.map(([m, n]) => <option key={m} value={m}>{monthLabel(m)} ({n})</option>)}
            </select>
            <a href="/api/sales/export" className={BTN_PLAIN}><Download size={14} aria-hidden />Export CSV</a>
            <button type="button" className={BTN_PRIMARY} disabled={!mine[0]} onClick={() => setEditing({ form: blankForm(mine[0]), view: null, key: `new-${Date.now()}` })}>
              <Plus size={14} aria-hidden />New sale
            </button>
          </>
        } />

      <div className="px-6 border-b border-[#d8dcde] flex gap-5" role="tablist" aria-label="Sales ledgers">
        {([['sales', 'Sales'], ['payouts', 'Payouts'], ['expenses', 'Expenses']] as [TabId, string][]).map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`zd-sales-tab-${k}`} aria-selected={tab === k} aria-controls="zd-sales-panel" onClick={() => setTab(k)}
            className={`relative -mb-px pb-2.5 pt-1 text-[14px] border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded-t ${tab === k ? 'border-[#1f73b7] text-[#1f73b7] font-semibold' : 'border-transparent text-[#49545c] hover:text-[#2f3941]'}`}>
            {label}
          </button>
        ))}
      </div>

      <div id="zd-sales-panel" role="tabpanel" aria-labelledby={`zd-sales-tab-${tab}`} className="px-6 py-5 space-y-4 max-w-[1500px]">
        {error && <Notice text={error} bad />}
        {status === 'ok' && !mine[0] && <Notice text="No sales ledger is set up for this team yet, so a sale cannot be added." />}

        {tab === 'sales' && status === 'loading' && <p className="text-[13px] text-[#68737d]">Loading the sales…</p>}
        {tab === 'sales' && status === 'error' && (
          <button type="button" className={BTN_PLAIN} onClick={() => { setStatus('loading'); void load() }}>Try again</button>
        )}

        {tab === 'sales' && status === 'ok' && (
          <>
            <div className="rounded-lg border border-[#d8dcde] bg-[#e9ebed] grid grid-cols-2 lg:grid-cols-5 gap-px overflow-hidden">
              <Tile label="Orders" value={String(t.open)} sub={t.closed ? `plus ${t.closed} refunded or cancelled` : 'open orders'} />
              <Tile label="Order value" value={money(t.orderValueUsd, 'USD')} sub="open orders, in USD" />
              <Tile label="Received" value={money(t.receivedUsd, 'USD')} sub={`fees ${money(t.feesUsd, 'USD')}`} />
              <Tile label="Net received" value={money(t.netUsd, 'USD')} sub="after payment fees" tone="good" />
              <Tile label="Outstanding" value={money(t.outstandingUsd, 'USD')} sub={t.awaitingPayment ? `${t.awaitingPayment} awaiting payment` : 'nothing owed'}
                tone={t.outstandingUsd > 0 ? 'warn' : undefined} active={filters.status === '@owed'}
                onOpen={() => setFilters({ ...filters, status: filters.status === '@owed' ? '' : '@owed' })} />
              <Tile label="Payment fees" value={money(t.feesUsd, 'USD')} sub="kept by the payment services" tone={t.feesUsd > 0 ? 'bad' : undefined} />
              <Tile label="Revenue (PKR)" value={money(t.revenuePkr, 'PKR')} sub={est ? 'includes estimates' : 'at locked rates'} />
              <Tile label="Cost (PKR)" value={money(t.costPkr, 'PKR')} sub="production and other" />
              <Tile label="Profit (PKR)" value={t.profitSales ? money(t.profitPkr, 'PKR') : 'Not known'} tone={t.profitSales ? (t.profitPkr < 0 ? 'bad' : 'good') : undefined}
                sub={[t.awaitingCosting ? `${t.awaitingCosting} awaiting costing` : '', t.profitAwaitingPayment ? `${t.profitAwaitingPayment} awaiting payment` : '', t.profitAwaitingProduction ? `${t.profitAwaitingProduction} not shipped` : '', t.profitSales ? (t.profitEstimated ? 'estimated' : 'at locked rates') : ''].filter(Boolean).join(' · ') || 'no open sales'} />
              <Tile label="Need a rate" value={String(t.needsRate)} sub={t.needsRate ? 'sales with an estimated PKR figure' : 'every rate is locked'} />
            </div>

            <p className="text-[12px] text-[#68737d]">
              {rates?.USD
                ? <>Today&apos;s mid-market rate is <b className="tabular-nums text-[#2f3941]">1 USD = Rs {rates.USD}</b>. Money that has not been withdrawn yet is estimated a little under it, by the route it will take, and marked est. Recording a payout locks the real rate onto the payments it covered.</>
                : <>Today&apos;s rate could not be fetched, so a payment without a rate of its own cannot be shown in PKR yet.</>}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer, reference, product or tracking" aria-label="Search sales" className={`${INPUT} !w-[320px] max-w-full`} />
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Payment status" className={`${SELECT} !w-auto`}>
                <option value="">Any payment status</option>
                {(Object.keys(PAYMENT_STATUS_LABEL) as PaymentStatus[]).map((k) => <option key={k} value={k}>{PAYMENT_STATUS_LABEL[k]}</option>)}
                <option value="@owed">Money still owed</option>
              </select>
              {options.agents.length > 0 && (
                <select value={filters.agent} onChange={(e) => setFilters({ ...filters, agent: e.target.value })} aria-label="Sales person" className={`${SELECT} !w-auto`}>
                  <option value="">Everyone</option>
                  {options.agents.map(([a, n]) => <option key={a} value={a}>{person(a)} ({n})</option>)}
                </select>
              )}
              {(narrowed || filters.month) && <button type="button" className={BTN_PLAIN} onClick={() => { setFilters(NO_FILTERS); setSearch('') }}>Clear</button>}
            </div>

            {rows.length === 0 ? (
              <Empty text={narrowed || filters.month ? 'No sale matches. Loosen the search or clear the filters.' : 'No sales yet. Add the first one with New sale.'} />
            ) : (
              <Table head={['Date', 'Reference', 'Customer', 'Product', 'Qty', 'Order', 'Paid', 'Balance', 'Payment', 'Production', 'Sales person', '']}>
                {rows.map((v) => <SaleRow key={v.sale.id} v={v} onOpen={() => openSale(v)} onPay={() => setPaying(v)} openLead={openLead} />)}
              </Table>
            )}
          </>
        )}

        {tab === 'payouts' && <Payouts onChanged={() => { void load() }} />}
        {tab === 'expenses' && <Expenses month={filters.month} monthProfitPkr={monthProfit} />}
      </div>

      {editing && data && (
        <SaleEditor key={editing.key} initial={editing.form} view={editing.view} workspace={data.workspace} streams={data.streams ?? []} mine={mine}
          rates={rates} members={data.members ?? []} openLead={openLead} onClose={() => setEditing(null)} onSaved={afterSave} />
      )}
      {paying && <PaymentDrawer key={paying.sale.id} view={paying} rates={rates} onClose={() => setPaying(null)} onSaved={afterSave} />}
    </main>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Tile({ label, value, sub, tone, onOpen, active }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' | 'bad'; onOpen?: () => void; active?: boolean }) {
  const color = tone === 'good' ? 'text-[#038153]' : tone === 'warn' ? 'text-[#ad5918]' : tone === 'bad' ? 'text-[#cc3340]' : 'text-[#2f3941]'
  return (
    <div className={`px-4 py-3 min-w-0 ${active ? 'bg-[#edf7ff]' : 'bg-white'}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d] truncate">{label}</p>
      <div className="h-8 flex items-end">
        {onOpen
          ? <button type="button" onClick={onOpen} aria-pressed={!!active} aria-label={`${label}: ${value}. Show these sales`} className={`text-[20px] leading-none font-semibold tabular-nums hover:underline outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded ${color}`}>{value}</button>
          : <p className={`text-[20px] leading-none font-semibold tabular-nums truncate ${color}`}>{value}</p>}
      </div>
      <p className="text-[12px] text-[#68737d] h-4 truncate" title={sub}>{sub}</p>
    </div>
  )
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block ${className}`}><span className={LABEL}>{label}</span>{children}</label>
}

function SaleRow({ v, onOpen, onPay, openLead }: { v: SaleView; onOpen: () => void; onPay: () => void; openLead: (id: string) => void }) {
  const { sale: s, fig: f } = v
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn() }
  return (
    <tr tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen() }}
      className={`border-t border-[#e9ebed] hover:bg-[#f8f9f9] cursor-pointer outline-none focus-visible:bg-[#edf7ff] ${f.closed ? 'opacity-60' : ''}`}>
      <td className={`${CELL} tabular-nums text-[#49545c]`}>{s.orderDate ? shortDate(s.orderDate) : 'No date'}</td>
      <td className={`${CELL} tabular-nums text-[#49545c] max-w-[160px] truncate`} title={s.reference}>{s.reference || 'None'}</td>
      <td className="px-4 py-2.5 align-top min-w-[160px] max-w-[240px]">
        <p className="font-medium text-[#2f3941] truncate">{s.customer}</p>
        {s.company && <p className="text-[12px] text-[#68737d] truncate">{s.company}</p>}
        {s.counterparty && <p className="text-[12px] text-[#68737d] truncate">Owed by {s.counterparty}</p>}
      </td>
      <td className="px-4 py-2.5 align-top min-w-[140px] max-w-[240px] text-[#49545c]"><p className="truncate" title={s.product}>{s.product || 'Not stated'}</p></td>
      <td className={`${CELL} tabular-nums text-[#49545c]`}>{s.quantity || 'Not stated'}</td>
      <td className={`${CELL} tabular-nums font-medium text-[#2f3941]`}>{money(s.orderAmount, s.currency)}</td>
      <td className={`${CELL} tabular-nums text-[#49545c]`}>
        {money(f.received, s.currency)}
        {f.fees > 0 && <p className="text-[12px] text-[#68737d]">fees {money(f.fees, s.currency)}</p>}
      </td>
      <td className={`${CELL} tabular-nums ${f.outstanding > 0 ? 'font-semibold text-[#ad5918]' : 'text-[#68737d]'}`}>{money(f.outstanding, s.currency)}</td>
      <td className={CELL}><Chip tone={STATUS_TONE[f.status]}>{PAYMENT_STATUS_LABEL[f.status]}</Chip></td>
      <td className={CELL}>
        {s.production ? <Chip tone={PRODUCTION_TONE[s.production]}>{PRODUCTION_LABEL[s.production]}</Chip> : <span className="text-[#68737d]">Not recorded</span>}
        {s.tracking && <p className="mt-0.5 text-[12px] text-[#68737d] tabular-nums max-w-[150px] truncate" title={s.tracking}>{s.tracking}</p>}
      </td>
      <td className={`${CELL} text-[#49545c] max-w-[150px] truncate`}>{person(s.salesPerson) || 'Not set'}</td>
      <td className={`${CELL} text-right`}>
        <span className="inline-flex items-center gap-1.5">
          {!f.closed && f.outstanding > 0 && <button type="button" className={`${BTN_PLAIN} !h-7 !px-2 !text-[12px]`} onClick={stop(onPay)}>Record payment</button>}
          {s.leadId && <button type="button" className={`${BTN_PLAIN} !h-7 !px-2 !text-[12px]`} onClick={stop(() => openLead(s.leadId as string))}>Lead</button>}
        </span>
      </td>
    </tr>
  )
}

/** The figures of the sale as it stands in the form, before it is saved. */
function LiveFigures({ live, currency, agreed }: { live: SaleFigures; currency: SaleCurrency; agreed: boolean }) {
  const cell = (label: string, value: string, sub?: string) => (
    <div className="bg-white px-3 py-2 min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d] truncate">{label}</p>
      <p className="text-[15px] font-semibold tabular-nums truncate">{value}</p>
      {sub && <p className="text-[11px] text-[#68737d] truncate">{sub}</p>}
    </div>
  )
  return (
    <div className="rounded-lg border border-[#d8dcde] bg-[#e9ebed] grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden">
      {cell('Received', money(live.received, currency), `fees ${money(live.fees, currency)}`)}
      {cell('Net received', money(live.net, currency), money(live.netPkr, 'PKR'))}
      {cell('Balance', money(live.outstanding, currency), PAYMENT_STATUS_LABEL[live.status])}
      {cell('Profit (PKR)', live.profitKnown ? money(live.profitPkr, 'PKR') : 'Not known',
        !live.profitKnown ? 'add a cost or the agreed profit' : agreed ? 'as agreed' : live.incomplete ? 'a rate is missing' : live.profitEstimated ? 'estimated' : 'at locked rates')}
    </div>
  )
}

function SaleEditor({ initial, view, workspace, streams, mine, rates, members, openLead, onClose, onSaved }: {
  initial: SaleForm; view: SaleView | null; workspace: Workspace; streams: StreamInfo[]; mine: SalesStream[]
  rates: PkrRates | null; members: string[]; openLead: (id: string) => void; onClose: () => void; onSaved: () => void
}) {
  const [form, setForm] = useState<SaleForm>(initial)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const draft = saleFromForm(form, workspace)
  const live = figures(draft, rates)
  const auto = figures({ ...draft, statusOverride: null }, rates).status
  const todayRate = rates?.[form.currency]

  const set = <K extends keyof SaleForm>(k: K, v: SaleForm[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setPay = (id: string, patch: Partial<PayForm>) => setForm((f) => ({ ...f, payments: f.payments.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
  const setCost = (id: string, patch: Partial<CostForm>) => setForm((f) => ({ ...f, costs: f.costs.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))

  async function save() {
    if (!form.customer.trim()) { setErr('A customer name is required.'); return }
    if (parseAmount(form.orderAmount) === null) { setErr('The order amount must be a number.'); return }
    setBusy(true); setErr('')
    const r = await send('/api/sales', postJson({ sale: payloadOf(form) }), 'That did not save.')
    setBusy(false)
    if (r.ok) onSaved(); else setErr(r.error)
  }

  async function remove() {
    setBusy(true); setErr('')
    const r = await send(`/api/sales?id=${encodeURIComponent(form.id)}`, { method: 'DELETE' }, 'That did not delete.')
    setBusy(false)
    if (r.ok) onSaved(); else { setErr(r.error); setConfirmDelete(false) }
  }

  const footer = confirmDelete ? (
    <>
      <p className="mr-auto text-[13px] text-[#2f3941]" role="alert">Delete this sale? It leaves every total.</p>
      <button type="button" className={BTN_PLAIN} onClick={() => setConfirmDelete(false)} disabled={busy}>Keep it</button>
      <button type="button" className={BTN_DANGER} onClick={remove} disabled={busy}><Trash2 size={14} aria-hidden />{busy ? 'Deleting' : 'Delete sale'}</button>
    </>
  ) : (
    <>
      {form.id && <button type="button" className={`${BTN_DANGER} mr-auto`} onClick={() => setConfirmDelete(true)} disabled={busy}><Trash2 size={14} aria-hidden />Delete</button>}
      <button type="button" className={BTN_PLAIN} onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className={BTN_PRIMARY} onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save sale'}</button>
    </>
  )

  const site = view?.sale.siteId ? (SITE_DOMAINS[view.sale.siteId] ?? view.sale.siteId) : ''
  const via = view?.sale.leadKind ? SALE_LEAD_KIND_LABEL[view.sale.leadKind] : ''

  return (
    <Drawer title={form.id ? `Sale: ${form.customer || 'no name'}` : 'New sale'} onClose={onClose} footer={footer} width={680}>
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <LiveFigures live={live} currency={form.currency} agreed={!!parseAmount(form.profitAmount)} />
        {live.needsRate.length > 0 && <Notice text={`No locked rate yet for: ${live.needsRate.join(', ')}. Today's rate stands in, so the PKR figures are estimates.`} />}
        {err && <Notice text={err} bad />}

        {form.leadId && (
          <div className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] px-3 py-2.5 flex items-center gap-2.5">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Won from a lead</p>
              <p className="text-[12px] text-[#68737d] truncate">{[site, via].filter(Boolean).join(' · ') || 'This sale is linked to its lead record.'}</p>
            </div>
            <button type="button" className={BTN_PLAIN} onClick={() => openLead(form.leadId)}><ExternalLink size={14} aria-hidden />Open lead</button>
            <button type="button" className={BTN_PLAIN} onClick={() => set('leadId', '')}>Unlink</button>
          </div>
        )}

        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold">Customer</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Customer (required)"><input className={INPUT} value={form.customer} onChange={(e) => set('customer', e.target.value)} autoFocus={!form.id} /></Field>
            <Field label="Company"><input className={INPUT} value={form.company} onChange={(e) => set('company', e.target.value)} /></Field>
            <Field label="Email"><input className={INPUT} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
            <Field label="Phone"><input className={INPUT} value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
            <Field label="Country"><input className={INPUT} value={form.country} onChange={(e) => set('country', e.target.value)} /></Field>
            <Field label="Sales person">
              <input className={INPUT} list="zd-sales-members" value={form.salesPerson} onChange={(e) => set('salesPerson', e.target.value)} />
              <datalist id="zd-sales-members">{members.map((m) => <option key={m} value={m} />)}</datalist>
            </Field>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold">Order</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {mine.length > 1 && (
              <Field label="Ledger" className="sm:col-span-2">
                <select className={SELECT} value={form.stream} onChange={(e) => set('stream', e.target.value as SalesStream)}>
                  {mine.map((k) => <option key={k} value={k}>{streams.find((x) => x.key === k)?.short ?? k}</option>)}
                </select>
              </Field>
            )}
            <Field label="Reference or order number"><input className={INPUT} value={form.reference} onChange={(e) => set('reference', e.target.value)} /></Field>
            <Field label="Order date"><input className={`${INPUT} tabular-nums`} type="date" value={form.orderDate} onChange={(e) => set('orderDate', e.target.value)} /></Field>
            <Field label="Product" className="sm:col-span-2"><input className={INPUT} value={form.product} onChange={(e) => set('product', e.target.value)} /></Field>
            <Field label="Size"><input className={INPUT} value={form.size} onChange={(e) => set('size', e.target.value)} /></Field>
            <Field label="Material"><input className={INPUT} value={form.material} onChange={(e) => set('material', e.target.value)} /></Field>
            <Field label="Printing"><input className={INPUT} value={form.printing} onChange={(e) => set('printing', e.target.value)} /></Field>
            <Field label="Quantity"><input className={INPUT} value={form.quantity} onChange={(e) => set('quantity', e.target.value)} placeholder="1,000" /></Field>
            <div>
              <span className={LABEL}>Order amount (required)</span>
              <div className="flex gap-2">
                <select className={`${SELECT} !w-24 shrink-0`} value={form.currency} onChange={(e) => set('currency', e.target.value as SaleCurrency)} aria-label="Order currency">
                  {SALE_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={form.orderAmount} onChange={(e) => set('orderAmount', e.target.value)} placeholder="0.00" aria-label="Order amount" />
              </div>
            </div>
            {form.currency !== 'PKR' && (
              <Field label={`Agreed rate (PKR per ${form.currency})`}>
                <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} placeholder="Only if the deal fixed one" />
              </Field>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center">
            <h3 className="text-[13px] font-semibold">Payments received</h3>
            <button type="button" className={`${BTN_PLAIN} ml-auto`} onClick={() => set('payments', [...form.payments, {
              id: newId('pay'), date: today(), amount: live.outstanding > 0 ? String(live.outstanding) : '', fee: '', method: 'paypal', rate: '', note: '',
            }])}><Plus size={14} aria-hidden />Add payment</button>
          </div>
          {form.payments.length === 0 && <p className="text-[12px] text-[#68737d]">No payment yet, so the sale shows as Pending.</p>}
          {form.payments.map((p) => (
            <div key={p.id} className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] p-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Date"><input className={`${INPUT} tabular-nums`} type="date" value={p.date} onChange={(e) => setPay(p.id, { date: e.target.value })} /></Field>
              <Field label={`Amount (${form.currency})`}><input className={`${INPUT} tabular-nums`} inputMode="decimal" value={p.amount} onChange={(e) => setPay(p.id, { amount: e.target.value })} /></Field>
              <Field label="Fee"><input className={`${INPUT} tabular-nums`} inputMode="decimal" value={p.fee} onChange={(e) => setPay(p.id, { fee: e.target.value })} placeholder="0" /></Field>
              <Field label="Method">
                <select className={SELECT} value={p.method} onChange={(e) => setPay(p.id, { method: e.target.value as PaymentMethod })}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                </select>
              </Field>
              {form.currency !== 'PKR' && (
                <Field label={`Rate (PKR per ${form.currency})`}>
                  <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={p.rate} onChange={(e) => setPay(p.id, { rate: e.target.value })} placeholder={todayRate ? `today ${todayRate}` : ''} />
                </Field>
              )}
              <Field label="Note" className={form.currency !== 'PKR' ? 'col-span-1 sm:col-span-2' : 'col-span-2 sm:col-span-3'}>
                <input className={INPUT} value={p.note} onChange={(e) => setPay(p.id, { note: e.target.value })} placeholder="Invoice or transaction number" />
              </Field>
              <div className="flex items-end justify-end">
                <button type="button" className={BTN_PLAIN} aria-label="Remove this payment" onClick={() => set('payments', form.payments.filter((x) => x.id !== p.id))}><Trash2 size={14} aria-hidden />Remove</button>
              </div>
            </div>
          ))}
        </section>

        <section className="space-y-3">
          <div className="flex items-center">
            <h3 className="text-[13px] font-semibold">Costs</h3>
            <button type="button" className={`${BTN_PLAIN} ml-auto`} onClick={() => set('costs', [...form.costs, { id: newId('cost'), label: form.costs.length ? '' : 'Production', amount: '', currency: 'PKR', rate: '', note: '' }])}>
              <Plus size={14} aria-hidden />Add cost
            </button>
          </div>
          {form.costs.length === 0 && <p className="text-[12px] text-[#68737d]">No costs yet. Add the production cost to see the profit.</p>}
          {form.costs.map((c) => (
            <div key={c.id} className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] p-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="What"><input className={INPUT} value={c.label} onChange={(e) => setCost(c.id, { label: e.target.value })} placeholder="Production, shipping" /></Field>
              <Field label="Amount"><input className={`${INPUT} tabular-nums`} inputMode="decimal" value={c.amount} onChange={(e) => setCost(c.id, { amount: e.target.value })} /></Field>
              <Field label="Currency">
                <select className={SELECT} value={c.currency} onChange={(e) => setCost(c.id, { currency: e.target.value as SaleCurrency })}>
                  {SALE_CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </Field>
              {c.currency !== 'PKR'
                ? <Field label="Rate (PKR)"><input className={`${INPUT} tabular-nums`} inputMode="decimal" value={c.rate} onChange={(e) => setCost(c.id, { rate: e.target.value })} placeholder={rates?.[c.currency] ? `today ${rates[c.currency]}` : ''} /></Field>
                : <div className="hidden sm:block" />}
              <Field label="Note" className="col-span-2 sm:col-span-3"><input className={INPUT} value={c.note} onChange={(e) => setCost(c.id, { note: e.target.value })} /></Field>
              <div className="flex items-end justify-end">
                <button type="button" className={BTN_PLAIN} aria-label="Remove this cost" onClick={() => set('costs', form.costs.filter((x) => x.id !== c.id))}><Trash2 size={14} aria-hidden />Remove</button>
              </div>
            </div>
          ))}
          <div>
            <span className={LABEL}>Agreed profit, only when the deal states one</span>
            <div className="flex gap-2">
              <select className={`${SELECT} !w-24 shrink-0`} value={form.profitCurrency} onChange={(e) => set('profitCurrency', e.target.value as SaleCurrency)} aria-label="Profit currency">
                {SALE_CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={form.profitAmount} onChange={(e) => set('profitAmount', e.target.value)} placeholder="Leave empty to work it out from the costs" aria-label="Agreed profit" />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-[13px] font-semibold">Status and delivery</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Payment status">
              <select className={SELECT} value={form.statusOverride} onChange={(e) => set('statusOverride', e.target.value as SaleForm['statusOverride'])}>
                <option value="">Automatic: {PAYMENT_STATUS_LABEL[auto]}</option>
                <option value="refunded">Refunded</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </Field>
            <Field label="Production">
              <select className={SELECT} value={form.production} onChange={(e) => {
                const next = e.target.value as SaleForm['production']
                // The day it left is stamped the first time it is marked shipped.
                setForm((f) => ({ ...f, production: next, shippedAt: next === 'shipped' && !f.shippedAt ? today() : f.shippedAt }))
              }}>
                <option value="">Not recorded</option>
                {PRODUCTION_STATUSES.map((s) => <option key={s} value={s}>{PRODUCTION_LABEL[s]}</option>)}
              </select>
            </Field>
            <Field label="Tracking number"><input className={`${INPUT} tabular-nums`} value={form.tracking} onChange={(e) => set('tracking', e.target.value)} /></Field>
            <Field label="Shipped on"><input className={`${INPUT} tabular-nums`} type="date" value={form.shippedAt} onChange={(e) => set('shippedAt', e.target.value)} /></Field>
            <Field label="Owed by, if not the customer"><input className={INPUT} value={form.counterparty} onChange={(e) => set('counterparty', e.target.value)} /></Field>
            <Field label="Source"><input className={INPUT} value={form.source} onChange={(e) => set('source', e.target.value)} placeholder="How the sale came about" /></Field>
            <Field label="Notes" className="sm:col-span-2"><textarea className={TEXTAREA} rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
          </div>
        </section>
      </form>
    </Drawer>
  )
}

/** One payment against an existing sale, without opening the whole form. */
function PaymentDrawer({ view, rates, onClose, onSaved }: { view: SaleView; rates: PkrRates | null; onClose: () => void; onSaved: () => void }) {
  const { sale: s, fig: f } = view
  const [pay, setPay] = useState<PayForm>({ id: newId('pay'), date: today(), amount: f.outstanding > 0 ? String(f.outstanding) : '', fee: '', method: 'paypal', rate: '', note: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (patch: Partial<PayForm>) => setPay((p) => ({ ...p, ...patch }))
  const next = formFromSale(s)
  const after = figures(saleFromForm({ ...next, payments: [...next.payments, pay] }, s.workspace), rates)
  const todayRate = rates?.[s.currency]

  async function save() {
    const amount = parseAmount(pay.amount)
    if (!amount) { setErr('Enter the amount that arrived.'); return }
    if ((parseAmount(pay.fee) ?? 0) > amount) { setErr('A payment fee cannot be larger than the payment.'); return }
    setBusy(true); setErr('')
    const r = await send('/api/sales', postJson({ sale: payloadOf({ ...next, payments: [...next.payments, pay] }) }), 'That did not save.')
    setBusy(false)
    if (r.ok) onSaved(); else setErr(r.error)
  }

  return (
    <Drawer title={`Record a payment: ${s.customer}`} onClose={onClose}
      footer={<>
        <button type="button" className={BTN_PLAIN} onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save payment'}</button>
      </>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] px-3 py-2.5 text-[13px]">
          <p className="font-medium">{[s.reference, s.product].filter(Boolean).join(' · ') || 'Order'}</p>
          <p className="text-[12px] text-[#68737d] tabular-nums">Order {money(s.orderAmount, s.currency)} · paid {money(f.received, s.currency)} · balance {money(f.outstanding, s.currency)}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><input className={`${INPUT} tabular-nums`} type="date" value={pay.date} onChange={(e) => set({ date: e.target.value })} /></Field>
          <Field label="Method">
            <select className={SELECT} value={pay.method} onChange={(e) => set({ method: e.target.value as PaymentMethod })}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
            </select>
          </Field>
          <Field label={`Amount (${s.currency})`}><input className={`${INPUT} tabular-nums`} inputMode="decimal" value={pay.amount} onChange={(e) => set({ amount: e.target.value })} autoFocus /></Field>
          <Field label="Fee"><input className={`${INPUT} tabular-nums`} inputMode="decimal" value={pay.fee} onChange={(e) => set({ fee: e.target.value })} placeholder="0" /></Field>
          {s.currency !== 'PKR' && (
            <Field label={`Rate (PKR per ${s.currency})`} className="col-span-2">
              <input className={`${INPUT} tabular-nums`} inputMode="decimal" value={pay.rate} onChange={(e) => set({ rate: e.target.value })} placeholder={todayRate ? `Leave empty until it is withdrawn (today ${todayRate})` : 'Leave empty until it is withdrawn'} />
            </Field>
          )}
          <Field label="Note" className="col-span-2"><input className={INPUT} value={pay.note} onChange={(e) => set({ note: e.target.value })} placeholder="Invoice or transaction number" /></Field>
        </div>
        <p className="text-[12px] text-[#68737d] tabular-nums">After this payment: {PAYMENT_STATUS_LABEL[after.status]}, balance {money(after.outstanding, s.currency)}.</p>
        {err && <Notice text={err} bad />}
      </form>
    </Drawer>
  )
}

// ── Payouts: withdrawals that turned the order currency into rupees ─────────

type PayoutRow = Payout & { rate: number | null }

function Payouts({ onChanged }: { onChanged: () => void }) {
  const blank = () => ({ date: today(), route: 'paypal' as PayoutRoute, currency: 'USD' as SaleCurrency, amountOut: '', gbpReceived: '', pkrReceived: '', note: '' })
  const [rows, setRows] = useState<PayoutRow[] | null>(null)
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>({ text: '' })
  const [confirmId, setConfirmId] = useState('')

  const load = useCallback(async () => {
    const j = await fetch('/api/sales/payouts').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (j) setRows(j.payouts ?? []); else setMsg({ text: 'The payouts could not be loaded.', bad: true })
  }, [])
  useEffect(() => { const first = setTimeout(load, 0); return () => clearTimeout(first) }, [load])

  const out = parseAmount(form.amountOut), pkr = parseAmount(form.pkrReceived)
  const preview = out && pkr ? Math.round((pkr / out) * 100) / 100 : null
  const set = <K extends keyof ReturnType<typeof blank>>(k: K, v: ReturnType<typeof blank>[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setBusy(true); setMsg({ text: '' })
    const r = await send('/api/sales/payouts', postJson({ payout: form }), 'That did not save.')
    setBusy(false)
    if (!r.ok) { setMsg({ text: r.error, bad: true }); return }
    const n = Number(r.data.lockedPayments ?? 0)
    const saved = (r.data.payout ?? {}) as Partial<PayoutRow>
    setMsg({ text: n
      ? `Saved. Rs ${saved.rate} per ${form.currency} is now locked onto ${n} payment${n === 1 ? '' : 's'}.${(saved.leftover ?? 0) > 0.5 ? ` ${money(saved.leftover ?? 0, form.currency)} of this withdrawal is not matched to a payment yet.` : ''}`
      : 'Saved. No unsettled payment on this route fits inside this withdrawal, so no rate was locked.' })
    setForm({ ...blank(), route: form.route })
    await load(); onChanged()
  }

  async function remove(id: string) {
    setBusy(true); setMsg({ text: '' })
    const r = await send(`/api/sales/payouts?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, 'That did not delete.')
    setBusy(false); setConfirmId('')
    if (!r.ok) { setMsg({ text: r.error, bad: true }); return }
    await load(); onChanged()
  }

  return (
    <>
      <form className={`${CARD} p-4 space-y-3`} onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div>
          <h2 className="text-[15px] font-semibold">Record a payout</h2>
          <p className="text-[12px] text-[#68737d]">Each time money is withdrawn, enter what left the payment service and what landed in the bank. That rate is locked onto the oldest unsettled payments on the same route, so their profit stops being an estimate.</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Field label="Landed on"><input type="date" className={`${INPUT} tabular-nums`} value={form.date} onChange={(e) => set('date', e.target.value)} required /></Field>
          <Field label="Route" className="lg:col-span-2">
            <select className={SELECT} value={form.route} onChange={(e) => set('route', e.target.value as PayoutRoute)}>
              {PAYOUT_ROUTES.map((r) => <option key={r} value={r}>{PAYOUT_ROUTE_LABEL[r]}</option>)}
            </select>
          </Field>
          <Field label="Currency">
            <select className={SELECT} value={form.currency} onChange={(e) => set('currency', e.target.value as SaleCurrency)}>
              {SALE_CURRENCIES.filter((c) => c !== 'PKR').map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Withdrawn"><input inputMode="decimal" className={`${INPUT} tabular-nums`} value={form.amountOut} onChange={(e) => set('amountOut', e.target.value)} placeholder="2500" required /></Field>
          <Field label="PKR in bank"><input inputMode="decimal" className={`${INPUT} tabular-nums`} value={form.pkrReceived} onChange={(e) => set('pkrReceived', e.target.value)} placeholder="690000" required /></Field>
          {(form.route === 'paypal' || form.route === 'payoneer') && (
            <Field label="GBP received (optional)"><input inputMode="decimal" className={`${INPUT} tabular-nums`} value={form.gbpReceived} onChange={(e) => set('gbpReceived', e.target.value)} /></Field>
          )}
          <Field label="Note" className="col-span-2 lg:col-span-3"><input className={INPUT} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Transfer number" /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={BTN_PRIMARY} disabled={busy}>Save payout</button>
          <p className="text-[12px] text-[#68737d] tabular-nums">{preview ? `Effective rate Rs ${preview} per ${form.currency}` : 'The rate appears once both amounts are in.'}</p>
          <Notice text={msg.text} bad={msg.bad} />
        </div>
      </form>

      {rows === null ? <p className="text-[13px] text-[#68737d]">Loading the payouts…</p>
        : rows.length === 0 ? <Empty text="No payouts recorded yet. Record the first withdrawal when it lands and the matching payments lock to its rate." />
        : (
          <Table head={['Landed', 'Route', 'Withdrawn', 'GBP', 'PKR in bank', 'Rate', 'Locked', 'Note', '']}>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-[#e9ebed]">
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{shortDate(p.date)}</td>
                <td className={`${CELL} text-[#49545c]`}>{PAYOUT_ROUTE_LABEL[p.route]}</td>
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{money(p.amountOut, p.currency)}</td>
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{p.gbpReceived ? money(p.gbpReceived, 'GBP') : 'None'}</td>
                <td className={`${CELL} tabular-nums font-medium text-[#2f3941]`}>{money(p.pkrReceived, 'PKR')}</td>
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{p.rate ? `Rs ${p.rate}` : 'None'}</td>
                <td className={`${CELL} text-[#49545c]`}>
                  {p.settled.length} payment{p.settled.length === 1 ? '' : 's'}
                  {p.leftover > 0.5 && <p className="text-[12px] text-[#ad5918] tabular-nums">{money(p.leftover, p.currency)} unmatched</p>}
                </td>
                <td className="px-4 py-2.5 align-top max-w-[240px] truncate text-[#49545c]" title={p.note}>{p.note}</td>
                <td className={`${CELL} text-right`}>
                  {confirmId === p.id ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-[12px] text-[#2f3941]" role="alert">Its {p.settled.length} payment{p.settled.length === 1 ? '' : 's'} go back to an estimate.</span>
                      <button type="button" className={`${BTN_PLAIN} !h-7 !px-2 !text-[12px]`} onClick={() => setConfirmId('')} disabled={busy}>Keep</button>
                      <button type="button" className={`${BTN_DANGER} !h-7 !px-2 !text-[12px]`} onClick={() => remove(p.id)} disabled={busy}>Delete</button>
                    </span>
                  ) : <button type="button" className={`${BTN_PLAIN} !h-7 !px-2 !text-[12px]`} onClick={() => setConfirmId(p.id)} disabled={busy} aria-label={`Delete the payout of ${shortDate(p.date)}`}><Trash2 size={13} aria-hidden /></button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
    </>
  )
}

// ── Expenses: money no single order owns ────────────────────────────────────

type ExpenseRow = Expense & { pkr: { value: number; estimated: boolean; missing: boolean } }

function Expenses({ month, monthProfitPkr }: {
  /** The month the Sales tab is narrowed to; this list follows it. */
  month: string
  /** Sales profit (PKR) of that month, to show what is left after expenses. */
  monthProfitPkr: number | null
}) {
  const blank = () => ({ date: today(), month: today().slice(0, 7), category: 'salary' as ExpenseCategory, payee: '', amount: '', currency: 'PKR' as SaleCurrency, rate: '', note: '' })
  const [rows, setRows] = useState<ExpenseRow[] | null>(null)
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean }>({ text: '' })
  const [confirmId, setConfirmId] = useState('')

  const load = useCallback(async () => {
    const j = await fetch('/api/sales/expenses').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (j) setRows(j.expenses ?? []); else setMsg({ text: 'The expenses could not be loaded.', bad: true })
  }, [])
  useEffect(() => { const first = setTimeout(load, 0); return () => clearTimeout(first) }, [load])

  const shown = useMemo(() => (rows ?? []).filter((e) => !month || e.month === month), [rows, month])
  const total = Math.round(shown.reduce((a, e) => a + e.pkr.value, 0))
  const estimated = shown.some((e) => e.pkr.estimated || e.pkr.missing)
  const byCategory = useMemo(() => {
    const m = new Map<ExpenseCategory, number>()
    for (const e of shown) m.set(e.category, (m.get(e.category) ?? 0) + e.pkr.value)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [shown])
  const set = <K extends keyof ReturnType<typeof blank>>(k: K, v: ReturnType<typeof blank>[K]) => setForm((f) => ({ ...f, [k]: v }))
  const net = month && monthProfitPkr !== null ? monthProfitPkr - total : null

  async function save() {
    setBusy(true); setMsg({ text: '' })
    const r = await send('/api/sales/expenses', postJson({ expense: form }), 'That did not save.')
    setBusy(false)
    if (!r.ok) { setMsg({ text: r.error, bad: true }); return }
    setForm((f) => ({ ...f, payee: '', amount: '', note: '' }))
    setMsg({ text: 'Saved.' })
    await load()
  }

  async function remove(id: string) {
    setBusy(true); setMsg({ text: '' })
    const r = await send(`/api/sales/expenses?id=${encodeURIComponent(id)}`, { method: 'DELETE' }, 'That did not delete.')
    setBusy(false); setConfirmId('')
    if (!r.ok) { setMsg({ text: r.error, bad: true }); return }
    await load()
  }

  return (
    <>
      <form className={`${CARD} p-4 space-y-3`} onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div>
          <h2 className="text-[15px] font-semibold">Add an expense</h2>
          <p className="text-[12px] text-[#68737d]">Salaries, the office and supplier payments: one line per payment, filed under the month it belongs to.</p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Field label="Paid on"><input type="date" className={`${INPUT} tabular-nums`} value={form.date} required
            onChange={(e) => setForm((f) => ({ ...f, date: e.target.value, month: e.target.value.length >= 7 ? e.target.value.slice(0, 7) : f.month }))} /></Field>
          <Field label="For month"><input type="month" className={`${INPUT} tabular-nums`} value={form.month} onChange={(e) => set('month', e.target.value)} required /></Field>
          <Field label="Kind">
            <select className={SELECT} value={form.category} onChange={(e) => set('category', e.target.value as ExpenseCategory)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)}
            </select>
          </Field>
          <Field label="Paid to" className="col-span-2 lg:col-span-3"><input className={INPUT} value={form.payee} onChange={(e) => set('payee', e.target.value)} placeholder="A person, the office rent, a supplier" required /></Field>
          <Field label="Amount"><input inputMode="decimal" className={`${INPUT} tabular-nums`} value={form.amount} onChange={(e) => set('amount', e.target.value)} required /></Field>
          <Field label="Currency">
            <select className={SELECT} value={form.currency} onChange={(e) => set('currency', e.target.value as SaleCurrency)}>
              {SALE_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          {form.currency !== 'PKR' && (
            <Field label={`Rate (PKR per ${form.currency})`}><input inputMode="decimal" className={`${INPUT} tabular-nums`} value={form.rate} onChange={(e) => set('rate', e.target.value)} /></Field>
          )}
          <Field label="Note" className="col-span-2 lg:col-span-3"><input className={INPUT} value={form.note} onChange={(e) => set('note', e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={BTN_PRIMARY} disabled={busy}>Save expense</button>
          <Notice text={msg.text} bad={msg.bad} />
        </div>
      </form>

      {rows !== null && shown.length > 0 && (
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
          <span className="font-semibold tabular-nums">{month ? monthLabel(month) : 'All months'}: {money(total, 'PKR')}{estimated ? ' est.' : ''}</span>
          {byCategory.map(([c, v]) => <span key={c} className="text-[#68737d] tabular-nums">{EXPENSE_CATEGORY_LABEL[c]} {money(Math.round(v), 'PKR')}</span>)}
          {net !== null && <span className={`ml-auto font-semibold tabular-nums ${net >= 0 ? 'text-[#038153]' : 'text-[#cc3340]'}`}>Sales profit after expenses {money(Math.round(net), 'PKR')}</span>}
        </p>
      )}

      {rows === null ? <p className="text-[13px] text-[#68737d]">Loading the expenses…</p>
        : shown.length === 0 ? <Empty text={month ? `No expenses for ${monthLabel(month)}. Change the period at the top to see other months.` : 'No expenses recorded yet.'} />
        : (
          <Table head={['Paid', 'Month', 'Kind', 'Paid to', 'Amount', 'PKR', 'Note', '']}>
            {shown.map((e) => (
              <tr key={e.id} className="border-t border-[#e9ebed]">
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{shortDate(e.date)}</td>
                <td className={`${CELL} text-[#49545c]`}>{monthLabel(e.month)}</td>
                <td className={`${CELL} text-[#49545c]`}>{EXPENSE_CATEGORY_LABEL[e.category]}</td>
                <td className="px-4 py-2.5 align-top max-w-[260px] truncate font-medium text-[#2f3941]">{e.payee}</td>
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{money(e.amount, e.currency)}</td>
                <td className={`${CELL} tabular-nums text-[#49545c]`}>{e.pkr.missing ? <span className="text-[#ad5918]">needs a rate</span> : `${money(Math.round(e.pkr.value), 'PKR')}${e.pkr.estimated ? ' est.' : ''}`}</td>
                <td className="px-4 py-2.5 align-top max-w-[240px] truncate text-[#49545c]" title={e.note}>{e.note}</td>
                <td className={`${CELL} text-right`}>
                  {confirmId === e.id ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-[12px] text-[#2f3941]" role="alert">Delete this expense?</span>
                      <button type="button" className={`${BTN_PLAIN} !h-7 !px-2 !text-[12px]`} onClick={() => setConfirmId('')} disabled={busy}>Keep</button>
                      <button type="button" className={`${BTN_DANGER} !h-7 !px-2 !text-[12px]`} onClick={() => remove(e.id)} disabled={busy}>Delete</button>
                    </span>
                  ) : <button type="button" className={`${BTN_PLAIN} !h-7 !px-2 !text-[12px]`} onClick={() => setConfirmId(e.id)} disabled={busy} aria-label={`Delete the expense paid to ${e.payee}`}><Trash2 size={13} aria-hidden /></button>}
                </td>
              </tr>
            ))}
          </Table>
        )}
    </>
  )
}
