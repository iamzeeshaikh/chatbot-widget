'use client'

// Opportunities — /opportunities (packaging only).
//
// Four lists the agents work from, all derived from what the customer and the
// agent actually wrote (lib/opportunities.ts): who is waiting on us, which
// invoices are unpaid, which quotes can close this month, and older deals
// worth reviving. Everyone sees every amount and the whole leaderboard — the
// owner's rule, 2026-10-20. Nothing is edited here; every row opens the lead
// record, where the work happens.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, RefreshCw, TriangleAlert, Lock, Clock, Receipt, Flame, History, Trophy,
  Mail, MessageCircle, Ban, CircleDollarSign,
} from 'lucide-react'
import { Card, EmptyState } from '@/app/leads/[id]/ui'
import { CRM_STAGE_LABEL, CRM_STAGE_STYLE } from '@/lib/crm'
import { timeAgo, formatDateTime } from '@/lib/datetime'
import type { OpportunitiesResult, OppItem } from '@/lib/opportunityload'

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40'

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${Math.round(n).toLocaleString('en-US')}`

function waitLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

export default function OpportunitiesPage() {
  const [data, setData] = useState<OpportunitiesResult | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'unavailable'>('loading')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [showAllOlder, setShowAllOlder] = useState(false)

  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode */ }
  }, [])

  const load = useCallback(async (fresh = false) => {
    const res = await fetch(`/api/opportunities${fresh ? '?fresh=1' : ''}`).catch(() => null)
    if (!res) { setError('Could not reach the server.'); setStatus('error'); return }
    if (res.status === 401) { window.location.href = '/login'; return }
    if (res.status === 403) { setStatus('unavailable'); return }
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error || 'Could not load opportunities.')
      setStatus('error')
      return
    }
    setData(await res.json())
    setStatus('ok')
    setError('')
  }, [])

  // Deferred a tick so the first fetch is not a state update inside the
  // effect body itself.
  useEffect(() => {
    const t = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const refresh = async () => { setRefreshing(true); await load(true); setRefreshing(false) }

  if (status === 'loading') {
    return (
      <Shell>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-200 animate-pulse" />)}
        </div>
        <p className="text-xs text-gray-500">Reading every quote, reply and invoice from the last three months…</p>
      </Shell>
    )
  }
  if (status === 'unavailable') {
    return (
      <Shell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <Lock className="mx-auto w-6 h-6 text-gray-400" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">Opportunities are not part of this dashboard</p>
          <Link href="/" className="mt-4 inline-block text-xs font-semibold text-blue-700 hover:underline">Back to the dashboard</Link>
        </div>
      </Shell>
    )
  }
  if (status === 'error' || !data) {
    return (
      <Shell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <TriangleAlert className="mx-auto w-6 h-6 text-red-500" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">{error || 'Could not load opportunities.'}</p>
          <button type="button" onClick={() => { setStatus('loading'); void load(true) }} className={`${BTN} mt-4 bg-gray-900 text-white hover:bg-gray-800`}>Try again</button>
        </div>
      </Shell>
    )
  }

  const s = data.strip
  const older = showAllOlder ? data.older : data.older.slice(0, 25)

  return (
    <Shell
      subtitle={`Packaging · ${data.monthLabel} · updated ${timeAgo(data.generatedAt)}`}
      actions={
        <button type="button" onClick={refresh} disabled={refreshing} className={`${BTN} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}>
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />Refresh
        </button>
      }>
      {data.truncated && (
        <p role="alert" className="mb-3 text-xs font-medium text-amber-800">Some history was left out because a row limit was reached — the oldest weeks may be incomplete.</p>
      )}

      {/* Top strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
        <Stat label={`Booked in ${data.monthLabel.split(' ')[0]}`} value={usd(s.bookedUsd)} hint={`${s.bookedCount} sale${s.bookedCount === 1 ? '' : 's'} in the Sales ledger`} tone="good" />
        <Stat label="Invoices due" value={usd(s.invoicesDueUsd)} hint={`${s.invoicesDueCount} sent, not paid`} tone={s.invoicesDueCount ? 'warn' : 'default'} />
        <Stat label="Hot quotes" value={usd(s.hotUsd)} hint={`${s.hotCount} can close this month`} tone="good" />
        <Stat label="Waiting on us" value={String(s.waitingCount)} hint={s.waitingOver24 ? `${s.waitingOver24} over 24 hours` : 'none over 24 hours'} tone={s.waitingOver24 ? 'bad' : 'default'} />
      </div>

      {/* Leaderboard — visible to everyone, by the owner's decision. */}
      <Card title={`Leaderboard — ${data.monthLabel}`} icon={Trophy} className="mb-4">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wider text-gray-500">
                <th className="px-3 py-2 font-semibold">Agent</th>
                <th className="px-3 py-2 font-semibold text-right">Won</th>
                <th className="px-3 py-2 font-semibold text-right">Won $</th>
                <th className="px-3 py-2 font-semibold text-right">Pipeline $</th>
                <th className="px-3 py-2 font-semibold text-right">Hot</th>
                <th className="px-3 py-2 font-semibold text-right">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {data.leaderboard.map((r, i) => (
                <tr key={r.agent || '__none'} className="border-b border-gray-100">
                  <td className="px-3 py-2 font-semibold text-gray-900 whitespace-nowrap">
                    <span className="inline-block w-5 text-gray-400 tabular-nums">{i + 1}</span>{r.name}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{r.wonCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-green-700">{usd(r.wonUsd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{usd(r.pipelineUsd)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-700">{r.hot}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.waiting ? 'font-semibold text-red-700' : 'text-gray-700'}`}>{r.waiting}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3 py-2 text-[10px] text-gray-500">Won = sales booked this month in the Sales ledger. Pipeline = hot quotes plus unpaid invoices on that agent&apos;s leads.</p>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section title="Customer waiting on us" icon={Clock} count={data.waiting.length}
          hint="The customer wrote last and nobody has answered yet. Red after 24 hours."
          empty="Nobody is waiting on a reply.">
          {data.waiting.map((i) => (
            <Row key={i.id} item={i}
              badge={<span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums ${(i.hours ?? 0) >= 24 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-800 border border-amber-300'}`}>{waitLabel(i.hours ?? 0)}</span>}
              extra={<>{i.channel === 'whatsapp' ? <MessageCircle className="w-3 h-3" aria-label="WhatsApp" /> : <Mail className="w-3 h-3" aria-label="Email" />}{i.hot && <Chip tone="hot">hot</Chip>}</>} />
          ))}
        </Section>

        <Section title="Invoice sent — payment due" icon={Receipt} count={data.invoices.length}
          hint="An invoice or payment link went out and no paid sale in the Sales ledger matches it."
          empty="No unpaid invoices.">
          {data.invoices.map((i) => (
            <Row key={i.id} item={i} amount={i.invoice?.amount ?? null}
              extra={<>
                <span className="text-gray-600">{i.invoice?.label} · sent {timeAgo(i.invoice?.sentAt)}</span>
                {i.invoice?.customerSaysPaid && <Chip tone="good">customer says paid — record it in Sales</Chip>}
                {i.invoice?.wonNoSale && <Chip tone="warn">Won, not in the Sales ledger</Chip>}
                {i.invoice?.partial && <Chip tone="warn">part paid</Chip>}
                {i.waiting && <Chip tone="bad">waiting on us</Chip>}
              </>} />
          ))}
        </Section>

        <Section title="Can close this month" icon={Flame} count={data.hot.length}
          hint="A price went out and the customer answered it with a buying signal in the last two weeks."
          empty="No hot quotes right now.">
          {data.hot.map((i) => (
            <Row key={i.id} item={i} amount={i.quote}
              extra={<>{i.reason && <Chip tone="hot">{i.reason}</Chip>}{i.waiting && <Chip tone="bad">waiting on us</Chip>}</>} />
          ))}
        </Section>

        <Section title="Older opportunities — before this month" icon={History} count={data.older.length}
          hint="Still open, and the customer engaged at some point. Biggest quotes first."
          empty="Nothing older to revive.">
          {older.map((i) => (
            <Row key={i.id} item={i} amount={i.quote}
              extra={<>{i.waiting && <Chip tone="bad">waiting on us</Chip>}</>} />
          ))}
          {data.older.length > 25 && !showAllOlder && (
            <li className="px-3 py-2">
              <button type="button" onClick={() => setShowAllOlder(true)} className="text-xs font-semibold text-blue-700 hover:underline">Show all {data.older.length}</button>
            </li>
          )}
        </Section>
      </div>

      <p className="mt-4 text-[11px] text-gray-500 flex items-start gap-1.5">
        <Ban className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
        Left out: deals where the customer said they went with another company, found it too expensive or are not going ahead
        {data.excluded.restricted ? `, and ${data.excluded.restricted} alcohol or religious order${data.excluded.restricted === 1 ? '' : 's'} (decline those)` : ''}
        {data.excluded.notALead ? ` · ${data.excluded.notALead} marked “not a lead”` : ''}.
        Covers leads since {formatDateTime(data.windowFrom).split(',')[0]}.
      </p>
    </Shell>
  )
}

