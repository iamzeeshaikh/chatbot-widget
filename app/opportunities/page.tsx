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
  Mail, MessageCircle, Ban, CircleDollarSign, X,
  UserX,
  Send, MailCheck,
} from 'lucide-react'
import { Card, EmptyState } from '@/app/leads/[id]/ui'
import { CRM_STAGE_LABEL, CRM_STAGE_STYLE } from '@/lib/crm'
import { timeAgo, formatDateTime } from '@/lib/datetime'
import type { OpportunitiesResult, OppItem } from '@/lib/opportunityload'
import type { FollowUpStats, ReplyMood } from '@/lib/followupstats'

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40'

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${Math.round(n).toLocaleString('en-US')}`

type TabKey = 'drafts' | 'nohuman' | 'waiting' | 'invoices' | 'hot' | 'older'
type FocusKind = 'won' | 'pipeline' | 'hot' | 'waiting' | 'nohuman' | 'drafts'
const FOCUS_LABEL: Record<FocusKind, string> = { won: 'Won this month', pipeline: 'Pipeline (hot quotes + unpaid invoices)', hot: 'Can close this month', waiting: 'Customers waiting on us', nohuman: 'New leads — no reply from a person yet', drafts: 'Bot drafts waiting to be sent' }

function waitLong(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) { const h = Math.round(hours); return `${h} hour${h === 1 ? '' : 's'}` }
  const d = Math.floor(hours / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}


export default function OpportunitiesPage() {
  const [data, setData] = useState<OpportunitiesResult | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'unavailable'>('loading')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [showAllOlder, setShowAllOlder] = useState(false)
  const [tab, setTab] = useState<TabKey>(() => { const l = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('list') : null; return l === 'nohuman' || l === 'drafts' ? l : 'waiting' })
  // Deep link from an alert: ?agent=<key>&list=waiting|hot|pipeline|won opens
  // that agent's list straight away (agent= empty means Unassigned).
  const [focus, setFocus] = useState<{ agent: string; kind: FocusKind } | null>(() => {
    if (typeof window === 'undefined') return null
    const q = new URLSearchParams(window.location.search)
    const list = q.get('list')
    if (!q.has('agent') || !list || !(list in FOCUS_LABEL)) return null
    return { agent: (q.get('agent') ?? '').toLowerCase(), kind: list as FocusKind }
  })

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
  const olderAll = data.older
  const older = showAllOlder ? olderAll : olderAll.slice(0, 25)
  const ownerKey = (i: { owner: string | null }) => i.owner ?? ''
  const agentName = (k: string) => data.leaderboard.find((r) => r.agent === k)?.name ?? 'Unassigned'

  // A leaderboard cell picked: exactly the leads behind that number.
  const filtered = focus && (() => {
    const mine = <T extends { owner: string | null }>(xs: T[]) => xs.filter((i) => ownerKey(i) === focus.agent)
    if (focus.kind === 'won') return { won: mine(data.won), items: [] as OppItem[] }
    if (focus.kind === 'waiting') return { won: [], items: mine(data.waiting) }
    if (focus.kind === 'nohuman') return { won: [], items: mine(data.noHuman ?? []) }
    if (focus.kind === 'drafts') return { won: [], items: mine(data.drafts ?? []) }
    if (focus.kind === 'hot') return { won: [], items: mine(data.hot) }
    return { won: [], items: [...mine(data.invoices), ...mine(data.hot)] }
  })()

  const tabs: { key: TabKey; label: string; count: number; icon: typeof Clock; tone: string }[] = [
    { key: 'drafts', label: 'Bot draft ready · press Send', count: (data.drafts ?? []).length, icon: Send, tone: 'bg-red-700' },
    { key: 'nohuman', label: 'New lead · no reply from a person', count: (data.noHuman ?? []).length, icon: UserX, tone: 'bg-red-700' },
    { key: 'waiting', label: 'Customer waiting on us', count: data.waiting.length, icon: Clock, tone: 'bg-red-600' },
    { key: 'invoices', label: 'Invoice sent · payment due', count: data.invoices.length, icon: Receipt, tone: 'bg-amber-500' },
    { key: 'hot', label: 'Can close this month', count: data.hot.length, icon: Flame, tone: 'bg-orange-500' },
    { key: 'older', label: 'Older opportunities (before this month)', count: olderAll.length, icon: History, tone: 'bg-gray-600' },
  ]

  const waitingRow = (i: OppItem) => (
    <Row key={i.id} item={i} ownerFirst
      badge={<span className={`shrink-0 rounded-md px-2 py-1 text-xs font-bold tabular-nums ${(i.hours ?? 0) >= 24 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-800 border border-amber-300'}`}
        title="How long the customer has been waiting">waiting {waitLong(i.hours ?? 0)}</span>}
      extra={<>{i.channel === 'whatsapp' ? <MessageCircle className="w-3 h-3" aria-label="WhatsApp" /> : <Mail className="w-3 h-3" aria-label="Email" />}{i.hot && <Chip tone="hot">hot</Chip>}</>} />
  )
  const noHumanRow = (i: OppItem) => (
    <Row key={i.id} item={i} ownerFirst
      badge={<span className={`shrink-0 rounded-md px-2 py-1 text-xs font-bold tabular-nums ${(i.hours ?? 0) >= 24 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-800 border border-amber-300'}`}
        title="Since the lead arrived; only the bot has written to them">{waitLong(i.hours ?? 0)} · {i.draftAt !== undefined ? 'draft not sent' : 'bot only'}</span>}
      extra={<>{i.draftAt !== undefined && <Chip tone="warn">bot draft ready — open and press Send</Chip>}{i.waiting && <Chip tone="bad">customer wrote again</Chip>}</>} />
  )
  const draftRow = (i: OppItem) => (
    <Row key={i.id} item={i} ownerFirst
      badge={<span className={`shrink-0 rounded-md px-2 py-1 text-xs font-bold tabular-nums ${(i.hours ?? 0) >= 2 ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-800 border border-amber-300'}`}
        title="The bot drafted the first reply; nobody has pressed Send">draft {waitLong(i.hours ?? 0)} old</span>}
      extra={<>{i.waiting && <Chip tone="bad">customer wrote again</Chip>}</>} />
  )
  const invoiceRow = (i: OppItem) => (
    <Row key={i.id} item={i} amount={i.invoice?.amount ?? null}
      extra={<>
        <span className="text-gray-600">{i.invoice?.label} · sent {timeAgo(i.invoice?.sentAt)}</span>
        {i.invoice?.customerSaysPaid && <Chip tone="good">customer says paid — record it in Sales</Chip>}
        {i.invoice?.wonNoSale && <Chip tone="warn">Won, not in the Sales ledger</Chip>}
        {i.invoice?.partial && <Chip tone="warn">part paid</Chip>}
        {i.waiting && <Chip tone="bad">waiting on us</Chip>}
      </>} />
  )
  const hotRow = (i: OppItem) => (
    <Row key={i.id} item={i} amount={i.quote}
      extra={<>{i.reason && <Chip tone="hot">{i.reason}</Chip>}{i.waiting && <Chip tone="bad">waiting on us</Chip>}</>} />
  )
  const olderRow = (i: OppItem) => (
    <Row key={i.id} item={i} amount={i.quote} extra={<>{i.waiting && <Chip tone="bad">waiting on us</Chip>}</>} />
  )
  const cell = (agent: string, kind: FocusKind, value: React.ReactNode, cls: string) => {
    const on = focus?.agent === agent && focus.kind === kind
    return (
      <td className="px-1 py-1 text-right">
        <button type="button" onClick={() => setFocus(on ? null : { agent, kind })}
          title="Show these leads"
          className={`w-full rounded-md px-2 py-1 text-right tabular-nums underline-offset-2 hover:underline hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? 'bg-blue-100 ring-1 ring-blue-400' : ''} ${cls}`}>
          {value}
        </button>
      </td>
    )
  }

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
        <Stat label="Waiting on us" value={String(s.waitingCount)} hint={`${s.waitingOver24 ? `${s.waitingOver24} over 24 hours` : 'none over 24 hours'} · ${s.noHumanCount ?? 0} new with no reply from a person`} tone={s.waitingOver24 || s.noHumanCount ? 'bad' : 'default'} />
      </div>

      {/* Leaderboard — visible to everyone, by the owner's decision. Every
          number opens exactly the leads behind it. */}
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
                <th className="px-3 py-2 font-semibold text-right" title="New leads only the bot has answered">No reply yet</th>
                <th className="px-3 py-2 font-semibold text-right" title="Bot drafts on their leads that nobody has sent">Drafts to send</th>
              </tr>
            </thead>
            <tbody>
              {data.leaderboard.map((r, i) => (
                <tr key={r.agent || '__none'} className="border-b border-gray-100">
                  <td className="px-3 py-2 font-semibold text-gray-900 whitespace-nowrap">
                    <span className="inline-block w-5 text-gray-400 tabular-nums">{i + 1}</span>{r.name}
                  </td>
                  {cell(r.agent, 'won', r.wonCount, 'text-gray-700')}
                  {cell(r.agent, 'won', usd(r.wonUsd), 'font-semibold text-green-700')}
                  {cell(r.agent, 'pipeline', usd(r.pipelineUsd), 'text-gray-700')}
                  {cell(r.agent, 'hot', r.hot, 'text-gray-700')}
                  {cell(r.agent, 'waiting', r.waiting, r.waiting ? 'font-semibold text-red-700' : 'text-gray-700')}
                  {cell(r.agent, 'nohuman', r.noHuman ?? 0, r.noHuman ? 'font-semibold text-red-700' : 'text-gray-700')}
                  {cell(r.agent, 'drafts', r.drafts ?? 0, r.drafts ? 'font-semibold text-red-700' : 'text-gray-700')}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-3 py-2 text-[10px] text-gray-500">Click any number to see those leads. Won = sales booked this month in the Sales ledger. Pipeline = hot quotes plus unpaid invoices on that agent&apos;s leads.</p>
      </Card>

      {filtered && focus ? (
        <Card title={`${agentName(focus.agent)} · ${FOCUS_LABEL[focus.kind]} · ${focus.kind === 'won' ? filtered.won.length : filtered.items.length}`} icon={Trophy} tone="primary" className="mb-4"
          action={<button type="button" onClick={() => setFocus(null)} className={`${BTN} border border-gray-300 bg-white text-gray-800 hover:bg-gray-50`}><X className="w-3.5 h-3.5" aria-hidden />Back to all</button>}>
          {focus.kind === 'won' ? (
            filtered.won.length === 0 ? <EmptyState icon={CircleDollarSign} title="No sales booked this month" /> : (
              <ul className="divide-y divide-gray-100">
                {filtered.won.map((w) => (
                  <li key={w.saleId}>
                    <a href={w.leadId ? `/leads/${encodeURIComponent(w.leadId)}` : `/sales?sale=${encodeURIComponent(w.saleId)}`} className="flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50">
                      <span className="font-semibold text-sm text-gray-900 truncate">{w.customer}</span>
                      <span className="text-[11px] text-gray-500 truncate">{w.reference} · {w.orderDate}</span>
                      <span className="ml-auto text-sm font-bold tabular-nums text-green-700">{w.currency === 'USD' ? usd(w.amount) : `${w.currency} ${w.amount}`}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )
          ) : filtered.items.length === 0 ? <EmptyState icon={CircleDollarSign} title="Nothing here" /> : (
            <ul className="divide-y divide-gray-100">
              {filtered.items.map((i) => focus.kind === 'drafts' ? draftRow(i) : focus.kind === 'nohuman' ? noHumanRow(i) : focus.kind === 'waiting' ? waitingRow(i) : i.invoice ? invoiceRow(i) : hotRow(i))}
            </ul>
          )}
        </Card>
      ) : (
        <>
          {/* Tabs — big, bold, with the count; "waiting on us" first because
              it is the one that costs customers. */}
          <div role="tablist" aria-label="Opportunity lists" className="grid grid-cols-2 lg:grid-cols-6 gap-2 mb-3">
            {tabs.map((t) => {
              const on = tab === t.key
              return (
                <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.key)}
                  className={`min-w-0 flex items-center gap-2 sm:gap-2.5 rounded-xl border-2 px-2.5 sm:px-3.5 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on ? 'border-blue-600 bg-blue-50 shadow-sm' : 'border-gray-300 bg-white hover:border-gray-400'}`}>
                  <t.icon className={`hidden sm:block w-5 h-5 shrink-0 ${on ? 'text-blue-700' : 'text-gray-600'}`} aria-hidden />
                  <span className={`min-w-0 text-sm sm:text-base font-bold leading-tight ${on ? 'text-blue-900' : 'text-gray-900'}`}>{t.label}</span>
                  <span className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-base font-extrabold tabular-nums text-white ${t.count ? t.tone : 'bg-gray-400'}`}>{t.count}</span>
                </button>
              )
            })}
          </div>

          {tab === 'drafts' && (
            <Section hint="The bot wrote the first reply to these leads and parked it on the record. Nobody has pressed Send yet, so the customer has heard nothing. Open the lead, check the draft, press Send (or Discard and write your own). Red after 2 hours." count={(data.drafts ?? []).length} empty="No drafts waiting — every bot draft has been sent or discarded.">
              {(data.drafts ?? []).map(draftRow)}
            </Section>
          )}
          {tab === 'nohuman' && (
            <Section hint="New leads (last 14 days) where only the bot has written — no email, WhatsApp, call or chat reply from a person yet. Oldest first. Red after 24 hours." count={(data.noHuman ?? []).length} empty="Every new lead has had a reply from a person.">
              {(data.noHuman ?? []).map(noHumanRow)}
            </Section>
          )}
          {tab === 'waiting' && (
            <Section hint="The customer wrote last and nobody has answered yet — longest wait first. Red after 24 hours." count={data.waiting.length} empty="Nobody is waiting on a reply.">
              {data.waiting.map(waitingRow)}
            </Section>
          )}
          {tab === 'invoices' && (
            <Section hint="An invoice or payment link went out and no paid sale in the Sales ledger matches it." count={data.invoices.length} empty="No unpaid invoices.">
              {data.invoices.map(invoiceRow)}
            </Section>
          )}
          {tab === 'hot' && (
            <Section hint="A price went out and the customer answered it with a buying signal in the last two weeks." count={data.hot.length} empty="No hot quotes right now.">
              {data.hot.map(hotRow)}
            </Section>
          )}
          {tab === 'older' && (
            <Section hint="Created before this month, still open, and the customer engaged at some point. Biggest quotes first." count={olderAll.length} empty="Nothing older to revive.">
              {older.map(olderRow)}
              {olderAll.length > 25 && !showAllOlder && (
                <li className="px-3 py-2">
                  <button type="button" onClick={() => setShowAllOlder(true)} className="text-xs font-semibold text-blue-700 hover:underline">Show all {olderAll.length}</button>
                </li>
              )}
            </Section>
          )}
        </>
      )}

      <p className="mt-4 text-[11px] text-gray-500 flex items-start gap-1.5">
        <Ban className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />
        Left out: deals where the customer said they went with another company, found it too expensive or are not going ahead
        {data.excluded.restricted ? `, and ${data.excluded.restricted} alcohol or religious order${data.excluded.restricted === 1 ? '' : 's'} (decline those)` : ''}
        {data.excluded.notALead ? ` · ${data.excluded.notALead} marked “not a lead”` : ''}
        {data.excluded.ownTests ? ` · ${data.excluded.ownTests} test lead${data.excluded.ownTests === 1 ? '' : 's'} from our own addresses` : ''}.
        Covers leads since {formatDateTime(data.windowFrom).split(',')[0]}.
      </p>

      {/* Below the lists: the work comes first, the results after (owner, 2026-10-28). */}
      <div className="mt-4"><FollowUpResults agentName={agentName} /></div>
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

function Section({ count, hint, empty, children }: {
  count: number; hint: string; empty: string; children: React.ReactNode
}) {
  return (
    <Card>
      <p className="px-3 pt-2.5 pb-1 text-xs text-gray-600">{hint}</p>
      {count === 0
        ? <EmptyState icon={CircleDollarSign} title={empty} />
        : <ul className="divide-y divide-gray-100">{children}</ul>}
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

function Row({ item: i, amount, badge, extra, ownerFirst = false }: { item: OppItem; amount?: number | null; badge?: React.ReactNode; extra?: React.ReactNode; ownerFirst?: boolean }) {
  return (
    <li>
      <a href={`/leads/${encodeURIComponent(i.id)}`} className="block px-3 py-2.5 hover:bg-gray-50 focus:outline-none focus-visible:bg-gray-50">
        <div className="flex items-center gap-2 min-w-0">
          {badge}
          <span className="font-semibold text-sm text-gray-900 truncate">{i.name}</span>
          <span className="text-[11px] text-gray-500 truncate">{i.siteName}</span>
          {ownerFirst && <span className={`ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${i.owner ? 'bg-gray-100 text-gray-800 border border-gray-300' : 'bg-red-50 text-red-700 border border-red-300'}`}>{i.ownerName}</span>}
          {amount !== undefined && <span className="ml-auto shrink-0 text-sm font-bold tabular-nums text-gray-900">{usd(amount)}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600">
          <span className={`rounded-full border px-1.5 py-px text-[10px] font-semibold ${CRM_STAGE_STYLE[i.stage] ?? ''}`}>{CRM_STAGE_LABEL[i.stage] ?? i.stage}</span>
          {!ownerFirst && <span className="text-gray-500">{i.ownerName}</span>}
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

// Follow-up results (owner, 2026-10-28): what the follow-ups achieved, so the
// team can see the replies they earned. lib/followupstats.ts does the counting.
const MOOD: Record<ReplyMood, { label: string; tone: 'good' | 'warn' | 'bad' }> = {
  interested: { label: 'Interested', tone: 'good' }, later: { label: 'Will get back', tone: 'warn' }, no: { label: 'Said no', tone: 'bad' },
}
function FollowUpResults({ agentName }: { agentName: (k: string) => string }) {
  const [f, setF] = useState<FollowUpStats | null>(null)
  const [mood, setMood] = useState<ReplyMood | 'all'>('all')
  useEffect(() => {
    let alive = true
    void fetch('/api/opportunities/followups').then((r) => (r.ok ? r.json() : null)).then((j) => { if (alive && j) setF(j) })
    return () => { alive = false }
  }, [])
  if (!f) return null
  // The ledger keeps the agent's address; the leaderboard may key them by name.
  const who = (e: string) => {
    for (const k of [e, e.split('@')[0]]) { const n = agentName(k); if (n !== 'Unassigned') return n }
    const local = e.split('@')[0].replace(/(khan|hayes|taylor|wright|diaz|joshi)$/i, ' $1')
    return local.replace(/\b\w/g, (c) => c.toUpperCase())
  }
  const rate = f.leads ? Math.round((f.replied / f.leads) * 100) : 0
  const shown = mood === 'all' ? f.replies : f.replies.filter((r) => r.mood === mood)
  const pill = (k: ReplyMood | 'all', label: string, n: number) => (
    <button key={k} type="button" onClick={() => setMood(k)}
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${mood === k ? 'border-blue-400 bg-blue-100 text-blue-800' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>{label} <span className="tabular-nums">{n}</span></button>
  )
  return (
    <Card title={`Follow-up results — last ${f.days} days`} icon={MailCheck} className="mb-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2.5 px-3 pt-3">
        <Stat label="Follow-ups sent" value={String(f.sent)} hint={`to ${f.leads} customers`} />
        <Stat label="Customers replied" value={String(f.replied)} hint={`${rate}% of those followed up`} tone="good" />
        <Stat label="Interested" value={String(f.interested)} hint="asked, sent details or said yes" tone="good" />
        <Stat label="Will get back" value={String(f.later)} hint="busy now, coming back" tone="warn" />
        <Stat label="Said no" value={String(f.no)} hint="price, MOQ or bought elsewhere" tone="bad" />
      </div>
      {f.byAgent.length > 0 && (
        <div className="overflow-x-auto px-3 pt-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[10px] uppercase tracking-wider text-gray-500">
                <th className="px-2 py-1.5 font-semibold">Agent</th>
                <th className="px-2 py-1.5 font-semibold text-right">Follow-ups</th>
                <th className="px-2 py-1.5 font-semibold text-right">Customers</th>
                <th className="px-2 py-1.5 font-semibold text-right">Replied</th>
                <th className="px-2 py-1.5 font-semibold text-right">Still in play</th>
              </tr>
            </thead>
            <tbody>
              {f.byAgent.map((a) => (
                <tr key={a.agent} className="border-b border-gray-100">
                  <td className="px-2 py-1.5 font-semibold text-gray-900">{who(a.agent)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{a.sent}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{a.leads}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-green-700">{a.replied}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-gray-700">{a.interested}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 px-3 pt-3">
        {pill('all', 'All replies', f.replied)}{pill('interested', 'Interested', f.interested)}{pill('later', 'Will get back', f.later)}{pill('no', 'Said no', f.no)}
      </div>
      {shown.length === 0 ? <EmptyState icon={MailCheck} title="No replies here yet" /> : (
        <ul className="divide-y divide-gray-100 mt-2">
          {shown.map((r) => (
            <li key={r.leadId}>
              <a href={`/leads/${encodeURIComponent(r.leadId)}`} className="block px-3 py-2.5 hover:bg-gray-50">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Chip tone={MOOD[r.mood].tone}>{MOOD[r.mood].label}</Chip>
                  <span className="font-semibold text-sm text-gray-900">{r.name}</span>
                  <span className="text-[11px] text-gray-500">{r.siteName}</span>
                  <span className="ml-auto text-[11px] text-gray-500">{who(r.agent)} · replied {timeAgo(r.repliedAt)} after {r.followUps} follow-up{r.followUps === 1 ? '' : 's'}</span>
                </div>
                <p className="mt-1 text-xs text-gray-700 line-clamp-2">“{r.said}”</p>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="px-3 py-2 text-[10px] text-gray-500">A reply is the customer&apos;s first email after the first follow-up. Interested / Will get back / Said no is read from their words — open the lead for the full thread.</p>
    </Card>
  )
}
