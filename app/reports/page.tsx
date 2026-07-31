'use client'

// Month-end performance report — /reports, reached from the Performance tab.
//
// Client-facing numbers, so the screen, the CSVs and the PDF are all rendered
// from ONE payload: /api/admin/report returns the data, and the export formats
// are the same object serialised differently. They cannot drift.
//
// Built from the record page's design system — Card, the four-step type scale,
// tabular numbers, lucide at one stroke weight — in the light Tailwind
// utilities globals.css remaps, so dark mode follows the dashboard.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Download, FileSpreadsheet, FileText, ArrowUp, ArrowDown,
  ChevronsUpDown, TriangleAlert, BarChart3, Users, Globe, CalendarDays,
} from 'lucide-react'
import { formatDateTime } from '@/lib/datetime'
import { pct, durationLabel, type ReportData, type Metrics, type AgentRow, type SiteRow, type DayRow } from '@/lib/report'
import { Card, Skeleton } from '@/app/leads/[id]/ui'

type Preset = 'this-month' | 'last-month' | 'last-7' | 'last-30' | 'custom'

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'last-7', label: 'Last 7 days' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'custom', label: 'Custom range' },
]

export default function ReportsPage() {
  const [preset, setPreset] = useState<Preset>('last-month')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [data, setData] = useState<ReportData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'forbidden'>('loading')
  const [error, setError] = useState('')
  // Which site the client-facing leads PDF covers. Blank = every site in scope.
  const [leadsSite, setLeadsSite] = useState('')

  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode */ }
  }, [])

  const query = useMemo(() => {
    const qs = new URLSearchParams({ preset })
    if (preset === 'custom') { qs.set('from', customFrom); qs.set('to', customTo) }
    return qs.toString()
  }, [preset, customFrom, customTo])

  const ready = preset !== 'custom' || (!!customFrom && !!customTo)

  const load = useCallback((): Promise<void> => {
    if (!ready) return Promise.resolve()
    return fetch(`/api/admin/report?${query}`)
      .then(async (res) => {
        if (res.status === 401) { window.location.href = '/login'; return }
        if (res.status === 403) { setStatus('forbidden'); return }
        if (!res.ok) {
          setError((await res.json().catch(() => ({}))).error || 'Could not build the report')
          setStatus('error')
          return
        }
        setData(await res.json())
        setStatus('ok')
        setError('')
      })
      .catch(() => setStatus('error'))
  }, [query, ready])

  useEffect(() => { load() }, [load])

  const href = (format: string) => `/api/admin/report?${query}&format=${format}`
  const leadsHref = `${href('leads.pdf')}${leadsSite ? `&site=${encodeURIComponent(leadsSite)}` : ''}`

  if (status === 'forbidden') {
    return (
      <Shell>
        <Card>
          <p className="px-4 py-6 text-center text-sm font-semibold text-gray-800">Admins only</p>
          <p className="px-4 pb-6 text-center text-xs text-gray-500">
            The performance report covers every agent, so it is limited to workspace admins.
          </p>
        </Card>
      </Shell>
    )
  }

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <Link href="/" title="Back to the dashboard" aria-label="Back to the dashboard"
              className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            </Link>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-gray-900 leading-tight">Performance report</h1>
              <p className="text-[11px] text-gray-500 leading-tight">
                {status === 'loading' ? 'Building…' : data ? `${data.workspaceLabel} · ${data.periodLabel}` : '—'}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              {/* The client-facing one: every lead itemised with billable
                  marked. Kept first because it is what gets sent out. */}
              {/* A client owns one site, so the leads document can be narrowed
                  to just theirs before it is sent. */}
              <select value={leadsSite} onChange={(e) => setLeadsSite(e.target.value)}
                aria-label="Site for the leads PDF" title="Limit the leads PDF to one site"
                className="bg-gray-100 border border-gray-200 rounded-lg px-1.5 py-1.5 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-500 max-w-[150px]">
                <option value="">All sites</option>
                {(data?.sites ?? []).map((s) => (
                  <option key={s.siteId} value={s.siteId} className="bg-white text-gray-800">{s.siteName}</option>
                ))}
              </select>
              <ExportLink href={leadsHref} icon={FileText} label="Leads PDF" primary disabled={!data} />
              <ExportLink href={href('pdf')} icon={FileText} label="Performance PDF" disabled={!data} />
              <ExportLink href={href('agents.csv')} icon={FileSpreadsheet} label="Agents" disabled={!data} />
              <ExportLink href={href('sites.csv')} icon={FileSpreadsheet} label="Sites" disabled={!data} />
              <ExportLink href={href('daily.csv')} icon={FileSpreadsheet} label="Daily" disabled={!data} />
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-2">
            <div className="flex gap-0.5 bg-gray-100 p-0.5 rounded-lg border border-gray-200" role="tablist" aria-label="Date range">
              {PRESETS.map((p) => (
                <button key={p.key} role="tab" aria-selected={preset === p.key} onClick={() => setPreset(p.key)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    preset === p.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <span className="flex items-center gap-1.5">
                <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date"
                  className="bg-gray-100 border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px] text-gray-800 tabular-nums focus:outline-none focus:border-blue-500" />
                <span className="text-[11px] text-gray-500">to</span>
                <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date"
                  className="bg-gray-100 border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px] text-gray-800 tabular-nums focus:outline-none focus:border-blue-500" />
                <span className="text-[10px] text-gray-400">PKT</span>
              </span>
            )}
            {data && (
              <span className="text-[10px] text-gray-400 tabular-nums ml-auto">
                Generated {formatDateTime(data.generatedAt)} PKT
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1500px] mx-auto px-3 sm:px-5 py-3 space-y-3 animate-in">
        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
            <TriangleAlert size={12} strokeWidth={2} aria-hidden />{error}
          </p>
        )}
        {data?.truncated && (
          <p className="flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            <TriangleAlert size={12} strokeWidth={2} aria-hidden />
            This range exceeded the row cap — narrow it for exact figures.
          </p>
        )}
        {preset === 'custom' && !ready && (
          <p className="text-[11px] text-gray-500 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5">
            Pick a start and end date to build the report.
          </p>
        )}

        <Summary data={data} loading={status === 'loading'} />

        <Card title="Per agent" icon={Users}>
          <SortableTable
            loading={status === 'loading'}
            columns={[
              { key: 'email', label: 'Agent' },
              { key: 'chats', label: 'Chats handled', num: true },
              { key: 'replies', label: 'Replies', num: true },
              { key: 'leads', label: 'Leads', num: true },
              { key: 'avgResponseMs', label: 'Avg response', num: true },
              { key: 'slowReplies', label: 'Slow replies', num: true },
              { key: 'measuredReplies', label: 'Measured', num: true },
            ]}
            rows={data?.agents ?? []}
            render={(a: AgentRow, key) => {
              switch (key) {
                case 'email': return <span className={a.active ? 'font-medium text-gray-900' : 'text-gray-500'}>{a.email.split('@')[0]}</span>
                case 'avgResponseMs': return durationLabel(a.avgResponseMs)
                default: return String((a as unknown as Record<string, number>)[key] ?? 0)
              }
            }}
            totals={data ? [
              'TOTAL', String(data.agentTotals.chats), String(data.agentTotals.replies),
              String(data.agentTotals.leads), '—', String(data.agentTotals.slowReplies), String(data.agentTotals.measuredReplies),
            ] : null}
            emptyText="No agents in this workspace."
          />
          <p className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-100">
            A chat replied to by two agents is credited to both, so these totals can exceed the workspace figure.
            {data && data.unattributedReplies > 0 && ` ${data.unattributedReplies} repl${data.unattributedReplies === 1 ? 'y' : 'ies'} predate author tracking and are unattributed.`}
          </p>
        </Card>

        <Card title="Per site" icon={Globe}>
          <MetricTable loading={status === 'loading'} rows={data?.sites ?? []} firstKey="siteName" firstLabel="Site"
            totals={data?.totals ?? null} emptyText="No sites in scope." />
        </Card>

        <Card title="Daily trend" icon={CalendarDays}>
          <MetricTable loading={status === 'loading'} rows={data?.days ?? []} firstKey="date" firstLabel="Date (PKT)"
            totals={data?.totals ?? null} emptyText="No days in this range." />
        </Card>
      </main>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="max-w-sm w-full">{children}</div>
    </div>
  )
}

