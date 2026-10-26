'use client'

// Sales — /sales.
//
// One ledger per business, three streams, and a master view for the owner:
//   packaging  → Model Town Direct · Hamdan — Partner Orders
//   sports     → Sports Jerseys
//   owners     → Master: all three side by side, then combined
//
// Every figure on this page comes from lib/salescore.ts — the same code the
// server totals with and the CSV export uses — so the editor's live numbers,
// the cards and the spreadsheet cannot disagree.
//
// Admins only (the API refuses everyone else). The master view is read-only:
// a sale is edited on its own business's dashboard.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Plus, Download, X, Trash2, TriangleAlert, Receipt, Wallet, Search,
  ExternalLink, Lock, LayoutGrid,
} from 'lucide-react'
import type { Workspace } from '@/lib/workspaces'
import { WORKSPACE_LABEL } from '@/lib/workspaces'
import { SITE_DOMAINS } from '@/lib/sitedomains'
import {
  STREAMS, STREAM_ORDER, SALE_CURRENCIES, PAYMENT_METHODS, PAYMENT_METHOD_LABEL,
  PRODUCTION_STATUSES, PRODUCTION_LABEL, PAYMENT_STATUS_LABEL, PAYMENT_STATUS_STYLE,
  SALE_LEAD_KIND_LABEL, SALE_LEAD_KIND_ORDER, type SaleLeadKind,
  figures, totals, money, shortDate, newId, parseAmount,
  type Sale, type SaleView, type StreamInfo, type StreamTotals, type SalesStream,
  type RateInfo, type SaleCurrency, type PaymentMethod, type ProductionStatus,
} from '@/lib/salescore'
import { Card, Skeleton, EmptyState } from '@/app/leads/[id]/ui'
import GlobalSearch from '@/app/components/GlobalSearch'
import { PayoutsCard, ExpensesCard, NetProfitCard } from './money'

interface Payload {
  scope: string
  workspace: Workspace
  owner: boolean
  streams: StreamInfo[]
  sales: SaleView[]
  totals: Record<string, StreamTotals>
  all: StreamTotals
  rates: RateInfo | null
  members: string[]
}

type Tab = 'master' | SalesStream

// ── Form state — numbers stay strings until they are saved ─────────────────
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
  salesPerson: string; source: string; counterparty: string
  leadId: string
  notes: string
}

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date())
const str = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n))

function blankForm(stream: SalesStream): SaleForm {
  return {
    id: '', stream, reference: '',
    customer: '', company: '', email: '', phone: '', country: '',
    orderDate: todayKey(),
    product: '', size: '', material: '', printing: '', quantity: '',
    currency: 'USD', orderAmount: '', rate: '', profitAmount: '', profitCurrency: 'PKR',
    payments: [], costs: [],
    statusOverride: '', production: '',
    salesPerson: '', source: stream === 'pk_partner' ? 'Old lead-selling arrangement' : '',
    counterparty: stream === 'pk_partner' ? 'Hamdan' : '', leadId: '', notes: '',
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
    salesPerson: s.salesPerson, source: s.source, counterparty: s.counterparty,
    leadId: s.leadId ?? '', notes: s.notes,
  }
}

/** The form as a Sale, for live figures — same parsing the server applies. */
function saleFromForm(f: SaleForm, ws: Workspace): Sale {
  return {
    id: f.id || 'draft', stream: f.stream, workspace: ws, reference: f.reference,
    customer: f.customer, company: f.company, email: f.email, phone: f.phone, country: f.country,
    orderDate: f.orderDate, product: f.product, size: f.size, material: f.material, printing: f.printing,
    quantity: f.quantity, currency: f.currency, orderAmount: parseAmount(f.orderAmount) ?? 0,
    rate: f.currency === 'PKR' ? null : parseAmount(f.rate),
    agreedProfit: parseAmount(f.profitAmount) ? { amount: parseAmount(f.profitAmount)!, currency: f.profitCurrency } : null,
    payments: f.payments
      .map((p) => ({ id: p.id, date: p.date, amount: parseAmount(p.amount) ?? 0, fee: parseAmount(p.fee) ?? 0, method: p.method, rate: f.currency === 'PKR' ? null : parseAmount(p.rate), note: p.note }))
      .filter((p) => p.amount > 0),
    costs: f.costs
      .map((c) => ({ id: c.id, label: c.label, amount: parseAmount(c.amount) ?? 0, currency: c.currency, rate: c.currency === 'PKR' ? null : parseAmount(c.rate), note: c.note }))
      .filter((c) => c.amount > 0),
    statusOverride: f.statusOverride || null,
    production: f.production || null,
    salesPerson: f.salesPerson, source: f.source, counterparty: f.counterparty,
    leadId: f.leadId || null, notes: f.notes,
    createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
  }
}

const INPUT_BASE = 'rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10'
const INPUT = `mt-1 w-full ${INPUT_BASE}`
// For a control sharing a row with another: no w-full, which would win over
// any width given next to it and squeeze its neighbour to nothing.
const INLINE = `min-w-0 ${INPUT_BASE}`
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500'
const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40'