function Shell({ children, subtitle, actions }: { children: React.ReactNode; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3 flex-wrap">
          <Link href="/" className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100" aria-label="Back to the dashboard">
            <ArrowLeft className="w-4 h-4" aria-hidden />
          </Link>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900 leading-tight">Opportunities</h1>
            {subtitle && <p className="text-[11px] text-gray-500 leading-tight">{subtitle}</p>}
          </div>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-3 sm:px-5 py-4">{children}</main>
    </div>
  )
}

function Stat({ label, value, hint, tone = 'default' }: { label: string; value: string; hint?: string; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'text-green-700' : tone === 'warn' ? 'text-amber-700' : tone === 'bad' ? 'text-red-700' : 'text-gray-900'
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-3 py-2.5 min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-0.5 text-xl font-bold tabular-nums truncate ${color}`}>{value}</p>
      {hint && <p className="text-[10px] text-gray-500 truncate">{hint}</p>}
    </div>
  )
}

function Section({ title, icon, count, hint, empty, children }: {
  title: string; icon: typeof Clock; count: number; hint: string; empty: string; children: React.ReactNode
}) {
  return (
    <Card title={`${title} · ${count}`} icon={icon}>
      <p className="px-3 pt-2 text-[11px] text-gray-500">{hint}</p>
      {count === 0
        ? <EmptyState icon={CircleDollarSign} title={empty} />
        : <ul className="divide-y divide-gray-100 max-h-[640px] overflow-y-auto">{children}</ul>}
    </Card>
  )
}

function Chip({ tone, children }: { tone: 'hot' | 'good' | 'warn' | 'bad'; children: React.ReactNode }) {
  const cls = tone === 'hot' ? 'bg-orange-100 text-orange-800 border-orange-300'
    : tone === 'good' ? 'bg-green-100 text-green-800 border-green-300'
      : tone === 'warn' ? 'bg-amber-100 text-amber-800 border-amber-300'
        : 'bg-red-100 text-red-800 border-red-300'
  return <span className={`rounded-full border px-1.5 py-px text-[10px] font-semibold ${cls}`}>{children}</span>
}

function Row({ item: i, amount, badge, extra }: { item: OppItem; amount?: number | null; badge?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <li>
      <a href={`/leads/${encodeURIComponent(i.id)}`} className="block px-3 py-2.5 hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50">
        <div className="flex items-center gap-2 min-w-0">
          {badge}
          <span className="font-semibold text-sm text-gray-900 truncate">{i.name}</span>
          <span className="text-[11px] text-gray-500 truncate">{i.siteName}</span>
          {amount !== undefined && <span className="ml-auto shrink-0 text-sm font-bold tabular-nums text-gray-900">{usd(amount)}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600">
          <span className={`rounded-full border px-1.5 py-px text-[10px] font-semibold ${CRM_STAGE_STYLE[i.stage] ?? ''}`}>{CRM_STAGE_LABEL[i.stage] ?? i.stage}</span>
          <span className="text-gray-500">{i.ownerName}</span>
          {i.restricted && <Chip tone="bad">decline — {i.restricted}</Chip>}
          {extra}
        </div>
        {i.lastLine && (
          <p className="mt-1 text-xs text-gray-700 line-clamp-2">
            <span className="text-gray-500">{timeAgo(i.lastLineAt)}: </span>“{i.lastLine}”
          </p>
        )}
      </a>
    </li>
  )
}