function ExportLink({ href, icon: Icon, label, primary, disabled }: {
  href: string; icon: typeof FileText; label: string; primary?: boolean; disabled?: boolean
}) {
  const cls = primary
    ? 'bg-blue-600 text-white hover:bg-blue-700'
    : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-100'
  if (disabled) {
    return (
      <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg border border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed`}>
        <Icon size={12} strokeWidth={2} aria-hidden />{label}
      </span>
    )
  }
  return (
    <a href={href} download
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${cls}`}>
      {primary ? <Download size={12} strokeWidth={2} aria-hidden /> : <Icon size={12} strokeWidth={2} aria-hidden />}
      {label}
    </a>
  )
}

// ── Summary ──────────────────────────────────────────────────────────────────
const TILES: { key: keyof Metrics; label: string; fmt?: (m: Metrics) => string }[] = [
  { key: 'clicks', label: 'Clicks' },
  { key: 'chats', label: 'Chats' },
  { key: 'picked', label: 'Picked up' },
  { key: 'notPicked', label: 'Not picked' },
  { key: 'leads', label: 'Leads' },
  { key: 'checkout', label: 'Checkout' },
  { key: 'billable', label: 'Billable' },
  { key: 'conversionRate', label: 'Conversion', fmt: (m) => pct(m.conversionRate) },
  { key: 'pickupRate', label: 'Pick-up rate', fmt: (m) => pct(m.pickupRate) },
  { key: 'avgResponseMs', label: 'Avg response', fmt: (m) => durationLabel(m.avgResponseMs) },
]