export default function SalesPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab | null>(null)
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<SaleFilters>(NO_FILTERS)
  const [editing, setEditing] = useState<SaleForm | null>(null)
  const [viewing, setViewing] = useState<SaleView | null>(null)
  const [expVersion, setExpVersion] = useState(0)

  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode */ }
  }, [])

  const load = useCallback(async (): Promise<Payload | null> => {
    // An owner reads the master ledger, which already holds their own
    // workspace's streams; everyone else reads their own workspace.
    const me = await fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!me) { window.location.href = '/login'; return null }
    const tryMaster = await fetch('/api/sales?scope=master')
    const res = tryMaster.status === 403 ? await fetch('/api/sales') : tryMaster
    if (res.status === 401) { window.location.href = '/login'; return null }
    if (res.status === 403) { setStatus('forbidden'); return null }
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || 'Could not load sales.')
      setStatus('error')
      return null
    }
    const j = (await res.json()) as Payload
    setData(j)
    setStatus('ok')
    setError('')
    return j
  }, [])

  // First load, plus the deep links the rest of the dashboard uses:
  // ?new=1&lead=<id> from a won lead, ?sale=<id> to open one.
  useEffect(() => {
    let alive = true
    void (async () => {
      const j = await load()
      if (!alive || !j) return
      setTab((t) => t ?? (j.owner ? 'master' : j.streams[0]?.key ?? null))
      const qs = new URLSearchParams(window.location.search)
      const saleId = qs.get('sale')
      const lead = qs.get('lead')
      if (saleId) {
        const v = j.sales.find((x) => x.sale.id === saleId)
        if (v) openSale(v, j)
      } else if (qs.get('new') === '1') {
        const mine = STREAM_ORDER.filter((k) => STREAMS[k].workspace === j.workspace)
        if (lead) {
          const r = await fetch(`/api/sales/prefill?lead=${encodeURIComponent(lead)}`)
          const p = await r.json().catch(() => ({}))
          if (!alive) return
          if (p.existingId) {
            const v = j.sales.find((x) => x.sale.id === p.existingId)
            if (v) openSale(v, j)
          } else if (p.draft) {
            const d = p.draft as Record<string, unknown>
            setEditing({
              ...blankForm(mine.includes(d.stream as SalesStream) ? (d.stream as SalesStream) : mine[0]),
              leadId: String(d.leadId ?? ''), customer: String(d.customer ?? ''), company: String(d.company ?? ''),
              email: String(d.email ?? ''), phone: String(d.phone ?? ''), country: String(d.country ?? ''),
              orderDate: String(d.orderDate ?? todayKey()), product: String(d.product ?? ''),
              quantity: String(d.quantity ?? ''), orderAmount: String(d.orderAmount ?? ''),
              currency: (SALE_CURRENCIES as readonly string[]).includes(String(d.currency)) ? (d.currency as SaleCurrency) : 'USD',
              salesPerson: String(d.salesPerson ?? ''), source: String(d.source ?? ''), notes: String(d.notes ?? ''),
            })
          } else {
            setError(String(p.error || 'That lead could not be turned into a sale.'))
          }
        } else if (mine[0]) {
          setEditing(blankForm(mine[0]))
        }
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  function openSale(v: SaleView, j: Payload | null = data) {
    if (j && v.sale.workspace === j.workspace) setEditing(formFromSale(v.sale))
    else setViewing(v)
  }

  const tabs: Tab[] = useMemo(() => {
    if (!data) return []
    return data.owner ? ['master', ...STREAM_ORDER] : data.streams.map((s) => s.key)
  }, [data])

  // Everything on this tab, before search and filters — the filter menus list
  // what is actually here, so a website or agent with no sales never appears.
  const tabRows = useMemo(() => {
    if (!data || !tab) return []
    return data.sales.filter((v) => tab === 'master' || v.sale.stream === tab)
  }, [data, tab])

  const filterOptions = useMemo(() => filterOptionsFor(tabRows), [tabRows])

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return tabRows
      .filter((v) => matchesFilters(v, filters))
      .filter((v) => !q || [v.sale.customer, v.sale.company, v.sale.reference, v.sale.product, v.sale.email]
        .some((x) => x.toLowerCase().includes(q)))
  }, [tabRows, filters, search])

  const narrowed = !!search.trim() || filtersActive(filters)
  // The totals cards follow the filter: "this month on thepapercups.com" is a
  // question people ask of the ledger, and the answer is the same arithmetic
  // over fewer rows. Unfiltered, the server's figures are used unchanged.
  const narrowedTotals = useMemo(
    () => (narrowed && data ? totals(rows, data.rates?.rates ?? null) : null),
    [narrowed, rows, data],
  )

  // A tab switch drops the filters: the menus are built from that tab's rows,
  // and a website picked on one stream usually means nothing on the next.
  const pickTab = (k: Tab) => { setTab(k); setFilters(NO_FILTERS) }

  const canAddHere = !!data && (tab === 'master' || (tab !== null && STREAMS[tab].workspace === data.workspace))
  const exportHref = tab === 'master'
    ? '/api/sales/export?scope=master'
    : `/api/sales/export?${data?.owner ? 'scope=master&' : ''}stream=${tab ?? ''}`

  if (status === 'loading') return <PageShell><LoadingState /></PageShell>
  if (status === 'forbidden') {
    return (
      <PageShell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <Lock className="mx-auto w-6 h-6 text-gray-400" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">Sales are for admins only</p>
          <p className="mt-1 text-xs text-gray-500">Order value, production cost and profit are kept to the admins of each business.</p>
          <Link href="/" className="mt-4 inline-block text-xs font-semibold text-blue-700 hover:underline">Back to the dashboard</Link>
        </div>
      </PageShell>
    )
  }
  if (status === 'error' || !data || !tab) {
    return (
      <PageShell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <TriangleAlert className="mx-auto w-6 h-6 text-red-500" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">{error || 'Could not load sales.'}</p>
          <button type="button" onClick={() => { setStatus('loading'); void load() }} className={`${BTN} mt-4 bg-gray-900 text-white hover:bg-gray-800`}>Try again</button>
        </div>
      </PageShell>
    )
  }

  const t = narrowedTotals ?? (tab === 'master' ? data.all : data.totals[tab])
  const mineFirst = STREAM_ORDER.find((k) => STREAMS[k].workspace === data.workspace)

  return (
    <PageShell
      subtitle={data.owner ? 'Master view · all businesses' : WORKSPACE_LABEL[data.workspace]}
      actions={
        <>
          <a href={exportHref} className={`${BTN} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}>
            <Download className="w-3.5 h-3.5" aria-hidden />Export CSV
          </a>
          {canAddHere && mineFirst && (
            <button type="button"
              onClick={() => setEditing(blankForm(tab !== 'master' && STREAMS[tab].workspace === data.workspace ? tab : mineFirst))}
              className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>
              <Plus className="w-3.5 h-3.5" aria-hidden />New sale
            </button>
          )}
        </>
      }>
      {error && <p role="alert" className="mb-3 text-xs font-medium text-red-700">{error}</p>}

      {/* Streams — one tab each; the master tab only for the owner accounts. */}
      <nav className="flex flex-wrap gap-1.5 mb-4" aria-label="Sales streams">
        {tabs.map((k) => {
          const on = k === tab
          const label = k === 'master' ? 'Master' : STREAMS[k].short
          const n = k === 'master' ? data.all.orders : data.totals[k]?.orders ?? 0
          return (
            <button key={k} type="button" onClick={() => pickTab(k)} aria-pressed={on}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
              {k === 'master' && <LayoutGrid className="w-3.5 h-3.5" aria-hidden />}
              {label}
              <span className={`tabular-nums rounded-full px-1.5 text-[10px] ${on ? 'bg-white/20' : 'bg-gray-100 text-gray-600'}`}>{n}</span>
            </button>
          )
        })}
      </nav>

      {tab !== 'master' && <p className="-mt-2 mb-3 text-xs text-gray-500">{STREAMS[tab].blurb}</p>}

      {/* Month at a glance (owner, 2026-10-26: "sirf Oct ki sale dekh sakon").
          The same Month filter the table has, lifted to where the totals are. */}
      {filterOptions.months.length > 0 && (
        <div role="group" aria-label="Show totals for a month" className="mb-3 flex flex-wrap items-center gap-1.5">
          {[{ value: '', label: 'All time', n: tabRows.length }, ...filterOptions.months].map((m) => {
            const on = filters.month === m.value
            return (
              <button key={m.value || 'all'} type="button" onClick={() => setFilters({ ...filters, month: m.value })}
                className={`rounded-full border px-3 py-1 text-xs font-semibold ${on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                {m.label} <span className={on ? 'text-white/80' : 'text-gray-500'}>({m.n})</span>
              </button>
            )
          })}
        </div>
      )}

      <TotalsGrid t={t} picked={filters.status} pick={(status) => {
        setFilters({ ...filters, status })
        setTimeout(() => document.getElementById('sales-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
      }} />

      {tab === 'master' && <MasterBreakdown data={data} onPick={pickTab} />}

      <RateNote rates={data.rates} />

      {/* The two side ledgers. Both act on the member's own workspace, so on
          the owner's master tab they still show that owner's business. */}
      <PayoutsCard onChanged={() => { void load() }} />
      {/* Net profit after the office's expenses — Model Town direct only,
          on its own tab and the owner's master tab. Follows the Month filter
          and nothing else: expenses belong to the office, not to a website
          or an agent, so narrowing them by those would be meaningless. */}
      {(tab === 'pk_direct' || tab === 'master') && data.workspace === 'packaging' && (() => {
        const direct = data.sales.filter((v) => v.sale.stream === 'pk_direct' && (!filters.month || monthKey(v.sale.orderDate) === filters.month))
        const dt = totals(direct, data.rates?.rates ?? null)
        let costedProfit = 0, costedRevenue = 0, awaitingRevenue = 0
        for (const v of direct) {
          if (v.fig.closed) continue
          if (v.fig.profitKnown) { costedProfit += v.fig.profitPkr; costedRevenue += v.fig.revenuePkr }
          // Only money actually received is estimated on — an unpaid order
          // (Carly Blake's $3,700) is not profit yet, costed or not.
          else awaitingRevenue += v.fig.netPkr
        }
        return (
          <NetProfitCard month={filters.month} t={dt} version={expVersion}
            avgMargin={costedRevenue > 0 ? costedProfit / costedRevenue : null}
            awaitingRevenuePkr={awaitingRevenue} />
        )
      })()}
      <ExpensesCard month={filters.month} monthProfitPkr={filters.month ? t.profitPkr : null} onChanged={() => setExpVersion((n) => n + 1)} />

      <div id="sales-table" />
      <Card title={tab === 'master' ? 'All sales' : `${STREAMS[tab].short} — sales`} icon={Receipt}
        action={
          <label className="relative block">
            <span className="sr-only">Search sales</span>
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" aria-hidden />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search"
              className="w-40 sm:w-56 rounded-lg border border-gray-300 bg-white pl-7 pr-2 py-1 text-xs text-gray-900 outline-none focus:border-gray-900" />
          </label>
        }>
        <FilterBar filters={filters} setFilters={setFilters} options={filterOptions} shown={rows.length} total={tabRows.length} narrowed={narrowed} />
        {rows.length === 0 ? (
          narrowed
            ? <EmptyState icon={Search} title="No sales match" hint="Loosen a filter, or clear them all." />
            : <EmptyState icon={Receipt} title="No sales here yet" hint={canAddHere ? 'Add one with “New sale”, or from a won lead’s record.' : undefined} />
        ) : (
          <SalesTable rows={rows} showStream={tab === 'master'} detailed={tab === 'pk_partner'} onOpen={(v) => openSale(v)} ownWorkspace={data.workspace} />
        )}
      </Card>

      {editing && (
        <SaleEditor
          form={editing} setForm={setEditing} data={data}
          onClose={() => setEditing(null)}
          onSaved={async (id) => {
            setEditing(null)
            const j = await load()
            if (j && id) {
              const saved = j.sales.find((x) => x.sale.id === id)
              if (saved && tab !== 'master' && tab !== saved.sale.stream) setTab(saved.sale.stream)
            }
          }}
        />
      )}
      {viewing && <SaleViewer view={viewing} onClose={() => setViewing(null)} />}
    </PageShell>
  )
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function PageShell({ children, subtitle, actions }: { children: React.ReactNode; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3 flex-wrap">
          <Link href="/" className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100" aria-label="Back to the dashboard">
            <ArrowLeft className="w-4 h-4" aria-hidden />
          </Link>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900 leading-tight">Sales</h1>
            {subtitle && <p className="text-[11px] text-gray-500 leading-tight">{subtitle}</p>}
          </div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {actions}
            <GlobalSearch />
          </div>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-3 sm:px-5 py-4">{children}</main>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-80" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
      <Skeleton className="h-72" />
    </div>
  )
}

// ── Totals ───────────────────────────────────────────────────────────────────

function Stat({ label, value, hint, tone = 'default', onClick, active }: { label: string; value: string; hint?: React.ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad'; onClick?: () => void; active?: boolean }) {
  const color = tone === 'good' ? 'text-green-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-gray-900'
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag {...(onClick ? { type: 'button' as const, onClick, title: `Show these sales in the table` } : {})}
      className={`text-left bg-white border rounded-xl px-3 py-2.5 min-w-0 ${active ? 'border-blue-600 ring-2 ring-blue-500' : 'border-gray-200'} ${onClick ? 'cursor-pointer hover:border-gray-400' : ''}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums truncate ${color}`}>{value}</p>
      {hint && <p className="text-[10px] text-gray-500 truncate">{hint}</p>}
    </Tag>
  )
}

/** Costs in the currency they were written in, one total per currency: "$1,920", "Rs 80,000". */
function costSummary(costs: Sale['costs']): string {
  const by = new Map<SaleCurrency, number>()
  for (const c of costs) by.set(c.currency, (by.get(c.currency) ?? 0) + c.amount)
  return [...by].map(([cur, amt]) => money(amt, cur)).join(' + ')
}

/**
 * Costs line by line — "Production Rs 31,000", "Shipping Rs 52,000" — with
 * the total underneath once there is more than one. A single summed figure
 * under a "Production cost" heading read as though shipping had never been
 * entered, when it had; the row has to show each cost by its own name.
 */
function CostLines({ costs }: { costs: Sale['costs'] }) {
  const by = new Map<string, { label: string; amount: number; currency: SaleCurrency }>()
  for (const c of costs) {
    const label = (c.label || 'Cost').trim()
    const k = `${label.toLowerCase()}|${c.currency}`
    const prev = by.get(k)
    by.set(k, prev ? { ...prev, amount: prev.amount + c.amount } : { label, amount: c.amount, currency: c.currency })
  }
  const lines = [...by.values()]
  return (
    <>
      {lines.map((l) => (
        <p key={`${l.label}|${l.currency}`} className="leading-tight">
          <span className="text-[10px] text-gray-500 mr-1">{l.label}</span>{money(l.amount, l.currency)}
        </p>
      ))}
      {lines.length > 1 && <p className="text-[10px] font-semibold text-gray-700 border-t border-gray-200 mt-0.5 pt-0.5">Total {costSummary(costs)}</p>}
    </>
  )
}

/** Profit is only summed over sales whose costing is in; say what is left out. */
function profitHint(t: StreamTotals): string {
  const pending = t.awaitingCosting ? `${t.awaitingCosting} sale${t.awaitingCosting === 1 ? '' : 's'} awaiting costing` : ''
  if (!t.profitSales) return pending || 'no open sales'
  return [pending, t.profitEstimated ? 'estimated' : 'at locked rates'].filter(Boolean).join(' · ')
}

function TotalsGrid({ t, pick, picked }: { t: StreamTotals; pick?: (status: string) => void; picked?: string }) {
  const est = t.estimated || t.incomplete
  const on = (k: string) => (pick ? { onClick: () => pick(picked === k ? '' : k), active: picked === k } : {})
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 mb-4">
      <Stat label="Orders" value={String(t.open)} hint={t.closed ? `+${t.closed} refunded / cancelled` : 'open orders'} {...(pick ? { onClick: () => pick(''), active: false } : {})} />
      <Stat label="Order value" value={money(t.orderValueUsd, 'USD')} hint="open orders, USD" />
      <Stat label="Received" value={money(t.receivedUsd, 'USD')} hint={`fees ${money(t.feesUsd, 'USD')}`} {...on('@received')} />
      <Stat label="Net received" value={money(t.netUsd, 'USD')} hint="after merchant fees" tone="good" {...on('@received')} />
      <Stat label="Outstanding" value={money(t.outstandingUsd, 'USD')}
        hint={t.awaitingPayment ? `${t.awaitingPayment} awaiting payment` : 'nothing owed'}
        tone={t.outstandingUsd > 0 ? 'warn' : 'default'} {...on('@owed')} />
      <Stat label="Merchant fees" value={t.feesUsd > 0 ? `−${money(t.feesUsd, 'USD')}` : money(0, 'USD')} hint="PayPal · Wise · Payoneer cuts" tone={t.feesUsd > 0 ? 'bad' : 'default'} />
      <Stat label="Revenue (PKR)" value={money(t.revenuePkr, 'PKR')} hint={est ? 'includes estimates' : 'at locked rates'} />
      <Stat label="Cost (PKR)" value={money(t.costPkr, 'PKR')} hint="production + other" />
      <Stat label="Profit (PKR)" value={t.profitSales ? money(t.profitPkr, 'PKR') : '—'}
        hint={profitHint(t)}
        tone={t.profitPkr < 0 ? 'bad' : 'good'} />
    </div>
  )
}

function MasterBreakdown({ data, onPick }: { data: Payload; onPick: (k: SalesStream) => void }) {
  return (
    <Card title="By stream" icon={LayoutGrid} className="mb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-200">
              <th className="px-3 py-2 font-semibold">Stream</th>
              <th className="px-3 py-2 font-semibold text-right">Orders</th>
              <th className="px-3 py-2 font-semibold text-right">Order value</th>
              <th className="px-3 py-2 font-semibold text-right">Received</th>
              <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Merchant fee</th>
              <th className="px-3 py-2 font-semibold text-right">Net</th>
              <th className="px-3 py-2 font-semibold text-right">Outstanding</th>
              <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Profit (PKR)</th>
            </tr>
          </thead>
          <tbody>
            {STREAM_ORDER.map((k) => {
              const t = data.totals[k]
              if (!t) return null
              return (
                <tr key={k} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => onPick(k)}>
                  <td className="px-3 py-2 min-w-[15rem]">
                    <button type="button" className="font-semibold text-gray-900 hover:underline text-left" onClick={() => onPick(k)}>{STREAMS[k].label}</button>
                    <span className="ml-1.5 text-[10px] text-gray-500">{WORKSPACE_LABEL[STREAMS[k].workspace]}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.open}{t.closed ? <span className="text-gray-400"> +{t.closed}</span> : null}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(t.orderValueUsd, 'USD')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(t.receivedUsd, 'USD')}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${t.feesUsd > 0 ? 'text-red-700' : ''}`}>{t.feesUsd > 0 ? `−${money(t.feesUsd, 'USD')}` : money(0, 'USD')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(t.netUsd, 'USD')}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${t.outstandingUsd > 0 ? 'text-amber-700 font-semibold' : ''}`}>{money(t.outstandingUsd, 'USD')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {t.profitSales ? money(t.profitPkr, 'PKR') : '—'}{t.profitSales && t.profitEstimated ? <span className="text-[10px] text-amber-700"> est.</span> : null}
                    {t.awaitingCosting > 0 && <p className="text-[10px] font-normal text-gray-500">{t.awaitingCosting} awaiting costing</p>}
                  </td>
                </tr>
              )
            })}
            <tr className="font-bold text-gray-900">
              <td className="px-3 py-2">All streams</td>
              <td className="px-3 py-2 text-right tabular-nums">{data.all.open}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(data.all.orderValueUsd, 'USD')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(data.all.receivedUsd, 'USD')}</td>
              <td className="px-3 py-2 text-right tabular-nums text-red-700">−{money(data.all.feesUsd, 'USD')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(data.all.netUsd, 'USD')}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(data.all.outstandingUsd, 'USD')}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {data.all.profitSales ? money(data.all.profitPkr, 'PKR') : '—'}
                {data.all.awaitingCosting > 0 && <p className="text-[10px] font-normal text-gray-500">{data.all.awaitingCosting} awaiting costing</p>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function RateNote({ rates }: { rates: RateInfo | null }) {
  return (
    <p className="mb-3 text-[11px] text-gray-500">
      {rates?.rates.USD
        ? <>Today&apos;s mid-market rate: <b className="tabular-nums text-gray-700">1 USD = Rs {rates.rates.USD}</b> ({rates.source}). A payment nobody has withdrawn yet is estimated below that by its route — PayPal money loses about 4% on the way (USD → GBP at PayPal&apos;s margin, then GBP → PKR at Wise), Wise money about 0.6% — and the figure says <i>est.</i> Recording a payout below locks the real rate onto the payments it covered.</>
        : <>Today&apos;s rate could not be fetched, so any payment without its own rate cannot be converted to PKR yet.</>}
    </p>
  )
}

// ── The list ─────────────────────────────────────────────────────────────────

/** "ZCB-023 · SK-ZCB-07242026-23" → order no and the sheet's S No. */
function splitReference(ref: string): { orderNo: string; sNo: string } {
  const [orderNo = '', ...rest] = ref.split(' · ')
  return { orderNo, sNo: rest.join(' · ') }
}

// `detailed` lays the table out like the partner's spreadsheet, every column
// of it in the sheet's order (bar its S No): Order No, customer, email, phone, country,
// order date, box style, size, material, printing, quantity — then the money.
// ── Filters ─────────────────────────────────────────────────────────────────
// Website, sales person, payment status and month. All four are read off the
// rows themselves (a sale's site comes from its linked lead, which the server
// already resolved), so nothing here needs another request and the menus can
// only offer values that would match something.
interface SaleFilters { site: string; via: string; agent: string; status: string; month: string }
const NO_FILTERS: SaleFilters = { site: '', via: '', agent: '', status: '', month: '' }

function filtersActive(f: SaleFilters): boolean {
  return !!(f.site || f.via || f.agent || f.status || f.month)
}

/** YYYY-MM of the order date, or '' when the date is missing or malformed. */
function monthKey(ymd: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? ymd.slice(0, 7) : ''
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`
}

/** "samirkhan@shopcardboardboxes.com" → "samirkhan"; a typed-in name stays as typed. */
function agentLabel(v: string): string {
  return v.includes('@') ? v.split('@')[0] : v
}

function matchesFilters(v: SaleView, f: SaleFilters): boolean {
  const s = v.sale
  if (f.site && (s.siteId ?? '') !== f.site) return false
  if (f.via && (s.leadKind ?? '') !== f.via) return false
  if (f.agent && s.salesPerson.trim().toLowerCase() !== f.agent) return false
  // '@owed' / '@received' come from clicking the Outstanding / Received cards.
  if (f.status === '@owed') { if (v.fig.closed || !(v.fig.outstanding > 0)) return false }
  else if (f.status === '@received') { if (!(v.fig.received > 0)) return false }
  else if (f.status && v.fig.status !== f.status) return false
  if (f.month && monthKey(s.orderDate) !== f.month) return false
  return true
}

interface FilterOptions {
  sites: { value: string; label: string; n: number }[]
  vias: { value: string; label: string; n: number }[]
  agents: { value: string; label: string; n: number }[]
  statuses: { value: string; label: string; n: number }[]
  months: { value: string; label: string; n: number }[]
}

function filterOptionsFor(rows: SaleView[]): FilterOptions {
  const count = (keyOf: (v: SaleView) => string) => {
    const m = new Map<string, number>()
    for (const v of rows) { const k = keyOf(v); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
    return m
  }
  const sites = count((v) => v.sale.siteId ?? '')
  const vias = count((v) => v.sale.leadKind ?? '')
  const agents = count((v) => v.sale.salesPerson.trim().toLowerCase())
  const statuses = count((v) => v.fig.status)
  const months = count((v) => monthKey(v.sale.orderDate))
  const STATUS_ORDER = ['pending', 'partial', 'paid', 'refunded', 'cancelled']
  return {
    sites: [...sites].map(([value, n]) => ({ value, label: SITE_DOMAINS[value] ?? value, n }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    vias: [...vias].map(([value, n]) => ({ value, label: SALE_LEAD_KIND_LABEL[value as SaleLeadKind] ?? value, n }))
      .sort((a, b) => SALE_LEAD_KIND_ORDER.indexOf(a.value as SaleLeadKind) - SALE_LEAD_KIND_ORDER.indexOf(b.value as SaleLeadKind)),
    agents: [...agents].map(([value, n]) => ({ value, label: agentLabel(value), n }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    statuses: [
      ...[...statuses].map(([value, n]) => ({ value, label: PAYMENT_STATUS_LABEL[value as keyof typeof PAYMENT_STATUS_LABEL] ?? value, n })),
      // The two the totals cards pick (Outstanding / Received).
      { value: '@owed', label: 'Outstanding (money owed)', n: rows.filter((v) => !v.fig.closed && v.fig.outstanding > 0).length },
      { value: '@received', label: 'Money received', n: rows.filter((v) => v.fig.received > 0).length },
    ]
      .sort((a, b) => STATUS_ORDER.indexOf(a.value) - STATUS_ORDER.indexOf(b.value)),
    // Newest month first — that is the one being asked about.
    months: [...months].map(([value, n]) => ({ value, label: monthLabel(value), n }))
      .sort((a, b) => b.value.localeCompare(a.value)),
  }
}

const FILTER_SELECT = 'rounded-lg border bg-white px-2 py-1 text-xs text-gray-900 outline-none focus:border-gray-900 max-w-[11rem]'

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: { value: string; label: string; n: number }[]; onChange: (v: string) => void
}) {
  // A menu with one choice still earns its place: it says which single
  // website or agent this tab holds. A menu with none would be noise.
  if (options.length === 0) return null
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`${FILTER_SELECT} ${value ? 'border-blue-500 text-blue-800 font-semibold' : 'border-gray-300'}`}>
        <option value="">All</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
      </select>
    </label>
  )
}

function FilterBar({ filters, setFilters, options, shown, total, narrowed }: {
  filters: SaleFilters; setFilters: (f: SaleFilters) => void; options: FilterOptions
  shown: number; total: number; narrowed: boolean
}) {
  const set = (k: keyof SaleFilters) => (v: string) => setFilters({ ...filters, [k]: v })
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-gray-200 bg-gray-50/60" role="group" aria-label="Filter sales">
      <FilterSelect label="Website" value={filters.site} options={options.sites} onChange={set('site')} />
      <FilterSelect label="Via" value={filters.via} options={options.vias} onChange={set('via')} />
      <FilterSelect label="Agent" value={filters.agent} options={options.agents} onChange={set('agent')} />
      <FilterSelect label="Status" value={filters.status} options={options.statuses} onChange={set('status')} />
      <FilterSelect label="Month" value={filters.month} options={options.months} onChange={set('month')} />
      <span className="ml-auto text-[11px] text-gray-500 tabular-nums">
        {narrowed ? `${shown} of ${total}` : `${total} sale${total === 1 ? '' : 's'}`}
      </span>
      {filtersActive(filters) && (
        <button type="button" onClick={() => setFilters(NO_FILTERS)}
          className="inline-flex items-center gap-1 rounded-full border border-gray-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-gray-700 hover:bg-gray-100">
          <X className="w-3 h-3" aria-hidden />Clear
        </button>
      )}
    </div>
  )
}

const LEAD_KIND_STYLE: Record<SaleLeadKind, string> = {
  chat_human: 'bg-violet-50 text-violet-800 border-violet-200',
  chat_bot: 'bg-fuchsia-50 text-fuchsia-800 border-fuchsia-200',
  chat: 'bg-violet-50 text-violet-800 border-violet-200',
  quote: 'bg-sky-50 text-sky-800 border-sky-200',
  reorder: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  call: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  whatsapp: 'bg-green-50 text-green-800 border-green-200',
  checkout: 'bg-amber-50 text-amber-800 border-amber-200',
}

function LeadKindChip({ kind }: { kind: SaleLeadKind }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${LEAD_KIND_STYLE[kind]}`}>
      {SALE_LEAD_KIND_LABEL[kind]}
    </span>
  )
}

