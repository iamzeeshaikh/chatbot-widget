'use client'

// Daily follow-ups — /followups (packaging admins).
//
// One Karachi day: what went out to customers, what came back, who is still
// waiting, each agent's share, and the same counts for the last 14 days.
// Everything on screen is one payload from /api/admin/followups (lib/followups.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, RefreshCw, TriangleAlert, Lock, ChevronLeft, ChevronRight,
  Send, Bot, UserRound, MessageSquareReply, Hourglass, ListChecks, Check,
} from 'lucide-react'
import { formatTime, formatShortDate, timeAgo, pktDayKey } from '@/lib/datetime'
import { FOLLOWUP_KIND_LABEL, type FollowupKind } from '@/lib/followupkinds'
import type { FollowupData, FollowupItem } from '@/lib/followups'

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40'
const SELECT = 'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-800'
const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500 whitespace-nowrap'
const THN = `${TH} text-right`
const TD = 'px-3 py-2 text-xs text-gray-800'
const TDN = `${TD} text-right tabular-nums`

const KIND_STYLE: Record<FollowupKind, string> = {
  bot_first: 'bg-gray-100 text-gray-700',
  bot_followup: 'bg-blue-100 text-blue-700',
  bot_quote_fu: 'bg-blue-100 text-blue-700',
  bot_promo: 'bg-violet-100 text-violet-700',
  bot_reply: 'bg-gray-100 text-gray-700',
  draft_sent: 'bg-green-100 text-green-700',
  email: 'bg-green-100 text-green-700',
  whatsapp: 'bg-green-100 text-green-700',
  whatsapp_bot: 'bg-gray-100 text-gray-700',
  call: 'bg-amber-100 text-amber-700',
}

type Filter = 'all' | 'followups' | 'people' | 'bot' | 'answered' | 'email' | 'draft_sent' | 'whatsapp' | 'call'
type Tab = 'sent' | 'replies' | 'tasks'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Everything sent' },
  { key: 'followups', label: 'Bot follow-ups' },
  { key: 'people', label: 'By the team' },
  { key: 'bot', label: 'All bot messages' },
  { key: 'answered', label: 'Customer answered' },
  { key: 'email', label: 'Email by hand' },
  { key: 'draft_sent', label: 'Bot drafts sent' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'call', label: 'Calls' },
]
const CHASE: FollowupKind[] = ['bot_followup', 'bot_quote_fu', 'bot_promo']
const PEOPLE: FollowupKind[] = ['draft_sent', 'email', 'whatsapp', 'call']

function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

function matches(x: FollowupItem, f: Filter): boolean {
  if (f === 'followups') return CHASE.includes(x.kind)
  if (f === 'people') return PEOPLE.includes(x.kind)
  if (f === 'bot') return !PEOPLE.includes(x.kind)
  if (f === 'answered') return x.replied
  if (f === 'email' || f === 'draft_sent' || f === 'whatsapp' || f === 'call') return x.kind === f
  return true
}

