'use client'

// The two ledgers that sit beside the sales: payouts (withdrawals that turned
// dollars into rupees, which lock the real rate onto the payments they
// covered) and expenses (salaries, office, vendors — money no order owns).
// Both are plain admin-only lists with an inline form; the arithmetic lives
// in lib/salescore.ts and the storage in lib/payouts.ts / lib/expenses.ts.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Landmark, Wallet, Plus, Trash2, X } from 'lucide-react'
import { Card, EmptyState } from '@/app/leads/[id]/ui'
import {
  PAYOUT_ROUTES, PAYOUT_ROUTE_LABEL, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, SALE_CURRENCIES,
  money, shortDate,
  type Payout, type PayoutRoute, type Expense, type ExpenseCategory, type SaleCurrency,
} from '@/lib/salescore'

const INPUT = 'rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10 w-full'
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'
const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40'
const TH = 'px-3 py-2 font-semibold whitespace-nowrap text-left text-[10px] uppercase tracking-wider text-gray-500'
const TD = 'px-3 py-2 whitespace-nowrap text-gray-700'

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`
}

// ── Payouts ─────────────────────────────────────────────────────────────────

type PayoutRow = Payout & { rate: number | null }

export function PayoutsCard({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<PayoutRow[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState({ date: today(), route: 'paypal' as PayoutRoute, currency: 'USD' as SaleCurrency, amountOut: '', gbpReceived: '', pkrReceived: '', note: '' })

  const load = useCallback(async () => {
    const r = await fetch('/api/sales/payouts')
    if (r.ok) setRows((await r.json()).payouts)
  }, [])
  useEffect(() => { void load() }, [load])

  const preview = useMemo(() => {
    const out = Number(form.amountOut), pkr = Number(form.pkrReceived)
    return out > 0 && pkr > 0 ? Math.round((pkr / out) * 100) / 100 : null
  }, [form.amountOut, form.pkrReceived])

  const save = async () => {
    setBusy(true); setError(''); setNotice('')
    const r = await fetch('/api/sales/payouts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payout: form }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error || 'That did not save.'); return }
    const n = j.lockedPayments as number
    setNotice(n
      ? `Locked Rs ${j.payout.rate} per ${form.currency} onto ${n} payment${n === 1 ? '' : 's'}.${j.payout.leftover > 0.5 ? ` ${money(j.payout.leftover, form.currency)} of this withdrawal is not matched to any payment yet.` : ''}`
      : 'Saved. No unsettled payment on this route fits inside this withdrawal, so nothing was locked.')
    setForm({ date: today(), route: form.route, currency: 'USD', amountOut: '', gbpReceived: '', pkrReceived: '', note: '' })
    setOpen(false)
    await load(); onChanged()
  }

  const remove = async (p: PayoutRow) => {
    if (!window.confirm(`Delete the payout of ${shortDate(p.date)}? The ${p.settled.length} payment${p.settled.length === 1 ? '' : 's'} it locked go back to an estimated rate.`)) return
    setBusy(true); setError('')
    const r = await fetch(`/api/sales/payouts?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error || 'That did not delete.'); return }
    await load(); onChanged()
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <Card title="Payouts — withdrawals to the bank" icon={Landmark} className="mb-4"
      action={
        <button type="button" onClick={() => setOpen((o) => !o)} className={`${BTN} ${open ? 'border border-gray-300 bg-white text-gray-800' : 'bg-gray-900 text-white hover:bg-gray-800'}`}>
          {open ? <><X className="w-3.5 h-3.5" aria-hidden />Cancel</> : <><Plus className="w-3.5 h-3.5" aria-hidden />Record a payout</>}
        </button>
      }>
      <p className="px-3 pt-2 text-[11px] text-gray-500">
        Every time money is withdrawn, enter what left PayPal or Wise and what landed in the bank. The rate that gives is locked onto the oldest unsettled payments on that route, so their profit stops being an estimate.
      </p>
      {error && <p role="alert" className="px-3 pt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="px-3 pt-2 text-xs font-medium text-green-700">{notice}</p>}

      {open && (
        <form className="px-3 py-3 grid grid-cols-2 md:grid-cols-6 gap-3 border-b border-gray-100" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <label className="block"><span className={LABEL}>Landed on</span>
            <input type="date" className={INPUT} value={form.date} onChange={(e) => set('date', e.target.value)} required /></label>
          <label className="block md:col-span-2"><span className={LABEL}>Route</span>
            <select className={INPUT} value={form.route} onChange={(e) => set('route', e.target.value as PayoutRoute)}>
              {PAYOUT_ROUTES.map((r) => <option key={r} value={r}>{PAYOUT_ROUTE_LABEL[r]}</option>)}
            </select></label>
          <label className="block"><span className={LABEL}>Withdrawn ({form.currency})</span>
            <input inputMode="decimal" className={INPUT} value={form.amountOut} onChange={(e) => set('amountOut', e.target.value)} placeholder="e.g. 2500" required /></label>
          {form.route === 'paypal' && (
            <label className="block"><span className={LABEL}>GBP from PayPal</span>
              <input inputMode="decimal" className={INPUT} value={form.gbpReceived} onChange={(e) => set('gbpReceived', e.target.value)} placeholder="optional" /></label>
          )}
          <label className="block"><span className={LABEL}>PKR in bank</span>
            <input inputMode="decimal" className={INPUT} value={form.pkrReceived} onChange={(e) => set('pkrReceived', e.target.value)} placeholder="e.g. 690000" required /></label>
          <label className="block col-span-2 md:col-span-4"><span className={LABEL}>Note</span>
            <input className={INPUT} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="Wise transfer number, anything worth remembering" /></label>
          <div className="col-span-2 md:col-span-2 flex items-end justify-between gap-3">
            <p className="text-xs text-gray-600">{preview ? <>Effective rate <b className="tabular-nums">Rs {preview}</b> per {form.currency}</> : 'Rate appears once both amounts are in.'}</p>
            <button type="submit" disabled={busy} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>Save payout</button>
          </div>
        </form>
      )}

      {rows === null ? <p className="px-3 py-4 text-xs text-gray-500">Loading…</p>
        : rows.length === 0 ? <EmptyState icon={Landmark} title="No payouts recorded yet" hint="Record the first withdrawal when it lands and the matching payments lock to its rate." />
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200">
                <th className={TH}>Landed</th><th className={TH}>Route</th><th className={`${TH} text-right`}>Withdrawn</th><th className={`${TH} text-right`}>GBP</th>
                <th className={`${TH} text-right`}>PKR in bank</th><th className={`${TH} text-right`}>Rate</th><th className={TH}>Locked</th><th className={TH}>Note</th><th className={TH} />
              </tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-gray-100">
                    <td className={`${TD} tabular-nums`}>{shortDate(p.date)}</td>
                    <td className={TD}>{PAYOUT_ROUTE_LABEL[p.route]}</td>
                    <td className={`${TD} text-right tabular-nums`}>{money(p.amountOut, p.currency)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{p.gbpReceived ? money(p.gbpReceived, 'GBP') : '—'}</td>
                    <td className={`${TD} text-right tabular-nums font-semibold`}>{money(p.pkrReceived, 'PKR')}</td>
                    <td className={`${TD} text-right tabular-nums`}>{p.rate ? `Rs ${p.rate}` : '—'}</td>
                    <td className={TD}>
                      {p.settled.length} payment{p.settled.length === 1 ? '' : 's'}
                      {p.leftover > 0.5 && <p className="text-[10px] text-amber-700">{money(p.leftover, p.currency)} unmatched</p>}
                    </td>
                    <td className="px-3 py-2 text-gray-600 max-w-[16rem] truncate" title={p.note}>{p.note || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => remove(p)} disabled={busy} className="text-gray-400 hover:text-red-600" aria-label="Delete payout"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Card>
  )
}

// ── Expenses ────────────────────────────────────────────────────────────────

type ExpenseRow = Expense & { pkr: { value: number; estimated: boolean; missing: boolean } }

export function ExpensesCard({ month, monthProfitPkr, onChanged }: {
  /** The month the sales table is filtered to, if any — the summary follows it. */
  month: string
  /** Profit (PKR) of the sales shown for that month, so net-after-expenses can be shown. */
  monthProfitPkr: number | null
  /** Called after an expense is added or deleted, so the net-profit card refreshes. */
  onChanged?: () => void
}) {
  const [rows, setRows] = useState<ExpenseRow[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<string>('')
  const [form, setForm] = useState({ date: today(), month: today().slice(0, 7), category: 'salary' as ExpenseCategory, payee: '', amount: '', currency: 'PKR' as SaleCurrency, rate: '', note: '' })

  const load = useCallback(async () => {
    const r = await fetch('/api/sales/expenses')
    if (r.ok) setRows((await r.json()).expenses)
  }, [])
  useEffect(() => { void load() }, [load])
  // Follow the sales table's month filter when it changes; the card keeps its
  // own choice otherwise.
  useEffect(() => { setView(month) }, [month])

  const months = useMemo(() => [...new Set((rows ?? []).map((e) => e.month))].sort((a, b) => b.localeCompare(a)), [rows])
  const shown = useMemo(() => (rows ?? []).filter((e) => !view || e.month === view), [rows, view])
  const total = useMemo(() => shown.reduce((a, e) => a + e.pkr.value, 0), [shown])
  const estimated = shown.some((e) => e.pkr.estimated || e.pkr.missing)
  const byCategory = useMemo(() => {
    const m = new Map<ExpenseCategory, number>()
    for (const e of shown) m.set(e.category, (m.get(e.category) ?? 0) + e.pkr.value)
    return [...m].sort((a, b) => b[1] - a[1])
  }, [shown])

  const save = async () => {
    setBusy(true); setError('')
    const r = await fetch('/api/sales/expenses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expense: form }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error || 'That did not save.'); return }
    setForm((f) => ({ ...f, payee: '', amount: '', note: '' }))
    await load(); onChanged?.()
  }

  const remove = async (e: ExpenseRow) => {
    if (!window.confirm(`Delete "${e.payee}" (${money(e.amount, e.currency)})?`)) return
    setBusy(true); setError('')
    const r = await fetch(`/api/sales/expenses?id=${encodeURIComponent(e.id)}`, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error || 'That did not delete.'); return }
    await load(); onChanged?.()
  }

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <Card title="Expenses — salaries, office, vendors" icon={Wallet} className="mb-4"
      action={
        <div className="flex items-center gap-2">
          <select value={view} onChange={(e) => setView(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 outline-none focus:border-gray-900" aria-label="Month">
            <option value="">All months</option>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button type="button" onClick={() => setOpen((o) => !o)} className={`${BTN} ${open ? 'border border-gray-300 bg-white text-gray-800' : 'bg-gray-900 text-white hover:bg-gray-800'}`}>
            {open ? <><X className="w-3.5 h-3.5" aria-hidden />Close</> : <><Plus className="w-3.5 h-3.5" aria-hidden />Add expense</>}
          </button>
        </div>
      }>
      {error && <p role="alert" className="px-3 pt-2 text-xs font-medium text-red-700">{error}</p>}

      {open && (
        <form className="px-3 py-3 grid grid-cols-2 md:grid-cols-6 gap-3 border-b border-gray-100" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <label className="block"><span className={LABEL}>Paid on</span>
            <input type="date" className={INPUT} value={form.date} onChange={(e) => { set('date', e.target.value); if (e.target.value.length >= 7) set('month', e.target.value.slice(0, 7)) }} required /></label>
          <label className="block"><span className={LABEL}>For month</span>
            <input type="month" className={INPUT} value={form.month} onChange={(e) => set('month', e.target.value)} required /></label>
          <label className="block"><span className={LABEL}>Kind</span>
            <select className={INPUT} value={form.category} onChange={(e) => set('category', e.target.value as ExpenseCategory)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)}
            </select></label>
          <label className="block md:col-span-3"><span className={LABEL}>Paid to</span>
            <input className={INPUT} value={form.payee} onChange={(e) => set('payee', e.target.value)} placeholder="Masroor Khan · Office rent · Alibaba — vendor name" required /></label>
          <label className="block"><span className={LABEL}>Amount</span>
            <input inputMode="decimal" className={INPUT} value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="210000" required /></label>
          <label className="block"><span className={LABEL}>Currency</span>
            <select className={INPUT} value={form.currency} onChange={(e) => set('currency', e.target.value as SaleCurrency)}>
              {SALE_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select></label>
          {form.currency !== 'PKR' && (
            <label className="block"><span className={LABEL}>Rate (PKR per {form.currency})</span>
              <input inputMode="decimal" className={INPUT} value={form.rate} onChange={(e) => set('rate', e.target.value)} placeholder="what you paid at" /></label>
          )}
          <label className={`block col-span-2 ${form.currency !== 'PKR' ? 'md:col-span-2' : 'md:col-span-3'}`}><span className={LABEL}>Note</span>
            <input className={INPUT} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="optional" /></label>
          <div className="col-span-2 md:col-span-1 flex items-end justify-end">
            <button type="submit" disabled={busy} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>Save</button>
          </div>
        </form>
      )}

      {rows !== null && shown.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
          <span className="font-semibold text-gray-900">{view ? monthLabel(view) : 'All months'}: <span className="tabular-nums">{money(Math.round(total), 'PKR')}</span>{estimated && <i className="text-gray-500"> est.</i>}</span>
          {byCategory.map(([c, v]) => <span key={c} className="text-gray-600">{EXPENSE_CATEGORY_LABEL[c]} <span className="tabular-nums">{money(Math.round(v), 'PKR')}</span></span>)}
          {view && monthProfitPkr !== null && (
            <span className={`ml-auto font-semibold tabular-nums ${monthProfitPkr - total >= 0 ? 'text-green-700' : 'text-red-700'}`}>
              Net after expenses {money(Math.round(monthProfitPkr - total), 'PKR')}
            </span>
          )}
        </div>
      )}

      {rows === null ? <p className="px-3 py-4 text-xs text-gray-500">Loading…</p>
        : shown.length === 0 ? <EmptyState icon={Wallet} title={view ? `No expenses for ${monthLabel(view)}` : 'No expenses recorded yet'} hint="Salaries, office costs and vendor payments go here, one line per payment." />
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-gray-200">
                <th className={TH}>Paid</th><th className={TH}>Month</th><th className={TH}>Kind</th><th className={TH}>Paid to</th>
                <th className={`${TH} text-right`}>Amount</th><th className={`${TH} text-right`}>PKR</th><th className={TH}>Note</th><th className={TH} />
              </tr></thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100">
                    <td className={`${TD} tabular-nums`}>{shortDate(e.date)}</td>
                    <td className={TD}>{monthLabel(e.month)}</td>
                    <td className={TD}>{EXPENSE_CATEGORY_LABEL[e.category]}</td>
                    <td className="px-3 py-2 font-semibold text-gray-900">{e.payee}</td>
                    <td className={`${TD} text-right tabular-nums`}>{money(e.amount, e.currency)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{e.pkr.missing ? <span className="text-amber-700">needs rate</span> : <>{money(Math.round(e.pkr.value), 'PKR')}{e.pkr.estimated && <i className="text-gray-500"> est.</i>}</>}</td>
                    <td className="px-3 py-2 text-gray-600 max-w-[16rem] truncate" title={e.note}>{e.note || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => remove(e)} disabled={busy} className="text-gray-400 hover:text-red-600" aria-label="Delete expense"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Card>
  )
}

// ── Net profit (without SEO cost) ───────────────────────────────────────────
// The Profit card is per-sale: revenue minus that order's own costs. The
// office — salaries, rent, equipment, vendors — is paid out of the same money
// and never appeared against it, so the owner read a Rs 538k "profit" for a
// quarter the business was down on. This card subtracts the expenses of the
// same period from Model Town's direct-sales profit. Hamdan's partner stream
// is not in it (that money is the partner's to pay), and the SEO the owner
// runs himself is deliberately not an expense here — hence the label.
//
// Refunded and cancelled sales are already out of `t.profitPkr` (totals()
// skips closed sales), so nothing is subtracted a second time here.
export function NetProfitCard({ month, t, avgMargin, awaitingRevenuePkr, version }: {
  /** YYYY-MM, or '' for every month on record. */
  month: string
  /** Model Town direct totals for the same period. */
  t: { profitPkr: number; profitSales: number; awaitingCosting: number; revenuePkr: number; profitEstimated: boolean }
  /** Profit ÷ revenue over the costed sales of the period — used to estimate the rest. */
  avgMargin: number | null
  /** Net money received (PKR) on the sales still awaiting costing. */
  awaitingRevenuePkr: number
  /** Bumped when expenses change. */
  version: number
}) {
  const [rows, setRows] = useState<ExpenseRow[] | null>(null)
  useEffect(() => {
    let alive = true
    void fetch('/api/sales/expenses').then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setRows(j.expenses) })
    return () => { alive = false }
  }, [version])

  const shown = (rows ?? []).filter((e) => !month || e.month === month)
  const expenses = Math.round(shown.reduce((a, e) => a + e.pkr.value, 0))
  const expEstimated = shown.some((e) => e.pkr.estimated || e.pkr.missing)
  const net = t.profitPkr - expenses
  const estExtra = avgMargin !== null && t.awaitingCosting > 0 ? Math.round(awaitingRevenuePkr * avgMargin) : null
  const period = month ? monthLabel(month) : 'All months'
  const tone = (n: number) => (n >= 0 ? 'text-green-700' : 'text-red-700')

  return (
    <Card title={`Net profit (without SEO cost) — Model Town Direct · ${period}`} icon={Wallet} className="mb-4">
      {rows === null ? <p className="px-3 py-4 text-xs text-gray-500">Loading…</p> : (
        <div className="px-3 py-3 grid grid-cols-1 md:grid-cols-[repeat(3,auto)_1fr] gap-x-6 gap-y-2 items-baseline text-sm">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Sales profit</p>
            <p className="tabular-nums font-semibold text-gray-900">{money(t.profitPkr, 'PKR')}{t.profitEstimated && <i className="text-gray-500 text-xs"> est.</i>}</p>
            <p className="text-[10px] text-gray-500">{t.profitSales} costed sale{t.profitSales === 1 ? '' : 's'}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">− Expenses</p>
            <p className="tabular-nums font-semibold text-gray-900">{money(expenses, 'PKR')}{expEstimated && <i className="text-gray-500 text-xs"> est.</i>}</p>
            <p className="text-[10px] text-gray-500">{shown.length} line{shown.length === 1 ? '' : 's'} · salaries, office, vendors</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">= Net profit</p>
            <p className={`tabular-nums text-xl font-bold ${tone(net)}`}>{money(net, 'PKR')}</p>
            <p className="text-[10px] text-gray-500">without SEO cost</p>
          </div>
          <div className="text-xs text-gray-600 md:text-right">
            {t.awaitingCosting > 0 ? (
              estExtra !== null ? (
                <>
                  <p>{t.awaitingCosting} sale{t.awaitingCosting === 1 ? '' : 's'} still awaiting costing — about <b className="tabular-nums">{money(estExtra, 'PKR')}</b> more profit on the {money(Math.round(awaitingRevenuePkr), 'PKR')} received so far, at the {Math.round((avgMargin ?? 0) * 100)}% average margin of the costed ones.</p>
                  <p className={`mt-0.5 font-semibold tabular-nums ${tone(net + estExtra)}`}>Estimated net once costed: {money(net + estExtra, 'PKR')}</p>
                </>
              ) : <p>{t.awaitingCosting} sale{t.awaitingCosting === 1 ? '' : 's'} awaiting costing — not counted yet (no costed sale to estimate a margin from).</p>
            ) : <p>Every sale in this period is costed.</p>}
          </div>
        </div>
      )}
    </Card>
  )
}