function SalesTable({ rows, showStream, detailed = false, onOpen, ownWorkspace }: {
  rows: SaleView[]; showStream: boolean; detailed?: boolean; onOpen: (v: SaleView) => void; ownWorkspace: Workspace
}) {
  const TH = 'px-3 py-2 font-semibold whitespace-nowrap'
  const TD = 'px-3 py-2 whitespace-nowrap text-gray-700'
  // The first two columns (date / order no, then customer) stay put while the
  // rest scrolls sideways — a spreadsheet's frozen pane — so a payment or a
  // cost far to the right is never read against the wrong name. The first
  // column has a fixed width so the customer column knows where to pin.
  const COL1 = 'w-[6.5rem] min-w-[6.5rem] max-w-[6.5rem]'
  const FROZEN = 'sticky z-[1] bg-white group-hover:bg-gray-50'
  const FROZEN_HEAD = 'sticky z-[2] bg-white'
  const PANE_EDGE = 'shadow-[inset_-1px_0_0_#e5e7eb]'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-200">
            {detailed ? <>
              <th className={`${TH} ${FROZEN_HEAD} left-0 ${COL1}`}>Order No</th>
              <th className={`${TH} ${FROZEN_HEAD} left-[6.5rem] ${PANE_EDGE}`}>Customer</th>
              <th className={TH}>Email</th>
              <th className={TH}>Phone</th>
              <th className={TH}>Country</th>
              <th className={TH}>Order date</th>
              <th className={TH}>Box style</th>
              <th className={TH}>Size</th>
              <th className={TH}>Material</th>
              <th className={TH}>Printing</th>
            </> : <>
              <th className={`px-3 py-2 font-semibold ${FROZEN_HEAD} left-0 ${COL1}`}>Date</th>
              <th className={`px-3 py-2 font-semibold ${FROZEN_HEAD} left-[6.5rem] ${PANE_EDGE}`}>Customer</th>
              {showStream && <th className="px-3 py-2 font-semibold">Stream</th>}
              <th className="px-3 py-2 font-semibold">Product</th>
            </>}
            <th className={TH}>Website</th>
            <th className={TH}>Via</th>
            <th className={`${TH} text-right`}>{detailed ? 'Quantity' : 'Qty'}</th>
            <th className={`${TH} text-right`}>{detailed ? 'Order amount' : 'Order'}</th>
            <th className="px-3 py-2 font-semibold text-right">Received</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Merchant fee</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">Net received</th>
            <th className="px-3 py-2 font-semibold text-right">Outstanding</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{detailed ? 'Production price' : 'Costs'}</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold text-right whitespace-nowrap">{detailed ? 'Gross profit (PKR)' : 'Profit (PKR)'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => {
            const { sale: s, fig: f } = v
            const readOnly = s.workspace !== ownWorkspace
            const ref = splitReference(s.reference)
            return (
              <tr key={s.id} className={`group border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${f.closed ? 'opacity-60' : ''}`} onClick={() => onOpen(v)}>
                {detailed && <>
                  <td className={`${TD} tabular-nums font-semibold ${FROZEN} left-0 ${COL1} truncate`}>{ref.orderNo || '—'}</td>
                </>}
                {!detailed && <td className={`px-3 py-2 whitespace-nowrap tabular-nums text-gray-600 ${FROZEN} left-0 ${COL1}`}>{shortDate(s.orderDate)}</td>}
                <td className={`px-3 py-2 min-w-[10rem] max-w-[14rem] ${FROZEN} left-[6.5rem] ${PANE_EDGE}`}>
                  <button type="button" className="font-semibold text-gray-900 hover:underline text-left" onClick={(e) => { e.stopPropagation(); onOpen(v) }}>
                    {s.customer}
                  </button>
                  {readOnly && <Lock className="inline w-3 h-3 ml-1 text-gray-400" aria-label="Read-only here" />}
                  {!detailed && <p className="text-[10px] text-gray-500">{[s.reference, s.company].filter(Boolean).join(' · ') || '—'}</p>}
                  {detailed && s.company && <p className="text-[10px] text-gray-500">{s.company}</p>}
                  {s.counterparty && <p className="text-[10px] text-gray-600">Owed by <b className="font-semibold">{s.counterparty}</b></p>}
                </td>
                {detailed ? <>
                  <td className={TD} onClick={(e) => e.stopPropagation()}>{s.email ? <a className="hover:underline" href={`mailto:${s.email}`}>{s.email}</a> : '—'}</td>
                  <td className={`${TD} tabular-nums`}>{s.phone || '—'}</td>
                  <td className={TD}>{s.country || '—'}</td>
                  <td className={`${TD} tabular-nums`}>{shortDate(s.orderDate)}</td>
                  <td className="px-3 py-2 min-w-[8rem] text-gray-700">{s.product || '—'}</td>
                  <td className="px-3 py-2 min-w-[8rem] text-gray-700">{s.size || '—'}</td>
                  <td className={TD}>{s.material || '—'}</td>
                  <td className={TD}>{s.printing || '—'}</td>
                </> : <>
                  {showStream && <td className="px-3 py-2 whitespace-nowrap text-gray-600">{STREAMS[s.stream].short}</td>}
                  <td className="px-3 py-2 min-w-[8rem] text-gray-700">
                    {s.product || '—'}
                  </td>
                </>}
                <td className={TD}>{s.siteId ? (SITE_DOMAINS[s.siteId] ?? s.siteId) : <span className="text-gray-400">—</span>}</td>
                <td className={TD}>{s.leadKind ? <LeadKindChip kind={s.leadKind} /> : <span className="text-gray-400">—</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-gray-700">{s.quantity || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(s.orderAmount, s.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{money(f.received, s.currency)}</td>
                <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${f.fees > 0 ? 'text-red-700' : 'text-gray-400'}`}>
                  {f.fees > 0 ? `−${money(f.fees, s.currency)}` : money(0, s.currency)}
                  {s.payments.length > 0 && <p className="text-[10px] text-gray-500">{[...new Set(s.payments.map((p) => PAYMENT_METHOD_LABEL[p.method]))].join(' · ')}</p>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap font-semibold text-green-700">{money(f.net, s.currency)}</td>
                <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${f.outstanding > 0 ? 'text-amber-700 font-semibold' : 'text-gray-500'}`}>{money(f.outstanding, s.currency)}</td>
                <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                  {s.costs.length ? <CostLines costs={s.costs} /> : <span className="text-gray-400">—</span>}
                  {s.costs.length > 0 && s.costs.some((c) => c.currency !== 'PKR') && f.costPkr > 0 && (
                    <p className="text-[10px] text-gray-500">≈ {money(f.costPkr, 'PKR')}</p>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${PAYMENT_STATUS_STYLE[f.status]}`}>{PAYMENT_STATUS_LABEL[f.status]}</span>
                  {s.production && <p className="mt-0.5 text-[10px] text-gray-500">{PRODUCTION_LABEL[s.production]}</p>}
                </td>
                <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${f.profitPkr < 0 ? 'text-red-700' : 'text-gray-900'}`}>
                  {!f.profitKnown ? (
                    <><span className="text-gray-400">—</span><p className="text-[10px] text-gray-500">costing pending</p></>
                  ) : <>
                  {money(f.profitPkr, 'PKR')}
                  {f.profit.currency !== 'PKR' ? (
                    <p className="text-[10px] text-gray-500">{money(f.profit.amount, f.profit.currency)}{f.profitEstimated ? <span className="text-amber-700"> · est.</span> : null}</p>
                  ) : f.profitEstimated && (
                    <p className="text-[10px] text-amber-700" title={f.needsRate.length ? `Needs a rate: ${f.needsRate.join(', ')}` : undefined}>
                      {f.incomplete ? 'rate missing' : 'est.'}
                    </p>
                  )}
                  </>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Editing ──────────────────────────────────────────────────────────────────

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block ${className}`}><span className={LABEL}>{label}</span>{children}</label>
}

function SaleEditor({ form, setForm, data, onClose, onSaved }: {
  form: SaleForm
  setForm: React.Dispatch<React.SetStateAction<SaleForm | null>>
  data: Payload
  onClose: () => void
  onSaved: (id: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const rates = data.rates?.rates ?? null
  const live = figures(saleFromForm(form, data.workspace), rates)
  const mine = STREAM_ORDER.filter((k) => STREAMS[k].workspace === data.workspace)
  const today = rates?.[form.currency]

  const set = <K extends keyof SaleForm>(k: K, v: SaleForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const setPay = (id: string, patch: Partial<PayForm>) =>
    setForm((f) => (f ? { ...f, payments: f.payments.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : f))
  const setCost = (id: string, patch: Partial<CostForm>) =>
    setForm((f) => (f ? { ...f, costs: f.costs.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : f))

  async function save() {
    setBusy(true); setErr('')
    try {
      const res = await fetch('/api/sales', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sale: { ...form, id: form.id || undefined } }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(String(j.error || 'That did not save.')); return }
      onSaved(j.sale?.id ?? null)
    } catch { setErr('That did not save.') } finally { setBusy(false) }
  }

  async function remove() {
    if (!form.id || !window.confirm(`Delete the sale for ${form.customer || 'this customer'}? It stays in the history but leaves every total.`)) return
    setBusy(true); setErr('')
    try {
      const res = await fetch(`/api/sales?id=${encodeURIComponent(form.id)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(String(j.error || 'That did not delete.')); return }
      onSaved(null)
    } catch { setErr('That did not delete.') } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label={form.id ? 'Edit sale' : 'New sale'}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="h-full w-full max-w-2xl bg-gray-50 shadow-xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 bg-white border-b border-gray-200">
          <Wallet className="w-4 h-4 text-gray-500" aria-hidden />
          <h2 className="text-sm font-bold text-gray-900">{form.id ? 'Edit sale' : 'New sale'}</h2>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-lg text-gray-500 hover:bg-gray-100" aria-label="Close">
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* Live figures — the same arithmetic the totals use. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Received" value={money(live.received, form.currency)} hint={`fees ${money(live.fees, form.currency)}`} />
            <Stat label="Net received" value={money(live.net, form.currency)} tone="good" />
            <Stat label="Outstanding" value={money(live.outstanding, form.currency)} tone={live.outstanding > 0 ? 'warn' : 'default'} />
            <Stat label="Status" value={PAYMENT_STATUS_LABEL[live.status]} />
            <Stat label="Revenue (PKR)" value={money(live.revenuePkr, 'PKR')} />
            <Stat label="Cost (PKR)" value={money(live.costPkr, 'PKR')} />
            <Stat label="Profit (PKR)" value={live.profitKnown ? money(live.profitPkr, 'PKR') : '—'} tone={!live.profitKnown ? 'default' : live.profitPkr < 0 ? 'bad' : 'good'}
              hint={!live.profitKnown ? 'add a cost or the agreed profit' : `${live.profit.currency !== 'PKR' ? `${money(live.profit.amount, live.profit.currency)} · ` : ''}${form.profitAmount ? 'as agreed' : live.incomplete ? 'a rate is missing' : live.profitEstimated ? 'estimated' : 'at locked rates'}`} />
            <Stat label="Net received (PKR)" value={money(live.netPkr, 'PKR')} />
          </div>
          {live.needsRate.length > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
              <TriangleAlert className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
              <span>No locked rate yet for: {live.needsRate.join(', ')}. Today&apos;s rate is standing in, so the PKR figures are estimates.</span>
            </p>
          )}

          <Card title="Order">
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Stream">
                <select className={INPUT} value={form.stream} onChange={(e) => set('stream', e.target.value as SalesStream)}>
                  {mine.map((k) => <option key={k} value={k}>{STREAMS[k].label}</option>)}
                </select>
              </Field>
              <Field label="Reference / order no"><input className={INPUT} value={form.reference} onChange={(e) => set('reference', e.target.value)} placeholder="SCB-015" /></Field>
              <Field label="Customer *"><input className={INPUT} value={form.customer} onChange={(e) => set('customer', e.target.value)} /></Field>
              <Field label="Company"><input className={INPUT} value={form.company} onChange={(e) => set('company', e.target.value)} /></Field>
              <Field label="Email"><input className={INPUT} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></Field>
              <Field label="Phone"><input className={INPUT} value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
              <Field label="Country"><input className={INPUT} value={form.country} onChange={(e) => set('country', e.target.value)} placeholder="USA" /></Field>
              <Field label="Order date"><input className={INPUT} type="date" value={form.orderDate} onChange={(e) => set('orderDate', e.target.value)} /></Field>
              <Field label="Product / box style" className="sm:col-span-2"><input className={INPUT} value={form.product} onChange={(e) => set('product', e.target.value)} /></Field>
              <Field label="Size"><input className={INPUT} value={form.size} onChange={(e) => set('size', e.target.value)} /></Field>
              <Field label="Material"><input className={INPUT} value={form.material} onChange={(e) => set('material', e.target.value)} /></Field>
              <Field label="Printing"><input className={INPUT} value={form.printing} onChange={(e) => set('printing', e.target.value)} /></Field>
              <Field label="Quantity"><input className={INPUT} value={form.quantity} onChange={(e) => set('quantity', e.target.value)} placeholder="1,000" /></Field>
              <Field label="Order amount *">
                <div className="mt-1 flex gap-1.5">
                  <select className={`${INLINE} w-24 shrink-0`} value={form.currency} onChange={(e) => set('currency', e.target.value as SaleCurrency)} aria-label="Order currency">
                    {SALE_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input className={`${INLINE} flex-1`} inputMode="decimal" value={form.orderAmount} onChange={(e) => set('orderAmount', e.target.value)} placeholder="0.00" aria-label="Order amount" />
                </div>
              </Field>
              {form.currency !== 'PKR' && (
                <Field label={`Agreed rate (PKR per ${form.currency})`}>
                  <input className={INPUT} inputMode="decimal" value={form.rate} onChange={(e) => set('rate', e.target.value)} placeholder="Only if the deal fixed one" />
                  <span className="mt-1 block text-[10px] text-gray-500">Converts the unpaid amount and any payment without its own rate.</span>
                </Field>
              )}
            </div>
          </Card>

          <Card title="Payments received"
            action={
              <button type="button" className={`${BTN} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
                onClick={() => set('payments', [...form.payments, {
                  id: newId('pay'), date: todayKey(),
                  amount: form.payments.length === 0 && form.orderAmount ? form.orderAmount : '',
                  fee: '', method: 'paypal', rate: '', note: '',
                }])}>
                <Plus className="w-3.5 h-3.5" aria-hidden />Add payment
              </button>
            }>
            <div className="p-3 space-y-3">
              {form.payments.length === 0 && <p className="text-xs text-gray-500">No payment yet — the sale shows as Pending.</p>}
              {form.payments.map((p) => {
                const net = (parseAmount(p.amount) ?? 0) - (parseAmount(p.fee) ?? 0)
                return (
                  <div key={p.id} className="rounded-lg border border-gray-200 bg-white p-2.5 grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                    <Field label="Date" className="col-span-2 sm:col-span-2"><input className={INPUT} type="date" value={p.date} onChange={(e) => setPay(p.id, { date: e.target.value })} /></Field>
                    <Field label={`Amount (${form.currency})`}><input className={INPUT} inputMode="decimal" value={p.amount} onChange={(e) => setPay(p.id, { amount: e.target.value })} /></Field>
                    <Field label="Fee"><input className={INPUT} inputMode="decimal" value={p.fee} onChange={(e) => setPay(p.id, { fee: e.target.value })} placeholder="0" /></Field>
                    <Field label="Via" className="col-span-2 sm:col-span-2">
                      <select className={INPUT} value={p.method} onChange={(e) => setPay(p.id, { method: e.target.value as PaymentMethod })}>
                        {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                      </select>
                    </Field>
                    {form.currency !== 'PKR' && (
                      <Field label={`Rate (PKR per ${form.currency})`} className="col-span-2 sm:col-span-3">
                        <div className="mt-1 flex gap-1.5">
                          <input className={`${INLINE} flex-1`} inputMode="decimal" value={p.rate} onChange={(e) => setPay(p.id, { rate: e.target.value })} placeholder={today ? String(today) : 'e.g. 278.40'} aria-label={`Rate, PKR per ${form.currency}`} />
                          {today && !p.rate && (
                            <button type="button" className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 whitespace-nowrap`}
                              onClick={() => setPay(p.id, { rate: String(today) })}>
                              Use {today}
                            </button>
                          )}
                        </div>
                      </Field>
                    )}
                    <Field label="Note" className="col-span-2 sm:col-span-2"><input className={INPUT} value={p.note} onChange={(e) => setPay(p.id, { note: e.target.value })} placeholder="Invoice no, transaction id" /></Field>
                    <div className="col-span-2 sm:col-span-1 flex items-center justify-between sm:justify-end gap-2">
                      <span className="text-[11px] text-gray-500 tabular-nums">net {money(net, form.currency)}</span>
                      <button type="button" aria-label="Remove this payment" className="p-1.5 rounded-lg text-gray-400 hover:text-red-700 hover:bg-red-50"
                        onClick={() => set('payments', form.payments.filter((x) => x.id !== p.id))}>
                        <Trash2 className="w-3.5 h-3.5" aria-hidden />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card title="Costs"
            action={
              <button type="button" className={`${BTN} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}
                onClick={() => set('costs', [...form.costs, { id: newId('cost'), label: form.costs.length ? '' : 'Production', amount: '', currency: 'PKR', rate: '', note: '' }])}>
                <Plus className="w-3.5 h-3.5" aria-hidden />Add cost
              </button>
            }>
            <div className="p-3 space-y-3">
              {form.costs.length === 0 && <p className="text-xs text-gray-500">No costs yet. Add the production cost to see the profit.</p>}
              {form.costs.map((c) => (
                <div key={c.id} className="rounded-lg border border-gray-200 bg-white p-2.5 grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                  <Field label="What" className="col-span-2"><input className={INPUT} value={c.label} onChange={(e) => setCost(c.id, { label: e.target.value })} placeholder="Production, shipping…" /></Field>
                  <Field label="Amount"><input className={INPUT} inputMode="decimal" value={c.amount} onChange={(e) => setCost(c.id, { amount: e.target.value })} /></Field>
                  <Field label="Currency">
                    <select className={INPUT} value={c.currency} onChange={(e) => setCost(c.id, { currency: e.target.value as SaleCurrency })}>
                      {SALE_CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </Field>
                  {c.currency !== 'PKR' ? (
                    <Field label="Rate (PKR)">
                      <input className={INPUT} inputMode="decimal" value={c.rate} onChange={(e) => setCost(c.id, { rate: e.target.value })} placeholder={rates?.[c.currency] ? String(rates[c.currency]) : ''} />
                    </Field>
                  ) : <div className="hidden sm:block" />}
                  <div className="flex justify-end">
                    <button type="button" aria-label="Remove this cost" className="p-1.5 rounded-lg text-gray-400 hover:text-red-700 hover:bg-red-50"
                      onClick={() => set('costs', form.costs.filter((x) => x.id !== c.id))}>
                      <Trash2 className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Agreed profit">
            <div className="p-3">
              <div className="flex gap-2">
                <select className={`${INLINE} w-24`} value={form.profitCurrency} onChange={(e) => set('profitCurrency', e.target.value as SaleCurrency)} aria-label="Profit currency">
                  {SALE_CURRENCIES.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
                <input className={`${INLINE} flex-1`} inputMode="decimal" value={form.profitAmount} onChange={(e) => set('profitAmount', e.target.value)} placeholder="Leave empty to work it out from the costs" aria-label="Agreed profit" />
              </div>
              <p className="mt-1 text-[10px] text-gray-500">Only when the deal or the sheet states the profit (e.g. 172k PKR). It is shown exactly as entered.</p>
            </div>
          </Card>

          <Card title="Status & source">
            <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Payment status">
                <select className={INPUT} value={form.statusOverride} onChange={(e) => set('statusOverride', e.target.value as SaleForm['statusOverride'])}>
                  <option value="">Automatic — {PAYMENT_STATUS_LABEL[figures({ ...saleFromForm(form, data.workspace), statusOverride: null }, rates).status]}</option>
                  <option value="refunded">Refunded</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </Field>
              <Field label="Production">
                <select className={INPUT} value={form.production} onChange={(e) => set('production', e.target.value as SaleForm['production'])}>
                  <option value="">Not recorded</option>
                  {PRODUCTION_STATUSES.map((s) => <option key={s} value={s}>{PRODUCTION_LABEL[s]}</option>)}
                </select>
              </Field>
              <Field label="Sales person">
                <input className={INPUT} list="sales-members" value={form.salesPerson} onChange={(e) => set('salesPerson', e.target.value)} />
                <datalist id="sales-members">{data.members.map((m) => <option key={m} value={m} />)}</datalist>
              </Field>
              <Field label={form.stream === 'pk_partner' ? 'Owed by (the partner)' : 'Owed by, if not the customer'}>
                <input className={INPUT} value={form.counterparty} onChange={(e) => set('counterparty', e.target.value)} />
              </Field>
              <Field label="Source / arrangement" className="sm:col-span-2">
                <input className={INPUT} value={form.source} onChange={(e) => set('source', e.target.value)} />
              </Field>
              <Field label="Notes" className="sm:col-span-2">
                <textarea className={INPUT} rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
              {form.leadId && (
                <a href={`/leads/${encodeURIComponent(form.leadId)}`} className="sm:col-span-2 inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline">
                  <ExternalLink className="w-3.5 h-3.5" aria-hidden />Open the lead this sale came from
                </a>
              )}
            </div>
          </Card>
        </div>

        <div className="flex items-center gap-2 px-4 py-3 bg-white border-t border-gray-200">
          {err && <p role="alert" className="text-xs font-medium text-red-700 mr-auto">{err}</p>}
          {form.id && (
            <button type="button" onClick={() => void remove()} disabled={busy} className={`${BTN} ${err ? '' : 'mr-auto'} text-red-700 hover:bg-red-50`}>
              <Trash2 className="w-3.5 h-3.5" aria-hidden />Delete
            </button>
          )}
          <button type="button" onClick={onClose} className={`${BTN} ${!form.id && !err ? 'ml-auto' : ''} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>
            {busy ? 'Saving…' : 'Save sale'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A sale from the other business, in the master view — read-only by design. */
function SaleViewer({ view, onClose }: { view: SaleView; onClose: () => void }) {
  const { sale: s, fig: f } = view
  const line = (k: string, v: React.ReactNode) => (
    <div className="flex gap-3 py-1 border-b border-gray-100 text-xs"><span className="w-36 shrink-0 text-gray-500">{k}</span><span className="min-w-0 text-gray-900 break-words">{v || '—'}</span></div>
  )
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" role="dialog" aria-modal="true" aria-label="Sale">
      <div className="h-full w-full max-w-lg bg-white shadow-xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200">
          <Lock className="w-4 h-4 text-gray-400" aria-hidden />
          <h2 className="text-sm font-bold text-gray-900">{s.customer}</h2>
          <button type="button" onClick={onClose} className="ml-auto p-1.5 rounded-lg text-gray-500 hover:bg-gray-100" aria-label="Close"><X className="w-4 h-4" aria-hidden /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-[11px] text-gray-500">This sale belongs to the {WORKSPACE_LABEL[s.workspace]} dashboard — edit it there.</p>
          {line('Stream', STREAMS[s.stream].label)}
          {line('Reference', s.reference)}
          {line('Order date', shortDate(s.orderDate))}
          {line('Product', [s.product, s.quantity].filter(Boolean).join(' · '))}
          {line('Order amount', money(s.orderAmount, s.currency))}
          {s.rate ? line('Agreed rate', `Rs ${s.rate} per ${s.currency}`) : null}
          {line('Received', `${money(f.received, s.currency)} (fees ${money(f.fees, s.currency)})`)}
          {line('Outstanding', money(f.outstanding, s.currency))}
          {line('Payment status', PAYMENT_STATUS_LABEL[f.status])}
          {line('Payments', s.payments.map((p) => `${shortDate(p.date)} — ${money(p.amount, s.currency)} via ${PAYMENT_METHOD_LABEL[p.method]}${p.rate ? ` @ Rs ${p.rate}` : ''}`).join('; '))}
          {line('Costs', s.costs.map((c) => `${c.label}: ${money(c.amount, c.currency)}`).join('; '))}
          {line('Revenue (PKR)', money(f.revenuePkr, 'PKR'))}
          {line('Profit (PKR)', !f.profitKnown ? 'Costing pending' : `${money(f.profitPkr, 'PKR')}${f.profit.currency !== 'PKR' ? ` (${money(f.profit.amount, f.profit.currency)})` : ''}${f.profitEstimated ? ' (est.)' : ''}${s.agreedProfit ? ' — as agreed' : ''}`)}
          {line('Production', s.production ? PRODUCTION_LABEL[s.production] : '')}
          {line('Owed by', s.counterparty)}
          {line('Website', s.siteId ? (SITE_DOMAINS[s.siteId] ?? s.siteId) : '')}
          {line('Lead via', s.leadKind ? SALE_LEAD_KIND_LABEL[s.leadKind] : '')}
          {line('Sales person', s.salesPerson)}
          {line('Source', s.source)}
          {line('Notes', s.notes)}
        </div>
      </div>
    </div>
  )
}