export default function FollowupsPage() {
  const [day, setDay] = useState('')
  const [data, setData] = useState<FollowupData | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'unavailable'>('loading')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [agent, setAgent] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [tab, setTab] = useState<Tab>('sent')
  const detailRef = useRef<HTMLDivElement>(null)
  const waitingRef = useRef<HTMLDivElement>(null)

  const jump = (el: HTMLDivElement | null) => window.setTimeout(() => el?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30)
  /** Every number on the page opens the rows behind it. */
  const open = (to: Tab, who = '', f: Filter = 'all') => { setTab(to); setAgent(who); setFilter(f); jump(detailRef.current) }
  const openWaiting = (who = '') => { setAgent(who); jump(waitingRef.current) }

  useEffect(() => {
    try { document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark') } catch { /* private mode */ }
  }, [])

  const load = useCallback(async (fresh = false) => {
    const q = new URLSearchParams()
    if (day) q.set('day', day)
    if (fresh) q.set('fresh', '1')
    const res = await fetch(`/api/admin/followups?${q}`).catch(() => null)
    if (!res) { setError('Could not reach the server.'); setStatus('error'); return }
    if (res.status === 401) { window.location.href = '/login'; return }
    if (res.status === 403) { setStatus('unavailable'); return }
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not load follow-ups.'); setStatus('error'); return }
    const d: FollowupData = await res.json()
    setData(d); setStatus('ok'); setError('')
  }, [day])

  useEffect(() => {
    const t = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const refresh = async () => { setRefreshing(true); await load(true); setRefreshing(false) }
  const shown = data?.day ?? day
  const isToday = !!data && data.day === pktDayKey(data.generatedAt)

  const items = useMemo(
    () => (data?.items ?? []).filter((x) => (!agent || (x.agent || 'bot') === agent) && matches(x, filter)),
    [data, agent, filter],
  )
  const waiting = useMemo(() => (data?.waiting ?? []).filter((x) => !agent || (x.agent || 'unassigned') === agent), [data, agent])
  const replies = useMemo(() => (data?.replies ?? []).filter((x) => !agent || (x.agent || 'unassigned') === agent), [data, agent])
  const tasks = useMemo(() => (data?.tasks ?? []).filter((x) => !agent || x.agent === agent), [data, agent])
  const agentName = data?.agents.find((a) => a.agent === agent)?.name ?? ''

  if (status === 'unavailable') {
    return (
      <Shell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <Lock className="mx-auto w-6 h-6 text-gray-400" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">Follow-ups are for the admins of this dashboard</p>
          <Link href="/" className="mt-4 inline-block text-xs font-semibold text-blue-700 hover:underline">Back to the dashboard</Link>
        </div>
      </Shell>
    )
  }
  if (status === 'error') {
    return (
      <Shell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <TriangleAlert className="mx-auto w-6 h-6 text-red-500" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">{error}</p>
          <button type="button" onClick={() => { setStatus('loading'); void load() }} className={`${BTN} mt-4 bg-gray-900 text-white hover:bg-gray-800`}>Try again</button>
        </div>
      </Shell>
    )
  }

  const t = data?.totals
  const answeredPct = t && t.botFollowups > 0 ? `${Math.round((t.followupsAnswered / t.botFollowups) * 100)}%` : '—'

  return (
    <Shell
      subtitle={data ? `${formatShortDate(`${data.day}T07:00:00Z`)}${isToday ? ' (today so far)' : ''} · Pakistan time` : 'Loading…'}
      actions={
        <>
          <button type="button" aria-label="Previous day" onClick={() => setDay(shiftDay(shown, -1))}
            disabled={!data} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-2`}>
            <ChevronLeft className="w-3.5 h-3.5" aria-hidden />
          </button>
          <input type="date" aria-label="Day" value={shown} onChange={(e) => e.target.value && setDay(e.target.value)} className={SELECT} />
          <button type="button" aria-label="Next day" onClick={() => setDay(shiftDay(shown, 1))}
            disabled={!data || isToday} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 px-2`}>
            <ChevronRight className="w-3.5 h-3.5" aria-hidden />
          </button>
          {!isToday && data && (
            <button type="button" onClick={() => setDay('')} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>Today</button>
          )}
          <button type="button" onClick={refresh} disabled={refreshing} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden /> Refresh
          </button>
        </>
      }>
      {data?.truncated && (
        <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          This period holds more rows than one read allows, so the newest figures may be short.
        </p>
      )}

      {/* ── the day in six numbers ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2 mb-4">
        <Tile onClick={() => open('sent', '', 'followups')} icon={Bot} label="Bot follow-ups sent" value={t?.botFollowups} hint={t ? `${t.botOther} first replies and answers` : ''} />
        <Tile onClick={() => open('sent', '', 'people')} icon={UserRound} label="Sent by the team" value={t?.byPeople}
          hint={t ? `${t.emails + t.draftsSent} email · ${t.whatsapp} WhatsApp · ${t.calls} calls` : ''} />
        <Tile onClick={() => open('sent')} icon={Send} label="Leads contacted" value={t?.leadsContacted} hint={t ? `${t.sent} messages and calls in all` : ''} />
        <Tile onClick={() => open('replies')} icon={MessageSquareReply} label="Customer replies" value={t?.replies} hint={t ? `Follow-ups answered: ${t.followupsAnswered} (${answeredPct})` : ''} />
        <Tile onClick={() => openWaiting()} icon={Hourglass} label="Still waiting on us" value={t?.waiting} hint="Replied that day, no answer yet" tone={t && t.waiting > 0 ? 'warn' : undefined} />
        <Tile onClick={() => open('tasks')} icon={ListChecks} label="Tasks completed" value={t?.tasksDone} hint="By people, not the bot" />
      </div>

      {/* ── per agent ──────────────────────────────────────────────────────── */}
      <Section title="By agent" note="Bot mail goes out in an agent's name, so it is counted under that agent in its own column.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={TH}>Agent</th>
                <th className={THN}>Email by hand</th>
                <th className={THN}>Bot drafts sent</th>
                <th className={THN}>WhatsApp</th>
                <th className={THN}>Calls</th>
                <th className={THN}>Bot follow-ups</th>
                <th className={THN}>Leads contacted</th>
                <th className={THN}>Replies received</th>
                <th className={THN}>Waiting</th>
                <th className={THN}>Tasks done</th>
              </tr>
            </thead>
            <tbody>
              {!data && <tr><td className={TD} colSpan={10}>Loading…</td></tr>}
              {data && data.agents.length === 0 && <tr><td className={`${TD} text-gray-500`} colSpan={10}>Nothing went out or came in on this day.</td></tr>}
              {data?.agents.map((a) => (
                <tr key={a.agent} className="border-b border-gray-200 last:border-0 hover:bg-gray-50">
                  <td className={`${TD} font-semibold`}>
                    <button type="button" onClick={() => (agent === a.agent ? setAgent('') : open('sent', a.agent))}
                      className={`hover:underline ${agent === a.agent ? 'text-blue-700' : 'text-gray-900'}`} title="Show only this agent below">
                      {a.name}
                    </button>
                  </td>
                  <td className={TDN}><Num v={a.emails} onClick={() => open('sent', a.agent, 'email')} /></td>
                  <td className={TDN}><Num v={a.draftsSent} onClick={() => open('sent', a.agent, 'draft_sent')} /></td>
                  <td className={TDN}><Num v={a.whatsapp} onClick={() => open('sent', a.agent, a.agent === 'bot' ? 'all' : 'whatsapp')} /></td>
                  <td className={TDN}><Num v={a.calls} onClick={() => open('sent', a.agent, 'call')} /></td>
                  <td className={TDN}><Num v={a.botFollowups} onClick={() => open('sent', a.agent, 'followups')} /></td>
                  <td className={TDN}><Num v={a.leadsContacted} onClick={() => open('sent', a.agent)} /></td>
                  <td className={TDN}><Num v={a.replies} onClick={() => open('replies', a.agent)} /></td>
                  <td className={TDN}><Num v={a.waiting} warn onClick={() => openWaiting(a.agent)} /></td>
                  <td className={TDN}><Num v={a.tasksDone} onClick={() => open('tasks', a.agent)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── waiting ────────────────────────────────────────────────────────── */}
      <div ref={waitingRef} className="scroll-mt-20">
        {data && data.waiting.length > 0 && (
          <Section title={`Still waiting on us (${waiting.length}${waiting.length !== data.waiting.length ? ` of ${data.waiting.length}` : ''})`}
            note="These customers wrote on this day and nothing has gone back to them since."
            action={agent ? <AgentChip name={agentName} onClear={() => setAgent('')} /> : undefined}>
            <ul>
              {waiting.length === 0 && <li className={`${TD} text-gray-500`}>Nobody is waiting on {agentName || 'this agent'}.</li>}
              {waiting.map((w) => (
                <li key={w.sessionId} className="border-b border-gray-200 last:border-0">
                  <a href={`/leads/${w.sessionId}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 hover:bg-gray-50">
                    <span className="text-xs font-semibold text-gray-900">{w.customer}</span>
                    <span className="text-[11px] text-gray-500">{w.siteName} · {w.agentName} · {w.via === 'email' ? 'Email' : 'WhatsApp'} · {formatTime(w.at)} ({timeAgo(w.at)})</span>
                    <span className="basis-full text-xs text-gray-700 truncate">{w.snippet}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      {/* ── everything that went out, came back, or got done ───────────────── */}
      <div ref={detailRef} className="scroll-mt-20">
      <Section
        title={tab === 'sent' ? `Sent on this day (${items.length}${data && items.length !== data.items.length ? ` of ${data.items.length}` : ''})`
          : tab === 'replies' ? `Customer replies (${replies.length}${data && replies.length !== data.replies.length ? ` of ${data.replies.length}` : ''})`
          : `Tasks completed (${tasks.length}${data && tasks.length !== data.tasks.length ? ` of ${data.tasks.length}` : ''})`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden" role="tablist">
              {([['sent', 'Sent'], ['replies', 'Customer replies'], ['tasks', 'Tasks done']] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={`px-2.5 py-1.5 text-xs font-semibold ${tab === k ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>{label}</button>
              ))}
            </div>
            <select aria-label="Agent" className={SELECT} value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">All agents</option>
              {(data?.agents ?? []).map((a) => <option key={a.agent} value={a.agent}>{a.name}</option>)}
            </select>
            {tab === 'sent' && (
              <select aria-label="Show" className={SELECT} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
                {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </select>
            )}
            {(agent || (tab === 'sent' && filter !== 'all')) && (
              <button type="button" onClick={() => { setAgent(''); setFilter('all') }} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>Show all</button>
            )}
          </div>
        }>
        {tab === 'replies' && (
          <ul>
            {!data && <li className={TD}>Loading…</li>}
            {data && replies.length === 0 && <li className={`${TD} text-gray-500`}>No customer wrote in.</li>}
            {replies.map((w, i) => (
              <li key={`${w.sessionId}|${w.at}|${i}`} className="border-b border-gray-200 last:border-0">
                <a href={`/leads/${w.sessionId}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 hover:bg-gray-50">
                  <span className="text-xs font-semibold text-gray-900">{w.customer}</span>
                  <span className="text-[11px] text-gray-500">{w.siteName} · {w.agentName} · {w.via === 'email' ? 'Email' : 'WhatsApp'} · {formatTime(w.at)}</span>
                  <span className={`text-[11px] font-semibold ${w.answered ? 'text-green-700' : 'text-amber-700'}`}>{w.answered ? 'Answered' : 'No answer yet'}</span>
                  <span className="basis-full text-xs text-gray-700 truncate">{w.snippet}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {tab === 'tasks' && (
          <ul>
            {!data && <li className={TD}>Loading…</li>}
            {data && tasks.length === 0 && <li className={`${TD} text-gray-500`}>No task was completed.</li>}
            {tasks.map((w, i) => (
              <li key={`${w.sessionId}|${w.at}|${i}`} className="border-b border-gray-200 last:border-0">
                <a href={`/leads/${w.sessionId}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 hover:bg-gray-50">
                  <span className="text-xs font-semibold text-gray-900">{w.title}</span>
                  <span className="text-[11px] text-gray-500">{w.agentName} · {formatTime(w.at)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {tab === 'sent' && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={TH}>Time</th>
                <th className={TH}>Customer</th>
                <th className={TH}>What</th>
                <th className={TH}>Agent</th>
                <th className={TH}>Site</th>
                <th className={TH}>Answered</th>
              </tr>
            </thead>
            <tbody>
              {!data && <tr><td className={TD} colSpan={6}>Loading…</td></tr>}
              {data && items.length === 0 && <tr><td className={`${TD} text-gray-500`} colSpan={6}>Nothing matches.</td></tr>}
              {items.map((x, i) => (
                <tr key={`${x.sessionId}|${x.at}|${i}`} className="border-b border-gray-200 last:border-0 hover:bg-gray-50 align-top">
                  <td className={`${TD} whitespace-nowrap tabular-nums text-gray-500`}>{formatTime(x.at)}</td>
                  <td className={TD}>
                    <a href={`/leads/${x.sessionId}`} className="font-semibold text-gray-900 hover:underline">{x.customer}</a>
                    {(x.subject || x.snippet) && <p className="text-[11px] text-gray-500 max-w-md truncate">{x.snippet || x.subject}</p>}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${KIND_STYLE[x.kind]}`}>
                      {FOLLOWUP_KIND_LABEL[x.kind]}{x.n ? ` #${x.n}` : ''}
                    </span>
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{x.agentName}</td>
                  <td className={`${TD} whitespace-nowrap text-gray-500`}>{x.siteName}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {x.replied
                      ? <span className="inline-flex items-center gap-1 font-semibold text-green-700"><Check className="w-3.5 h-3.5" aria-hidden />{timeAgo(x.repliedAt)}</span>
                      : <span className="text-gray-400">Not yet</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </Section>
      </div>

      {/* ── fourteen days ──────────────────────────────────────────────────── */}
      <Section title="Last 14 days" note="Pick a day to open it.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className={TH}>Day</th>
                <th className={THN}>Bot follow-ups</th>
                <th className={THN}>Other bot messages</th>
                <th className={THN}>Email by team</th>
                <th className={THN}>WhatsApp</th>
                <th className={THN}>Calls</th>
                <th className={THN}>Leads contacted</th>
                <th className={THN}>Customer replies</th>
              </tr>
            </thead>
            <tbody>
              {(data?.trend ?? []).slice().reverse().map((d) => (
                <tr key={d.day} onClick={() => { setDay(d.day); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                  className={`cursor-pointer border-b border-gray-200 last:border-0 hover:bg-gray-50 ${d.day === data?.day ? 'bg-blue-50' : ''}`}>
                  <td className={`${TD} whitespace-nowrap`}>
                    <button type="button" className="font-semibold text-blue-700 hover:underline">
                      {formatShortDate(`${d.day}T07:00:00Z`)}
                    </button>
                  </td>
                  <td className={TDN}>{d.botFollowups}</td>
                  <td className={TDN}>{d.botOther}</td>
                  <td className={TDN}>{d.emails + d.draftsSent}</td>
                  <td className={TDN}>{d.whatsapp}</td>
                  <td className={TDN}>{d.calls}</td>
                  <td className={TDN}>{d.leadsContacted}</td>
                  <td className={TDN}>{d.replies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </Shell>
  )
}

function Tile({ icon: Icon, label, value, hint, tone, onClick }: {
  icon: typeof Send; label: string; value: number | undefined; hint?: string; tone?: 'warn'; onClick: () => void
}) {
  return (
    <button type="button" onClick={onClick} title="Show these below"
      className={`text-left rounded-xl border bg-white px-3 py-2.5 transition-shadow hover:shadow-md hover:border-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${tone === 'warn' ? 'border-amber-300' : 'border-gray-200'}`}>
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        <Icon className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />{label}
      </span>
      <span className={`block mt-1 text-2xl font-bold tabular-nums ${tone === 'warn' ? 'text-amber-700' : 'text-gray-900'}`}>{value ?? '–'}</span>
      {hint && <span className="block text-[11px] text-gray-500 leading-tight">{hint}</span>}
    </button>
  )
}

/** A count that opens the rows behind it; a zero has nothing to open. */
function Num({ v, onClick, warn }: { v: number; onClick: () => void; warn?: boolean }) {
  if (!v) return <span className="text-gray-400">0</span>
  return (
    <button type="button" onClick={onClick} title="Show these below"
      className={`rounded px-1.5 py-0.5 font-semibold underline decoration-dotted underline-offset-2 hover:bg-blue-50 hover:text-blue-700 ${warn ? 'text-amber-700' : 'text-gray-900'}`}>{v}</button>
  )
}

function AgentChip({ name, onClear }: { name: string; onClear: () => void }) {
  return (
    <button type="button" onClick={onClear} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>{name} only · show all</button>
  )
}

function Section({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 border-b border-gray-200">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        {note && <p className="text-[11px] text-gray-500">{note}</p>}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  )
}

function Shell({ children, subtitle, actions }: { children?: React.ReactNode; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1400px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3 flex-wrap">
          <Link href="/" className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100" aria-label="Back to the dashboard">
            <ArrowLeft className="w-4 h-4" aria-hidden />
          </Link>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900 leading-tight">Daily follow-ups</h1>
            {subtitle && <p className="text-[11px] text-gray-500 leading-tight">{subtitle}</p>}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-3 sm:px-5 py-4">{children}</main>
    </div>
  )
}