function Summary({ data, loading }: { data: ReportData | null; loading: boolean }) {
  return (
    <Card title="Headline totals" icon={BarChart3}>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-10 divide-x divide-y lg:divide-y-0 divide-gray-100">
        {TILES.map((t) => (
          <div key={t.key} className="px-3 py-2 min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-gray-500 truncate">{t.label}</p>
            {/* Fixed height so the tile never resizes when the number lands. */}
            <div className="h-6 flex items-end">
              {loading || !data
                ? <Skeleton className="h-4 w-12" />
                : <p className="text-base font-bold text-gray-900 tabular-nums leading-none">
                    {t.fmt ? t.fmt(data.totals) : String(data.totals[t.key] ?? 0)}
                  </p>}
            </div>
          </div>
        ))}
      </div>
      <p className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-100 leading-relaxed">
        Billable excludes checkout orders and de-duplicates the same customer across chat and quote.
        Clicks are widget sessions with automated bursts removed.
        {' '}
        <span className="text-gray-600">
          Conversion is leads ÷ chats — leads include quote and checkout leads that arrive by email without any chat,
          so it is not the share of chats that became leads.
        </span>
      </p>
    </Card>
  )
}

// ── Tables ───────────────────────────────────────────────────────────────────
interface ColDef { key: string; label: string; num?: boolean }

