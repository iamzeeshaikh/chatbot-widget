'use client'
// Growth — one month of Model Town direct sales against the target, and the
// numbers that move it (app/api/growth). Owners only.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight, Target } from 'lucide-react'

interface Week { label: string; leads: number; orders: number; sales: number; medianReplyMin: number | null }
interface Data {
  month: string; target: number; days: number; elapsedDays: number
  orderValue: number; received: number; orders: number; avgOrder: number | null
  leads: number; conversion: number | null
  medianReplyMin: number | null; within15: number | null; unanswered: number
  revenuePkr: number; expensesPkr: number; estNetPkr: number; netMargin: number | null
  costedOrders: number; marginCosted: number | null
  pace: number; projected: number | null; neededPerDay: number | null; ordersNeeded: number | null
  weeks: Week[]
}

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`)
const pkr = (n: number) => `Rs ${Math.round(n).toLocaleString('en-PK')}`
const pct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`)
const mins = (n: number | null) => (n == null ? '—' : n < 60 ? `${Math.round(n)} min` : `${(n / 60).toFixed(1)} h`)
const shift = (m: string, k: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` }
const monthName = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][mo - 1]} ${y}` }

// The level each number should reach for the target (owner's plan, Nov 2026).
const GOALS = { conversion: 0.045, avgOrder: 2500, replyMin: 15, margin: 0.25 }

function Tile({ label, value, sub, good }: { label: string; value: string; sub?: string; good?: boolean | null }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${good === true ? 'text-emerald-700' : good === false ? 'text-amber-700' : 'text-gray-900'}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </div>
  )
}

export default function GrowthPage() {
  const [month, setMonth] = useState<string | null>(null)
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    try { document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark') } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    let live = true
    void Promise.resolve().then(() => { setData(null); setErr('') })
    fetch(`/api/growth${month ? `?month=${month}` : ''}`).then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!live) return
      if (!r.ok) { setErr(j.error || 'Could not load'); return }
      setData(j); if (!month) setMonth(j.month)
    })
    return () => { live = false }
  }, [month])

  const d = data
  const progress = d ? Math.min(1, d.orderValue / d.target) : 0
  const paceAt = d ? Math.min(1, d.pace / d.target) : 0
  const ahead = d ? d.orderValue >= d.pace : false

  return (
    <main className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link href="/" aria-label="Back" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"><ArrowLeft size={16} aria-hidden /></Link>
          <div className="flex-1">
            <h1 className="text-base font-bold text-gray-900 flex items-center gap-2"><Target size={16} aria-hidden /> Growth</h1>
            <p className="text-xs text-gray-500">Model Town direct sales against the monthly target, and what moves it.</p>
          </div>
          {month && (
            <div className="flex items-center gap-1">
              <button aria-label="Previous month" onClick={() => setMonth(shift(month, -1))} className="p-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"><ChevronLeft size={15} aria-hidden /></button>
              <span className="px-2 text-sm font-semibold text-gray-900 tabular-nums">{monthName(month)}</span>
              <button aria-label="Next month" onClick={() => setMonth(shift(month, 1))} className="p-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"><ChevronRight size={15} aria-hidden /></button>
            </div>
          )}
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-4 space-y-4">
        {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
        {!d && !err && <p className="text-sm text-gray-500">Loading…</p>}
        {d && (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Sales this month</p>
                  <p className="text-3xl font-bold tabular-nums text-gray-900">{usd(d.orderValue)} <span className="text-base font-medium text-gray-500">of {usd(d.target)}</span></p>
                </div>
                <div className="text-right text-sm">
                  <p className={ahead ? 'font-semibold text-emerald-700' : 'font-semibold text-amber-700'}>{ahead ? 'Ahead of pace' : 'Behind pace'} · should be at {usd(d.pace)} by today</p>
                  <p className="text-gray-600">At this rate: <b className="tabular-nums">{usd(d.projected)}</b> by month end</p>
                </div>
              </div>
              <div className="mt-3 relative h-3 rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-3 ${ahead ? 'bg-emerald-600' : 'bg-amber-500'}`} style={{ width: `${progress * 100}%` }} />
                <div className="absolute top-0 h-3 w-0.5 bg-gray-700" style={{ left: `${paceAt * 100}%` }} title="Where we should be today" />
              </div>
              <p className="mt-2 text-xs text-gray-600">
                {d.orders} orders · {usd(d.received)} received · day {Math.floor(d.elapsedDays)} of {d.days}
                {d.neededPerDay != null && d.neededPerDay > 0 && <> · needs <b>{usd(d.neededPerDay)}</b> a day{d.ordersNeeded ? <> (about <b>{d.ordersNeeded}</b> more orders at the current average)</> : null}</>}
              </p>
            </section>

            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Tile label="Leads" value={String(d.leads)} sub="billable, this month" />
              <Tile label="First reply (median)" value={mins(d.medianReplyMin)} good={d.medianReplyMin == null ? null : d.medianReplyMin <= GOALS.replyMin}
                sub={`${pct(d.within15)} within 15 min · ${d.unanswered} not answered · goal ≤ ${GOALS.replyMin} min`} />
              <Tile label="Conversion" value={pct(d.conversion)} good={d.conversion == null ? null : d.conversion >= GOALS.conversion}
                sub={`orders ÷ leads · goal ${pct(GOALS.conversion)}`} />
              <Tile label="Average order" value={usd(d.avgOrder)} good={d.avgOrder == null ? null : d.avgOrder >= GOALS.avgOrder}
                sub={`goal ${usd(GOALS.avgOrder)}`} />
            </section>

            <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Tile label="Net margin (estimate)" value={pct(d.netMargin)} good={d.netMargin == null ? null : d.netMargin >= GOALS.margin}
                sub={`after production, shipping and expenses · goal ${pct(GOALS.margin)}`} />
              <Tile label="Net profit (estimate)" value={pkr(d.estNetPkr)} sub={`${d.costedOrders} of ${d.orders} orders costed; the rest at their average margin`} />
              <Tile label="Expenses" value={pkr(d.expensesPkr)} sub="salaries, SEO, office, graphic work" />
            </section>

            <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <h2 className="px-4 pt-3 text-sm font-bold text-gray-900">Week by week</h2>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <th className="px-4 py-2">Week</th><th className="px-4 py-2 text-right">Leads</th><th className="px-4 py-2 text-right">Orders</th>
                  <th className="px-4 py-2 text-right">Sales</th><th className="px-4 py-2 text-right">First reply</th></tr></thead>
                <tbody>
                  {d.weeks.map((w) => (
                    <tr key={w.label} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-2 text-gray-800">{w.label}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{w.leads}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{w.orders}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-semibold">{usd(w.sales)}</td>
                      <td className={`px-4 py-2 text-right tabular-nums ${w.medianReplyMin != null && w.medianReplyMin > GOALS.replyMin ? 'text-amber-700' : 'text-gray-700'}`}>{mins(w.medianReplyMin)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <p className="text-xs text-gray-500">Target $60,000 a month at a 25% net margin. A sale counts in the month its order was placed; a weekly target is about {usd(d.target / (d.days / 7))}.</p>
          </>
        )}
      </div>
    </main>
  )
}