function SortableTable<T extends object>({ columns, rows, render, totals, loading, emptyText }: {
  columns: ColDef[]
  rows: T[]
  render: (row: T, key: string) => React.ReactNode
  totals: string[] | null
  loading: boolean
  emptyText: string
}) {
  const [sort, setSort] = useState<string>(columns[1]?.key ?? columns[0].key)
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const mul = dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sort]
      const bv = (b as Record<string, unknown>)[sort]
      if (typeof av === 'number' || typeof bv === 'number' || av === null || bv === null) {
        // Nulls (no measurement) always sink, whichever direction is chosen.
        if (av === null && bv === null) return 0
        if (av === null) return 1
        if (bv === null) return -1
        return ((av as number) - (bv as number)) * mul
      }
      return String(av ?? '').localeCompare(String(bv ?? '')) * mul
    })
  }, [rows, sort, dir])

  function toggle(key: string) {
    if (key === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(key); setDir(columns.find((c) => c.key === key)?.num ? 'desc' : 'asc') }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="border-b border-gray-200">
            {columns.map((c) => {
              const active = sort === c.key
              return (
                <th key={c.key} scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={`px-2.5 py-1.5 ${c.num ? 'text-right' : 'text-left'}`}>
                  <button onClick={() => toggle(c.key)}
                    className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded ${
                      active ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'
                    } ${c.num ? 'flex-row-reverse' : ''}`}>
                    {c.label}
                    {active
                      ? (dir === 'asc' ? <ArrowUp size={10} strokeWidth={2.5} aria-hidden /> : <ArrowDown size={10} strokeWidth={2.5} aria-hidden />)
                      : <ChevronsUpDown size={10} strokeWidth={2} className="text-gray-300" aria-hidden />}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-gray-100">
                  {columns.map((c) => <td key={c.key} className="px-2.5 py-1.5"><Skeleton className="h-3 w-full" /></td>)}
                </tr>
              ))
            : sorted.length === 0
              ? <tr><td colSpan={columns.length} className="px-3 py-4 text-xs text-gray-500">{emptyText}</td></tr>
              : sorted.map((row, i) => (
                  <tr key={i} className="border-b border-gray-100 hover:bg-gray-100 transition-colors">
                    {columns.map((c) => (
                      <td key={c.key} className={`px-2.5 py-1 text-xs ${c.num ? 'text-right tabular-nums text-gray-800' : 'text-gray-900'}`}>
                        {render(row, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
          {!loading && totals && sorted.length > 0 && (
            <tr className="bg-gray-100 border-t border-gray-300">
              {totals.map((v, i) => (
                <td key={i} className={`px-2.5 py-1.5 text-xs font-bold ${columns[i]?.num ? 'text-right tabular-nums' : ''} text-gray-900`}>{v}</td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const METRIC_COLS: ColDef[] = [
  { key: 'clicks', label: 'Clicks', num: true },
  { key: 'chats', label: 'Chats', num: true },
  { key: 'picked', label: 'Picked up', num: true },
  { key: 'notPicked', label: 'Not picked', num: true },
  { key: 'leads', label: 'Leads', num: true },
  { key: 'checkout', label: 'Checkout', num: true },
  { key: 'billable', label: 'Billable', num: true },
  { key: 'conversionRate', label: 'Conversion', num: true },
  { key: 'pickupRate', label: 'Pickup', num: true },
  { key: 'avgResponseMs', label: 'Avg response', num: true },
]

function MetricTable({ rows, firstKey, firstLabel, totals, loading, emptyText }: {
  rows: (SiteRow | DayRow)[]
  firstKey: string
  firstLabel: string
  totals: Metrics | null
  loading: boolean
  emptyText: string
}) {
  return (
    <SortableTable
      loading={loading}
      columns={[{ key: firstKey, label: firstLabel }, ...METRIC_COLS]}
      rows={rows}
      render={(row, key) => {
        const r = row as unknown as Record<string, number | string | null>
        if (key === firstKey) return <span className="font-medium">{String(r[key])}</span>
        if (key === 'conversionRate') return pct(r.conversionRate as number | null)
        if (key === 'pickupRate') return pct(r.pickupRate as number | null)
        if (key === 'avgResponseMs') return durationLabel(r.avgResponseMs as number | null)
        return String(r[key] ?? 0)
      }}
      totals={totals ? [
        'TOTAL', String(totals.clicks), String(totals.chats), String(totals.picked), String(totals.notPicked),
        String(totals.leads), String(totals.checkout), String(totals.billable),
        pct(totals.conversionRate), pct(totals.pickupRate), durationLabel(totals.avgResponseMs),
      ] : null}
      emptyText={emptyText}
    />
  )
}
