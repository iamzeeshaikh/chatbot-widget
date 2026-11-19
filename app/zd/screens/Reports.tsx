'use client'

// ZeeDesk's reporting screen: Overview, Team and Month-end in one place, all
// reading one shared date range.
//
// Every figure comes straight from an existing endpoint — nothing is computed
// here beyond adding up the rows an endpoint returned for the chosen days:
//
//   /api/admin/report        admins   exact per-day, per-site, per-agent figures
//   /api/admin/analytics     members  the last 30 days of visitors and chats
//   /api/admin/leads-list    members  the leads this member may see
//   /api/admin/performance   admins   replies, response time, daily pickup
//   /api/admin/attendance    admins   online time per agent per day
//   /api/admin/presence      members  who is online now
//   /api/tasks               members  open tasks
//
// A part the server refuses (403) is left out and named in one quiet line, so
// a standard member sees a smaller screen rather than a broken one.

import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Download, RefreshCw } from 'lucide-react'
import {
  describeRange, formatDateTime, formatShortDate, formatShortDateTime, formatTime, pktCustomRange,
  pktDateTimeToUtc, pktDayKey, pktDayKeyOffset, pktDaysInRange, pktMonthOf, pktMonthRange, timeAgo,
} from '@/lib/datetime'
import { hasFeature, isWorkspace } from '@/lib/workspaces'
import { CRM_STAGE_LABEL, isCrmStage } from '@/lib/crm'
import type { AgentRow as ReportAgent, DayRow, Metrics, ReportData, SiteRow } from '@/lib/report'
import type { Count, SiteTrafficDetail } from '@/lib/trafficdetail'
import { Avatar, BTN_PLAIN, CARD, Chip, Drawer, Empty, INPUT, Notice, PageHead, short, type ZdScreenProps } from '../ui'

// ── What the endpoints return ────────────────────────────────────────────────
interface Lead {
  id: string | number; site_id: string; name: string | null; email: string | null; created_at: string
  session_id?: string | null; stage?: string; owner?: string | null; notALead?: boolean
}
interface SiteInfo { site_id: string; name: string | null }
interface AnalyticsRes { points: { label: string; visitors: number; chats: number; picked?: number }[] }
interface PerfAgent {
  id: string; email: string; builtin: boolean; former: boolean; handled: number; replies: number
  avgResponseMs: number | null; slowReplies: number; measuredReplies: number; leads: number
  dropped: number; proactive: number; lastReplyAt: string | null
}
interface PerfDay {
  date: string; visitors: number; chats: number; picked: number; notPicked: number
  chatSessions: { session_id: string; site_id: string }[]; byAgent: { email: string; picked: number }[]
}
interface PerfRes {
  summary: {
    totalConversations: number; answeredConversations: number; totalLeads: number; totalMissed: number
    totalUnanswered: number; ignoredVisitors: number; totalReplies: number; attributedReplies: number
    avgResponseMs: number | null; avgExcludedOutliers: number
  }
  agents: PerfAgent[]; daily: PerfDay[]; unattributedReplies: number
}
interface AttendanceRes { days: { date: string; email: string; first: string | null; last: string | null; secs: number }[] }
interface PresenceRes { agents: { email: string; online: boolean; lastSeen: string | null }[] }
interface TasksRes { groups: Record<'overdue' | 'today' | 'upcoming', { assignee?: string }[]> }
interface BreakdownRes {
  label: string
  sites: { siteId: string; name: string; visits: number; unique: number; chats: number; picked: number; notPicked: number }[]
  total: { visits: number; unique: number; chats: number; picked: number; notPicked: number } | null
}
interface SiteDetailRes { name: string; chats: number; detail: SiteTrafficDetail }

// ── Small helpers ────────────────────────────────────────────────────────────
const num = (n: number) => n.toLocaleString('en-US')
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const mins = ms / 60000
  if (mins < 1) return `${Math.round(ms / 1000)}s`
  if (mins < 60) return `${mins.toFixed(1)} min`
  return `${(mins / 60).toFixed(1)} h`
}
const onlineTime = (secs: number) => (secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m` : `${Math.round(secs / 60)}m`)
/** "19 Nov" for a Karachi day key. Noon, so the label can never slip a day. */
const dayLabel = (day: string) => formatShortDate(pktDateTimeToUtc(day, '12:00'))
const recordIdOf = (l: Lead) => l.session_id || `quote-${l.id}`
const leadTitle = (l: Lead) => l.name?.trim() || l.email?.trim() || 'Unnamed lead'

type Status = 'idle' | 'loading' | 'ok' | 'forbidden' | 'error'
interface Api<T> { status: Status; data: T | null; error: string }

/** One GET. `null` means "not needed"; a changed url or nonce asks again. The
 *  answer is stored with the request it belongs to, so a slow reply for a range
 *  the user has already left is never shown under the new one. */
function useApi<T>(url: string | null, nonce = 0): Api<T> {
  const [res, setRes] = useState<{ key: string; status: Status; data: T | null; error: string } | null>(null)
  const key = url === null ? null : `${url}#${nonce}`
  useEffect(() => {
    if (url === null || key === null) return
    let live = true
    fetch(url).then(async (r) => {
      if (r.status === 401) { window.location.href = '/login'; return }
      const body = await r.json().catch(() => null)
      if (!live) return
      if (r.status === 403) setRes({ key, status: 'forbidden', data: null, error: '' })
      else if (!r.ok) setRes({ key, status: 'error', data: null, error: body?.error || 'The server could not answer. Try again.' })
      else setRes({ key, status: 'ok', data: body as T, error: '' })
    }).catch(() => { if (live) setRes({ key, status: 'error', data: null, error: 'Could not reach the server. Check your connection and try again.' }) })
    return () => { live = false }
  }, [url, key])
  if (key === null) return { status: 'idle', data: null, error: '' }
  if (!res || res.key !== key) return { status: 'loading', data: null, error: '' }
  return res
}

// ── Date range ───────────────────────────────────────────────────────────────
type Preset = 'last-7' | 'last-30' | 'this-month' | 'last-month' | 'custom'
const PRESETS: { key: Preset; label: string }[] = [
  { key: 'last-7', label: 'Last 7 days' },
  { key: 'last-30', label: 'Last 30 days' },
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'custom', label: 'Custom range' },
]

/** The first and last Karachi day (inclusive) a preset covers. */
function presetDays(preset: Preset, customFrom: string, customTo: string): { from: string; to: string } | null {
  const today = pktDayKeyOffset(0)
  if (preset === 'last-7') return { from: pktDayKeyOffset(-6), to: today }
  if (preset === 'last-30') return { from: pktDayKeyOffset(-29), to: today }
  if (preset === 'this-month') return { from: `${today.slice(0, 8)}01`, to: today }
  if (preset === 'last-month') {
    const { year, month } = pktMonthOf()
    const r = month === 1 ? pktMonthRange(year - 1, 12) : pktMonthRange(year, month - 1)
    return { from: pktDayKey(r.from), to: pktDayKey(new Date(new Date(r.to).getTime() - 1000)) }
  }
  if (!customFrom || !customTo || customFrom > customTo) return null
  return { from: customFrom, to: customTo }
}

// ── Building blocks ──────────────────────────────────────────────────────────
const TH = 'px-3 py-2 font-semibold whitespace-nowrap text-[11px] uppercase tracking-wide text-[#68737d]'
const TD = 'px-3 py-2 text-[#49545c]'
const NUM = 'text-right tabular-nums'
const LINK = 'text-[#1f73b7] font-medium tabular-nums hover:underline outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded'

function Skel({ w = 'w-12' }: { w?: string }) {
  return <span className={`inline-block h-4 ${w} rounded bg-[#e9ebed] animate-pulse align-middle`} aria-hidden />
}

function Section({ title, sub, actions, children }: { title: string; sub?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={CARD} aria-label={title}>
      <div className="px-4 py-3 border-b border-[#e9ebed] flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-[#2f3941]">{title}</h2>
          {sub && <p className="text-[12px] text-[#68737d]">{sub}</p>}
        </div>
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

function Tile({ label, value, sub, loading, onOpen }: { label: string; value: string; sub?: string; loading?: boolean; onOpen?: () => void }) {
  return (
    <div className="px-4 py-3 min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d] truncate">{label}</p>
      <div className="h-8 flex items-end">
        {loading ? <Skel w="w-16" />
          : onOpen
            ? <button type="button" onClick={onOpen} aria-label={`${label}: ${value}. Show the list`} className="text-[22px] leading-none font-semibold tabular-nums text-[#1f73b7] hover:underline outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded">{value}</button>
            : <p className="text-[22px] leading-none font-semibold tabular-nums text-[#2f3941]">{value}</p>}
      </div>
      <p className="text-[12px] text-[#68737d] h-4 truncate" title={sub}>{loading ? '' : sub}</p>
    </div>
  )
}

function Tiles({ children }: { children: React.ReactNode }) {
  return <div className={`${CARD} grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-[#e9ebed] overflow-hidden`}>{children}</div>
}

/** Thin single-hue bars on a visible baseline. Every bar carries its exact
 *  value as a title, and the same values sit in the table under the chart. */
function BarChart({ label, unit, data, loading, empty, onPick }: {
  label: string; unit: string; data: { key: string; label: string; value: number }[]
  loading?: boolean; empty: string; onPick?: (key: string) => void
}) {
  const max = Math.max(0, ...data.map((d) => d.value))
  const marks = data.length > 2 ? [data[0], data[Math.floor((data.length - 1) / 2)], data[data.length - 1]] : data
  return (
    <div className="px-4 py-3" role="group" aria-label={label}>
      <div className="flex items-stretch gap-2">
        <div className="w-8 shrink-0 flex flex-col justify-between text-right text-[11px] tabular-nums text-[#68737d]" aria-hidden>
          <span>{max > 0 ? num(max) : ''}</span><span>0</span>
        </div>
        <div className="relative flex-1 min-w-0 h-[132px] border-b border-b-[#68737d] border-t border-t-[#e9ebed]">
          {loading ? <p className="absolute inset-0 flex items-center justify-center text-[13px] text-[#68737d]">Loading…</p>
            : max === 0 ? <p className="absolute inset-0 flex items-center justify-center text-[13px] text-[#68737d] px-3 text-center">{empty}</p>
            : (
              <div className={`h-full flex items-end ${data.length > 45 ? 'gap-px' : 'gap-[3px]'}`}>
                {data.map((d) => {
                  const text = `${d.label}: ${num(d.value)} ${unit}`
                  const bar = <span className="block w-full rounded-t-sm bg-[#1f73b7] group-hover:bg-[#144a75]" style={{ height: d.value > 0 ? `max(2px, ${(d.value / max) * 100}%)` : 0 }} />
                  return onPick && d.value > 0
                    ? <button key={d.key} type="button" title={text} aria-label={`${text}. Show the list`} onClick={() => onPick(d.key)} className="group flex-1 min-w-0 max-w-[26px] h-full flex items-end outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">{bar}</button>
                    : <span key={d.key} title={text} className="group flex-1 min-w-0 max-w-[26px] h-full flex items-end">{bar}</span>
                })}
              </div>
            )}
        </div>
      </div>
      <div className="ml-10 mt-1 flex justify-between text-[11px] tabular-nums text-[#68737d]" aria-hidden>
        {marks.map((m) => <span key={m.key}>{m.label}</span>)}
      </div>
    </div>
  )
}

interface Col<T> {
  key: string; label: string; num?: boolean; hint?: string
  /** The value the column sorts on. `null` always sinks to the bottom. */
  sort: (row: T) => string | number | null
  cell?: (row: T) => React.ReactNode
}

function SortTable<T>({ label, cols, rows, rowKey, initial, foot, loading, empty }: {
  label: string; cols: Col<T>[]; rows: T[]; rowKey: (row: T) => string
  initial: { key: string; dir: 'asc' | 'desc' }; foot?: React.ReactNode[] | null; loading?: boolean; empty: string
}) {
  const [sort, setSort] = useState(initial)
  const sorted = useMemo(() => {
    const col = cols.find((c) => c.key === sort.key) ?? cols[0]
    const mul = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b)
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))) * mul
    })
  }, [rows, cols, sort])
  const toggle = (c: Col<T>) => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.num ? 'desc' : 'asc' }))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]" aria-label={label}>
        <thead>
          <tr className="bg-[#f8f9f9] text-left">
            {cols.map((c) => {
              const on = sort.key === c.key
              return (
                <th key={c.key} scope="col" aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={`${TH} ${c.num ? 'text-right' : ''}`}>
                  <button type="button" onClick={() => toggle(c)} title={c.hint}
                    className={`inline-flex items-center gap-1 uppercase tracking-wide font-semibold rounded outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${on ? 'text-[#2f3941]' : 'hover:text-[#2f3941]'} ${c.num ? 'flex-row-reverse' : ''}`}>
                    {c.label}
                    {on ? (sort.dir === 'asc' ? <ArrowUp size={11} aria-hidden /> : <ArrowDown size={11} aria-hidden />) : <ChevronsUpDown size={11} className="text-[#87929d]" aria-hidden />}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading
            ? [0, 1, 2, 3].map((i) => <tr key={i} className="border-t border-[#e9ebed]">{cols.map((c) => <td key={c.key} className={`${TD} ${c.num ? 'text-right' : ''}`}><Skel /></td>)}</tr>)
            : sorted.length === 0
              ? <tr className="border-t border-[#e9ebed]"><td colSpan={cols.length} className="px-4 py-6 text-center text-[#68737d]">{empty}</td></tr>
              : sorted.map((row) => (
                <tr key={rowKey(row)} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9]">
                  {cols.map((c) => <td key={c.key} className={`${TD} whitespace-nowrap ${c.num ? NUM : ''}`}>{c.cell ? c.cell(row) : (c.sort(row) ?? '—')}</td>)}
                </tr>
              ))}
        </tbody>
        {!loading && foot && sorted.length > 0 && (
          <tfoot>
            <tr className="border-t border-[#d8dcde] bg-[#f8f9f9] font-semibold text-[#2f3941]">
              {foot.map((v, i) => <td key={cols[i]?.key ?? i} className={`px-3 py-2 whitespace-nowrap ${cols[i]?.num ? NUM : ''}`}>{v}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// ── Drawers ──────────────────────────────────────────────────────────────────
function LeadsDrawer({ title, leads, siteName, openLead, onClose }: {
  title: string; leads: Lead[]; siteName: (id: string) => string; openLead: (id: string) => void; onClose: () => void
}) {
  return (
    <Drawer title={`${title} (${num(leads.length)})`} onClose={onClose} width={480}>
      {leads.length === 0 ? <Empty text="No leads here." /> : (
        <ul className="divide-y divide-[#e9ebed] -mx-5">
          {leads.map((l) => (
            <li key={String(l.id)}>
              <button type="button" onClick={() => openLead(recordIdOf(l))} className="w-full text-left px-5 py-2.5 hover:bg-[#f8f9f9] outline-none focus-visible:bg-[#edf7ff]">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-[#1f73b7] truncate">{leadTitle(l)}</span>
                  {l.stage && isCrmStage(l.stage) && <Chip tone={l.stage === 'won' ? 'green' : l.stage === 'new' ? 'blue' : 'grey'}>{CRM_STAGE_LABEL[l.stage]}</Chip>}
                </span>
                <span className="block text-[12px] text-[#68737d] truncate" title={formatDateTime(l.created_at)}>
                  {siteName(l.site_id)} · {formatShortDateTime(l.created_at)} · {l.owner ? short(l.owner) : 'Unassigned'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}

function CountList({ title, rows }: { title: string; rows: Count[] }) {
  if (rows.length === 0) return null
  const max = Math.max(1, ...rows.map((r) => r.visits))
  return (
    <div className="mt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d] mb-1">{title}</h3>
      <table className="w-full text-[13px]">
        <thead className="sr-only"><tr><th scope="col">{title}</th><th scope="col">Visits</th><th scope="col">Picked up</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-[#e9ebed]">
              <td className="py-1.5 pr-2 max-w-[220px]">
                <span className="block truncate text-[#2f3941]" title={r.label}>{r.label}</span>
                <span className="block h-[3px] rounded-sm bg-[#1f73b7]" style={{ width: `${(r.visits / max) * 100}%` }} aria-hidden />
              </td>
              <td className={`py-1.5 pl-2 ${NUM} text-[#2f3941]`} title={`${num(r.visits)} visits, ${num(r.picked)} picked up`}>{num(r.visits)}</td>
              <td className={`py-1.5 pl-2 ${NUM} text-[#68737d] w-24`}>{num(r.picked)} picked up</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One day's visits split by site, and — where the workspace has it — one
 *  site's visits split by source, page, country and device. */
function TrafficDrawer({ day, bucket, canDrill, onClose }: { day: string; bucket: number; canDrill: boolean; onClose: () => void }) {
  const [site, setSite] = useState<{ id: string; name: string } | null>(null)
  const base = `/api/admin/analytics/breakdown?range=daily&bucket=${bucket}`
  const sites = useApi<BreakdownRes>(base)
  const detail = useApi<SiteDetailRes>(site ? `${base}&site=${encodeURIComponent(site.id)}` : null)
  const d = detail.data?.detail
  return (
    <Drawer title={site ? `${site.name} · ${dayLabel(day)}` : `Visitors by site · ${dayLabel(day)}`} onClose={onClose} width={520}>
      {site ? (
        <>
          <button type="button" className={BTN_PLAIN} onClick={() => setSite(null)}>Back to all sites</button>
          {detail.status === 'loading' && <p className="mt-4 text-[13px] text-[#68737d]">Loading…</p>}
          {detail.status === 'forbidden' && <div className="mt-4"><Notice text="The source and page breakdown is not available on this account." /></div>}
          {detail.status === 'error' && <div className="mt-4"><Notice bad text={detail.error} /></div>}
          {d && (
            <>
              <dl className="mt-4 grid grid-cols-3 gap-3 text-[13px]">
                {([['Visits', d.visits], ['People', d.unique], ['Chats', detail.data?.chats ?? 0], ['Picked up', d.picked], ['New', d.newVisitors], ['Returning', d.returning]] as [string, number][]).map(([k, v]) => (
                  <div key={k}><dt className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">{k}</dt><dd className="text-[16px] font-semibold tabular-nums text-[#2f3941]">{num(v)}</dd></div>
                ))}
              </dl>
              {d.crawler > 0 && <p className="mt-2 text-[12px] text-[#68737d]">{num(d.crawler)} of these visits came from search-engine crawlers.</p>}
              {d.visits === 0 && <div className="mt-4"><Empty text="This site had no visits on this day." /></div>}
              <CountList title="Sources" rows={d.sources} />
              <CountList title="Landing pages" rows={d.landingPages} />
              <CountList title="Pages viewed" rows={d.pagesViewed} />
              <CountList title="Countries" rows={d.countries} />
              <CountList title="Devices" rows={d.devices} />
            </>
          )}
        </>
      ) : (
        <>
          {sites.status === 'loading' && <p className="text-[13px] text-[#68737d]">Loading…</p>}
          {sites.status === 'forbidden' && <Notice text="The per-site breakdown is not available on this account." />}
          {sites.status === 'error' && <Notice bad text={sites.error} />}
          {sites.data && (sites.data.sites.length === 0 ? <Empty text="No site recorded a visit or a chat on this day." /> : (
            <div className="rounded-lg border border-[#d8dcde] overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead><tr className="bg-[#f8f9f9] text-left">{['Site', 'Visits', 'People', 'Chats', 'Picked up'].map((h, i) => <th key={h} scope="col" className={`${TH} ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
                <tbody>
                  {sites.data.sites.map((s) => (
                    <tr key={s.siteId} className="border-t border-[#e9ebed]">
                      <td className={`${TD} max-w-[200px] truncate`}>
                        {canDrill
                          ? <button type="button" className={LINK} onClick={() => setSite({ id: s.siteId, name: s.name })} aria-label={`${s.name}: show sources and pages`}>{s.name}</button>
                          : <span className="font-medium text-[#2f3941]">{s.name}</span>}
                      </td>
                      <td className={`${TD} ${NUM}`}>{num(s.visits)}</td>
                      <td className={`${TD} ${NUM}`}>{num(s.unique)}</td>
                      <td className={`${TD} ${NUM}`}>{num(s.chats)}</td>
                      <td className={`${TD} ${NUM}`}>{num(s.picked)}</td>
                    </tr>
                  ))}
                </tbody>
                {sites.data.total && (
                  <tfoot><tr className="border-t border-[#d8dcde] bg-[#f8f9f9] font-semibold text-[#2f3941]">
                    <td className="px-3 py-2">All sites</td>
                    {[sites.data.total.visits, sites.data.total.unique, sites.data.total.chats, sites.data.total.picked].map((v, i) => <td key={i} className={`px-3 py-2 ${NUM}`}>{num(v)}</td>)}
                  </tr></tfoot>
                )}
              </table>
            </div>
          ))}
          {sites.data && sites.data.sites.length > 0 && (
            <p className="mt-2 text-[12px] text-[#68737d]">One person who visited two sites counts once in the total and once on each site, so People does not add up.{canDrill ? ' Select a site for its sources and pages.' : ''}</p>
          )}
        </>
      )}
    </Drawer>
  )
}

function PickupDrawer({ day, siteName, openChat, onClose }: { day: PerfDay; siteName: (id: string) => string; openChat: (id: string) => void; onClose: () => void }) {
  return (
    <Drawer title={`Chats and pickups · ${dayLabel(day.date)}`} onClose={onClose}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d] mb-1">Picked up by</h3>
      {day.byAgent.length === 0 ? <p className="text-[13px] text-[#68737d]">No pickup on this day is credited to a named agent.</p> : (
        <ul className="divide-y divide-[#e9ebed]">
          {day.byAgent.map((a) => (
            <li key={a.email} className="py-1.5 flex items-center gap-2 text-[13px]">
              <Avatar label={short(a.email)} tone="agent" size={24} /><span className="truncate text-[#2f3941]">{short(a.email)}</span>
              <span className="ml-auto tabular-nums text-[#2f3941]">{num(a.picked)}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-[#68737d] mb-1">Chats ({num(day.chatSessions.length)})</h3>
      {day.chatSessions.length === 0 ? <p className="text-[13px] text-[#68737d]">No visitor wrote in on this day.</p> : (
        <ul className="divide-y divide-[#e9ebed]">
          {day.chatSessions.map((c) => (
            <li key={c.session_id}>
              <button type="button" onClick={() => openChat(c.session_id)} className="w-full text-left py-1.5 text-[13px] hover:bg-[#f8f9f9] outline-none focus-visible:bg-[#edf7ff]">
                <span className="text-[#1f73b7] font-medium">Open chat</span>
                <span className="text-[#68737d]"> · {siteName(c.site_id)} · {c.session_id.slice(0, 8)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  )
}

// ── The screen ───────────────────────────────────────────────────────────────
type Tab = 'overview' | 'team' | 'month'
type Open =
  | { kind: 'leads'; title: string; leads: Lead[] }
  | { kind: 'traffic'; day: string; bucket: number }
  | { kind: 'pickup'; day: PerfDay }

export default function Reports({ me, openLead, openChat }: ZdScreenProps) {
  const admin = me.role === 'admin'
  const [tab, setTab] = useState<Tab>('overview')
  const [preset, setPreset] = useState<Preset>('last-30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [nonce, setNonce] = useState(0)
  const [open, setOpen] = useState<Open | null>(null)
  const [teamSeen, setTeamSeen] = useState(false)

  const span = useMemo(() => presetDays(preset, customFrom, customTo), [preset, customFrom, customTo])
  const range = useMemo(() => (span ? pktCustomRange(span.from, span.to) : null), [span])
  const days = useMemo(() => (range ? pktDaysInRange(range) : []), [range])
  // The 30 Karachi days the analytics endpoint's daily buckets cover, oldest
  // first — the position of a day in this list is its bucket number.
  const window30 = useMemo(() => Array.from({ length: 30 }, (_, i) => pktDayKeyOffset(i - 29)), [])
  const today = window30[29]

  const fromTo = range ? `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}` : ''
  const reportQuery = span ? `preset=custom&from=${span.from}&to=${span.to}` : ''

  const sites = useApi<{ sites: SiteInfo[] }>('/api/admin/sites', nonce)
  const leadsApi = useApi<{ leads: Lead[] }>('/api/admin/leads-list', nonce)
  const report = useApi<ReportData>(admin && span ? `/api/admin/report?${reportQuery}` : null, nonce)
  const analytics = useApi<AnalyticsRes>(!admin || report.status === 'forbidden' ? '/api/admin/analytics?range=daily' : null, nonce)
  const wantTeam = teamSeen || tab === 'team'
  const perf = useApi<PerfRes>(wantTeam && admin && range ? `/api/admin/performance?${fromTo}` : null, nonce)
  const attendance = useApi<AttendanceRes>(wantTeam && admin && range ? `/api/admin/attendance?${fromTo}` : null, nonce)
  const presence = useApi<PresenceRes>(wantTeam ? '/api/admin/presence' : null, nonce)
  const tasks = useApi<TasksRes>(wantTeam ? '/api/tasks?assignee=all' : null, nonce)

  const siteNames = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sites.data?.sites ?? []) m.set(s.site_id, s.name || s.site_id)
    for (const s of report.data?.sites ?? []) if (!m.has(s.siteId)) m.set(s.siteId, s.siteName)
    return m
  }, [sites.data, report.data])
  const siteName = (id: string) => siteNames.get(id) ?? id

  // Leads the member may see, inside the range, with "not a lead" rows left out
  // exactly as the lead list itself leaves them out of its counts.
  const leads = useMemo(() => {
    if (!span) return []
    return (leadsApi.data?.leads ?? []).filter((l) => {
      if (l.notALead) return false
      const d = pktDayKey(l.created_at)
      return d >= span.from && d <= span.to
    })
  }, [leadsApi.data, span])
  const leadsByDay = useMemo(() => {
    const m = new Map<string, Lead[]>()
    for (const l of leads) { const d = pktDayKey(l.created_at); m.set(d, [...(m.get(d) ?? []), l]) }
    return m
  }, [leads])

  // Visitors and chats per day: the report's exact figures for an admin, the
  // analytics endpoint's last 30 days for everyone else.
  const traffic = useMemo(() => {
    const byDay = new Map<string, { visitors: number; chats: number; picked: number }>()
    if (report.status === 'ok' && report.data) {
      for (const d of report.data.days) byDay.set(d.date, { visitors: d.clicks, chats: d.chats, picked: d.picked })
      return { status: 'ok' as Status, error: '', byDay, partial: false }
    }
    if (report.status === 'loading' || report.status === 'error') return { status: report.status, error: report.error, byDay, partial: false }
    if (analytics.status === 'ok' && analytics.data) {
      const pts = analytics.data.points
      // Buckets end today, so they are matched from the newest backwards.
      pts.forEach((p, i) => { const day = window30[window30.length - pts.length + i]; if (day) byDay.set(day, { visitors: p.visitors, chats: p.chats, picked: p.picked ?? 0 }) })
      return { status: 'ok' as Status, error: '', byDay, partial: !!span && span.from < window30[0] }
    }
    return { status: analytics.status, error: analytics.error, byDay, partial: false }
  }, [report, analytics, window30, span])

  const sum = useMemo(() => {
    let visitors = 0, chats = 0, picked = 0
    for (const d of days) { const t = traffic.byDay.get(d); if (t) { visitors += t.visitors; chats += t.chats; picked += t.picked } }
    return { visitors, chats, picked }
  }, [days, traffic])

  const showLeads = (title: string, list: Lead[]) => setOpen({ kind: 'leads', title, leads: list })
  const canDrill = isWorkspace(me.workspace) && hasFeature(me.workspace, 'trafficdetail')
  const noSites = sites.status === 'ok' && (sites.data?.sites.length ?? 0) === 0
  const rangeText = range ? describeRange(range) : 'Pick a start and an end date'

  const tabs: { key: Tab; label: string }[] = [{ key: 'overview', label: 'Overview' }, { key: 'team', label: 'Team' }, { key: 'month', label: 'Month-end' }]

  return (
    <main className="flex-1 min-w-0 overflow-y-auto text-[13px] text-[#2f3941]">
      <PageHead title="Reports" sub={`${rangeText} · Pakistan time`} actions={
        <>
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Date range" className={`${INPUT} !w-auto !h-8 cursor-pointer`}>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          {preset === 'custom' && (
            <>
              <input type="date" value={customFrom} max={customTo || today} onChange={(e) => setCustomFrom(e.target.value)} aria-label="From date" className={`${INPUT} !w-auto !h-8 tabular-nums`} />
              <span className="text-[#68737d]">to</span>
              <input type="date" value={customTo} min={customFrom || undefined} max={today} onChange={(e) => setCustomTo(e.target.value)} aria-label="To date" className={`${INPUT} !w-auto !h-8 tabular-nums`} />
            </>
          )}
          <button type="button" className={BTN_PLAIN} onClick={() => setNonce((n) => n + 1)} aria-label="Refresh the figures"><RefreshCw size={14} aria-hidden />Refresh</button>
        </>
      } />

      <div className="px-6 border-b border-[#d8dcde] flex gap-5" role="tablist" aria-label="Report">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" id={`zd-rep-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="zd-rep-panel"
            onClick={() => { setTab(t.key); if (t.key === 'team') setTeamSeen(true) }}
            className={`relative -mb-px pb-2.5 pt-1 text-[14px] border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded-t ${tab === t.key ? 'border-[#1f73b7] text-[#1f73b7] font-semibold' : 'border-transparent text-[#49545c] hover:text-[#2f3941]'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div id="zd-rep-panel" role="tabpanel" aria-labelledby={`zd-rep-tab-${tab}`} className="px-6 py-5 space-y-4 max-w-[1400px]">
        {!span && <Empty text="Pick a start date and an end date to see the figures for that range." />}
        {span && noSites && (
          <p className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] px-4 py-3 text-[13px] text-[#49545c]">
            No site is connected to this workspace yet, so there is nothing to count. Visitors, chats and leads appear here as soon as a site starts sending them.
          </p>
        )}

        {span && tab === 'overview' && (
          <OverviewTab days={days} today={today} window30={window30} traffic={traffic} sum={sum}
            leads={leads} leadsByDay={leadsByDay} leadsStatus={leadsApi.status} leadsError={leadsApi.error}
            report={report} siteNames={siteNames} siteName={siteName} showLeads={showLeads}
            openTraffic={(day, bucket) => setOpen({ kind: 'traffic', day, bucket })} />
        )}

        {span && tab === 'team' && (
          <TeamTab me={me.email} admin={admin} perf={perf} attendance={attendance} presence={presence} tasks={tasks}
            leads={leads} leadsStatus={leadsApi.status} showLeads={showLeads} openPickup={(day) => setOpen({ kind: 'pickup', day })} />
        )}

        {span && tab === 'month' && (
          <MonthTab admin={admin} report={report} query={reportQuery} fileStem={`${me.workspace}-report-${span.from}-to-${span.to}`} />
        )}
      </div>

      {open?.kind === 'leads' && <LeadsDrawer title={open.title} leads={open.leads} siteName={siteName} openLead={openLead} onClose={() => setOpen(null)} />}
      {open?.kind === 'traffic' && <TrafficDrawer day={open.day} bucket={open.bucket} canDrill={canDrill} onClose={() => setOpen(null)} />}
      {open?.kind === 'pickup' && <PickupDrawer day={open.day} siteName={siteName} openChat={openChat} onClose={() => setOpen(null)} />}
    </main>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
interface TrafficState { status: Status; error: string; byDay: Map<string, { visitors: number; chats: number; picked: number }>; partial: boolean }

function OverviewTab({ days, today, window30, traffic, sum, leads, leadsByDay, leadsStatus, leadsError, report, siteNames, siteName, showLeads, openTraffic }: {
  days: string[]; today: string; window30: string[]; traffic: TrafficState; sum: { visitors: number; chats: number; picked: number }
  leads: Lead[]; leadsByDay: Map<string, Lead[]>; leadsStatus: Status; leadsError: string
  report: Api<ReportData>; siteNames: Map<string, string>; siteName: (id: string) => string
  showLeads: (title: string, list: Lead[]) => void; openTraffic: (day: string, bucket: number) => void
}) {
  const tLoading = traffic.status === 'loading'
  const tOk = traffic.status === 'ok'
  const lLoading = leadsStatus === 'loading'
  const exact = report.status === 'ok' && report.data ? report.data : null

  const siteRows = useMemo(() => {
    const ids = new Set<string>(siteNames.keys())
    for (const l of leads) ids.add(l.site_id)
    return Array.from(ids).map((id) => ({
      id, name: siteName(id), leads: leads.filter((l) => l.site_id === id),
      exact: exact?.sites.find((s) => s.siteId === id) ?? null,
    }))
  }, [siteNames, leads, exact, siteName])
  const maxSiteLeads = Math.max(1, ...siteRows.map((s) => s.leads.length))

  const siteCols: Col<(typeof siteRows)[number]>[] = [
    { key: 'name', label: 'Site', sort: (s) => s.name, cell: (s) => <span className="font-medium text-[#2f3941]">{s.name}</span> },
    {
      key: 'leads', label: 'Leads', num: true, sort: (s) => s.leads.length,
      cell: (s) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="hidden sm:block w-24 h-[6px] border-l border-[#68737d]" aria-hidden><span className="block h-full rounded-r-sm bg-[#1f73b7]" style={{ width: `${(s.leads.length / maxSiteLeads) * 100}%` }} /></span>
          {s.leads.length > 0
            ? <button type="button" className={LINK} onClick={() => showLeads(`Leads from ${s.name}`, s.leads)} aria-label={`${s.leads.length} leads from ${s.name}. Show the list`}>{num(s.leads.length)}</button>
            : <span>0</span>}
        </span>
      ),
    },
    ...(exact ? [
      { key: 'visitors', label: 'Visitors', num: true, sort: (s) => s.exact?.clicks ?? null, cell: (s) => (s.exact ? num(s.exact.clicks) : '—') },
      { key: 'chats', label: 'Chats', num: true, sort: (s) => s.exact?.chats ?? null, cell: (s) => (s.exact ? num(s.exact.chats) : '—') },
      { key: 'picked', label: 'Picked up', num: true, sort: (s) => s.exact?.picked ?? null, cell: (s) => (s.exact ? num(s.exact.picked) : '—') },
    ] as Col<(typeof siteRows)[number]>[] : []),
  ]

  return (
    <>
      <Tiles>
        {traffic.status !== 'forbidden' && <Tile label="Visitors" loading={tLoading} value={tOk ? num(sum.visitors) : '—'} sub="Chat widget sessions" />}
        {traffic.status !== 'forbidden' && <Tile label="Chats" loading={tLoading} value={tOk ? num(sum.chats) : '—'} sub="Visitors who wrote in" />}
        {traffic.status !== 'forbidden' && <Tile label="Picked up" loading={tLoading} value={tOk ? num(sum.picked) : '—'} sub={tOk && sum.visitors > 0 ? `${pct(sum.picked / sum.visitors)} of visitors` : 'Sessions an agent engaged'} />}
        <Tile label="Leads" loading={lLoading} value={leadsStatus === 'ok' ? num(leads.length) : '—'} sub="Captured in this range"
          onOpen={leads.length > 0 ? () => showLeads('Leads in this range', leads) : undefined} />
        {exact && <Tile label="Avg first response" value={duration(exact.totals.avgResponseMs)} sub={exact.totals.avgResponseMs === null ? 'No measured replies yet' : 'Visitor message to agent reply'} />}
      </Tiles>

      {traffic.status === 'forbidden' && <Notice text="Visitor and chat figures are not available on this account, so only leads are shown." />}
      {traffic.status === 'error' && <Notice bad text={`Visitor and chat figures could not be loaded. ${traffic.error}`} />}
      {leadsStatus === 'error' && <Notice bad text={`Leads could not be loaded. ${leadsError}`} />}
      {traffic.partial && <Notice text="Visitor and chat figures are kept for the last 30 days on this account. Earlier days in this range show a dash." />}
      {exact?.truncated && <Notice bad text="This range holds more rows than one report can read, so the latest days may be short. Pick a narrower range for exact figures." />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Section title="Leads per day" sub={leadsStatus === 'ok' ? `${num(leads.length)} in this range` : undefined}>
          <BarChart label="Leads per day" unit="leads" loading={lLoading} empty="No leads were captured in this range."
            data={days.map((d) => ({ key: d, label: dayLabel(d), value: leadsByDay.get(d)?.length ?? 0 }))}
            onPick={(d) => showLeads(`Leads on ${dayLabel(d)}`, leadsByDay.get(d) ?? [])} />
        </Section>
        {traffic.status !== 'forbidden' && (
          <Section title="Visitors per day" sub={tOk ? `${num(sum.visitors)} in this range` : undefined}>
            <BarChart label="Visitors per day" unit="visitors" loading={tLoading} empty="No visitors were recorded in this range."
              data={days.map((d) => ({ key: d, label: dayLabel(d), value: traffic.byDay.get(d)?.visitors ?? 0 }))} />
          </Section>
        )}
      </div>

      <Section title="Sites" sub="Leads captured in this range, by the site they came from">
        <SortTable label="Sites" cols={siteCols} rows={siteRows} rowKey={(s) => s.id} initial={{ key: 'leads', dir: 'desc' }}
          loading={lLoading && siteRows.length === 0} empty="No site is connected yet. Each site appears here with its leads once it is added." />
      </Section>

      <Section title="Day by day" sub="Select a visitor count to see which sites, sources and pages it came from">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" aria-label="Day by day">
            <thead><tr className="bg-[#f8f9f9] text-left">{['Day', 'Visitors', 'Chats', 'Picked up', 'Leads'].map((h, i) => <th key={h} scope="col" className={`${TH} ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
            <tbody>
              {[...days].reverse().map((d) => {
                const t = traffic.byDay.get(d)
                const dayLeads = leadsByDay.get(d) ?? []
                const bucket = window30.indexOf(d)
                return (
                  <tr key={d} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9]">
                    <td className={`${TD} whitespace-nowrap`}><span className="font-medium text-[#2f3941]">{dayLabel(d)}</span>{d === today && <span className="ml-2"><Chip tone="blue">Today</Chip></span>}</td>
                    <td className={`${TD} ${NUM}`}>
                      {tLoading ? <Skel /> : !t ? '—' : t.visitors > 0 && bucket >= 0
                        ? <button type="button" className={LINK} onClick={() => openTraffic(d, bucket)} aria-label={`${t.visitors} visitors on ${dayLabel(d)}. Show them by site`}>{num(t.visitors)}</button>
                        : num(t.visitors)}
                    </td>
                    <td className={`${TD} ${NUM}`}>{tLoading ? <Skel /> : t ? num(t.chats) : '—'}</td>
                    <td className={`${TD} ${NUM}`}>{tLoading ? <Skel /> : t ? num(t.picked) : '—'}</td>
                    <td className={`${TD} ${NUM}`}>
                      {lLoading ? <Skel /> : dayLeads.length > 0
                        ? <button type="button" className={LINK} onClick={() => showLeads(`Leads on ${dayLabel(d)}`, dayLeads)} aria-label={`${dayLeads.length} leads on ${dayLabel(d)}. Show the list`}>{num(dayLeads.length)}</button>
                        : leadsStatus === 'ok' ? 0 : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-[#d8dcde] bg-[#f8f9f9] font-semibold text-[#2f3941]">
                <td className="px-3 py-2">Total</td>
                <td className={`px-3 py-2 ${NUM}`}>{tOk ? num(sum.visitors) : '—'}</td>
                <td className={`px-3 py-2 ${NUM}`}>{tOk ? num(sum.chats) : '—'}</td>
                <td className={`px-3 py-2 ${NUM}`}>{tOk ? num(sum.picked) : '—'}</td>
                <td className={`px-3 py-2 ${NUM}`}>{leadsStatus === 'ok' ? num(leads.length) : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>
    </>
  )
}

// ── Team ─────────────────────────────────────────────────────────────────────
interface TeamRow {
  email: string; perf: PerfAgent | null; online: boolean | null; lastSeen: string | null
  owned: Lead[] | null; openTasks: number | null; overdue: number | null; secs: number | null
}

function TeamTab({ me, admin, perf, attendance, presence, tasks, leads, leadsStatus, showLeads, openPickup }: {
  me: string; admin: boolean; perf: Api<PerfRes>; attendance: Api<AttendanceRes>; presence: Api<PresenceRes>; tasks: Api<TasksRes>
  leads: Lead[]; leadsStatus: Status; showLeads: (title: string, list: Lead[]) => void; openPickup: (day: PerfDay) => void
}) {
  const p = perf.data
  const hasPerf = perf.status === 'ok' && !!p
  const hasTasks = tasks.status === 'ok' && !!tasks.data
  const hasAttendance = attendance.status === 'ok' && !!attendance.data

  const rows = useMemo<TeamRow[]>(() => {
    const emails = new Set<string>()
    for (const a of p?.agents ?? []) emails.add(a.email)
    for (const a of presence.data?.agents ?? []) emails.add(a.email)
    if (emails.size === 0) emails.add(me)
    const open = [...(tasks.data?.groups.overdue ?? []), ...(tasks.data?.groups.today ?? []), ...(tasks.data?.groups.upcoming ?? [])]
    return Array.from(emails).map((email) => {
      const pres = presence.data?.agents.find((a) => a.email === email)
      // A standard member is sent only their own leads and the unassigned pool,
      // so a count for a colleague would be a false zero. It is left blank.
      const mayCount = leadsStatus === 'ok' && (admin || email === me)
      return {
        email,
        perf: p?.agents.find((a) => a.email === email) ?? null,
        online: pres ? pres.online : null,
        lastSeen: pres?.lastSeen ?? null,
        owned: mayCount ? leads.filter((l) => l.owner === email) : null,
        openTasks: hasTasks ? open.filter((t) => t.assignee === email).length : null,
        overdue: hasTasks ? (tasks.data?.groups.overdue ?? []).filter((t) => t.assignee === email).length : null,
        secs: hasAttendance ? (attendance.data?.days ?? []).filter((d) => d.email === email).reduce((n, d) => n + d.secs, 0) : null,
      }
    })
  }, [p, presence.data, tasks.data, attendance.data, leads, leadsStatus, admin, me, hasTasks, hasAttendance])

  const dash = <span className="text-[#87929d]">—</span>
  const cols: Col<TeamRow>[] = [
    {
      key: 'agent', label: 'Agent', sort: (r) => short(r.email),
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <Avatar label={short(r.email)} tone="agent" size={24} />
          <span className="font-medium text-[#2f3941]" title={r.email}>{short(r.email)}</span>
          {r.perf?.former && <Chip>Former</Chip>}
        </span>
      ),
    },
    {
      key: 'online', label: 'Status', sort: (r) => (r.online === null ? null : r.online ? 0 : 1), hint: 'Whether this agent has the workspace open right now',
      cell: (r) => (r.online === null ? dash : (
        <span className="inline-flex items-center gap-1.5" title={r.lastSeen ? `Last seen ${formatDateTime(r.lastSeen)}` : undefined}>
          <span className={`w-2 h-2 rounded-full ${r.online ? 'bg-[#038153]' : 'border border-[#87929d]'}`} aria-hidden />{r.online ? 'Online' : 'Offline'}
        </span>
      )),
    },
    ...(hasPerf ? [
      { key: 'handled', label: 'Chats', num: true, hint: 'Chats this agent replied in', sort: (r) => r.perf?.handled ?? null, cell: (r) => (r.perf ? num(r.perf.handled) : dash) },
      { key: 'proactive', label: 'Started', num: true, hint: 'Chats the agent opened by writing to a visitor first', sort: (r) => r.perf?.proactive ?? null, cell: (r) => (r.perf ? num(r.perf.proactive) : dash) },
      { key: 'replies', label: 'Replies', num: true, sort: (r) => r.perf?.replies ?? null, cell: (r) => (r.perf ? num(r.perf.replies) : dash) },
      { key: 'avg', label: 'Avg response', num: true, hint: 'Visitor message to this agent’s reply. Replies later than 8 hours are left out of the average', sort: (r) => r.perf?.avgResponseMs ?? null, cell: (r) => (r.perf ? duration(r.perf.avgResponseMs) : dash) },
      {
        key: 'slow', label: 'Slow replies', num: true, hint: 'Replies that took longer than 2 minutes', sort: (r) => r.perf?.slowReplies ?? null,
        cell: (r) => (r.perf ? <span title={`${r.perf.slowReplies} of ${r.perf.measuredReplies} measured replies`}>{num(r.perf.slowReplies)}{r.perf.measuredReplies > 0 && r.perf.slowReplies > 0 ? ` (${Math.round((r.perf.slowReplies / r.perf.measuredReplies) * 100)}%)` : ''}</span> : dash),
      },
      { key: 'dropped', label: 'Dropped', num: true, hint: 'The agent replied last, the visitor wrote again, and nobody answered', sort: (r) => r.perf?.dropped ?? null, cell: (r) => (r.perf ? num(r.perf.dropped) : dash) },
      { key: 'chatleads', label: 'Chat leads', num: true, hint: 'Chats this agent replied in that captured a lead', sort: (r) => r.perf?.leads ?? null, cell: (r) => (r.perf ? num(r.perf.leads) : dash) },
    ] as Col<TeamRow>[] : []),
    {
      key: 'owned', label: 'Leads owned', num: true, hint: 'Leads captured in this range that this agent owns now', sort: (r) => r.owned?.length ?? null,
      cell: (r) => (r.owned === null ? dash : r.owned.length === 0 ? 0
        : <button type="button" className={LINK} onClick={() => showLeads(`Leads owned by ${short(r.email)}`, r.owned ?? [])} aria-label={`${r.owned.length} leads owned by ${short(r.email)}. Show the list`}>{num(r.owned.length)}</button>),
    },
    {
      key: 'won', label: 'Won', num: true, hint: 'Of the leads owned, how many are at the Won stage now', sort: (r) => (r.owned ? r.owned.filter((l) => l.stage === 'won').length : null),
      cell: (r) => (r.owned === null ? dash : num(r.owned.filter((l) => l.stage === 'won').length)),
    },
    ...(hasTasks ? [
      { key: 'tasks', label: 'Open tasks', num: true, hint: 'Open tasks assigned to this agent right now', sort: (r) => r.openTasks, cell: (r) => (r.openTasks === null ? dash : num(r.openTasks)) },
      { key: 'overdue', label: 'Overdue', num: true, hint: 'Open tasks past their due time right now', sort: (r) => r.overdue, cell: (r) => (r.overdue === null ? dash : num(r.overdue)) },
    ] as Col<TeamRow>[] : []),
    ...(hasAttendance ? [
      { key: 'secs', label: 'Online time', num: true, hint: 'Time with the workspace open in this range', sort: (r) => r.secs, cell: (r) => (r.secs ? onlineTime(r.secs) : dash) },
    ] as Col<TeamRow>[] : []),
    ...(hasPerf ? [
      { key: 'last', label: 'Last reply', num: true, sort: (r) => r.perf?.lastReplyAt ?? null, cell: (r) => (r.perf?.lastReplyAt ? <span title={formatDateTime(r.perf.lastReplyAt)}>{timeAgo(r.perf.lastReplyAt)}</span> : dash) },
    ] as Col<TeamRow>[] : []),
  ]

  const s = p?.summary
  const loadingTable = presence.status === 'loading' || perf.status === 'loading'

  return (
    <>
      {admin && perf.status !== 'forbidden' && (
        <Tiles>
          <Tile label="Conversations" loading={perf.status === 'loading'} value={s ? num(s.totalConversations) : '—'}
            sub={s && s.totalConversations > 0 ? `${pct(s.answeredConversations / s.totalConversations)} answered by an agent` : 'With at least one message'} />
          <Tile label="Chat leads" loading={perf.status === 'loading'} value={s ? num(s.totalLeads) : '—'} sub="Contact details captured in chat" />
          <Tile label="Avg response" loading={perf.status === 'loading'} value={s ? duration(s.avgResponseMs) : '—'}
            sub={s && s.avgExcludedOutliers > 0 ? `${num(s.avgExcludedOutliers)} over 8 hours left out` : 'Visitor message to agent reply'} />
          <Tile label="Waiting, no reply" loading={perf.status === 'loading'} value={s ? num(s.totalUnanswered) : '—'} sub={s ? `${num(s.totalMissed)} waited over 2 minutes` : ''} />
          <Tile label="Visitors not contacted" loading={perf.status === 'loading'} value={s ? num(s.ignoredVisitors) : '—'} sub="Never wrote, never greeted" />
        </Tiles>
      )}

      {(!admin || perf.status === 'forbidden') && <Notice text="Reply counts, response times and attendance are visible to admins only. You see who is online, your own leads and open tasks." />}
      {perf.status === 'error' && <Notice bad text={`Reply and response figures could not be loaded. ${perf.error}`} />}
      {attendance.status === 'error' && <Notice bad text={`Attendance could not be loaded. ${attendance.error}`} />}
      {presence.status === 'error' && <Notice bad text={`Online status could not be loaded. ${presence.error}`} />}
      {tasks.status === 'error' && <Notice bad text={`Tasks could not be loaded. ${tasks.error}`} />}
      {hasPerf && p && p.summary.totalReplies > 0 && p.unattributedReplies > 0 && (
        <Notice text={`${num(p.unattributedReplies)} of ${num(p.summary.totalReplies)} agent replies in this range carry no author, so they count in the totals above but not in any agent’s row.`} />
      )}

      <Section title="Agents" sub="Replies and response times cover the chosen range. Status and tasks are as of now.">
        <SortTable key={hasPerf ? 'full' : 'basic'} label="Agents" cols={cols} rows={rows} rowKey={(r) => r.email} initial={{ key: hasPerf ? 'replies' : 'agent', dir: hasPerf ? 'desc' : 'asc' }}
          loading={loadingTable} empty="No agents in this workspace yet." />
      </Section>

      {hasPerf && p && (
        <Section title="Daily pickup" sub="Visitors each day, how many wrote in, and how many an agent engaged">
          {p.daily.length === 0 ? <div className="p-4"><Empty text="No visitors were recorded in this range, so there is nothing to pick up yet." /></div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" aria-label="Daily pickup">
                <thead><tr className="bg-[#f8f9f9] text-left">{['Day', 'Visitors', 'Chats', 'Picked up', 'Not picked up', 'Pickup rate'].map((h, i) => <th key={h} scope="col" className={`${TH} ${i ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
                <tbody>
                  {p.daily.map((d) => (
                    <tr key={d.date} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9]">
                      <td className={`${TD} font-medium text-[#2f3941] whitespace-nowrap`}>{dayLabel(d.date)}</td>
                      <td className={`${TD} ${NUM}`}>{num(d.visitors)}</td>
                      <td className={`${TD} ${NUM}`}>
                        {d.chats > 0 ? <button type="button" className={LINK} onClick={() => openPickup(d)} aria-label={`${d.chats} chats on ${dayLabel(d.date)}. Show them`}>{num(d.chats)}</button> : 0}
                      </td>
                      <td className={`${TD} ${NUM}`}>
                        {d.picked > 0 && d.byAgent.length > 0 ? <button type="button" className={LINK} onClick={() => openPickup(d)} aria-label={`${d.picked} picked up on ${dayLabel(d.date)}. Show by agent`}>{num(d.picked)}</button> : num(d.picked)}
                      </td>
                      <td className={`${TD} ${NUM}`}>{num(d.notPicked)}</td>
                      <td className={`${TD} ${NUM}`}>{d.visitors > 0 ? pct(d.picked / d.visitors) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {hasAttendance && attendance.data && (
        <Section title="Attendance" sub="Time each agent had the workspace open, per day">
          {attendance.data.days.length === 0 ? <div className="p-4"><Empty text="Nobody has been recorded online in this range. Time is counted only while an agent has the workspace open." /></div> : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]" aria-label="Attendance">
                <thead><tr className="bg-[#f8f9f9] text-left">{['Day', 'Agent', 'First seen', 'Last seen', 'Online time'].map((h, i) => <th key={h} scope="col" className={`${TH} ${i > 1 ? 'text-right' : ''}`}>{h}</th>)}</tr></thead>
                <tbody>
                  {attendance.data.days.map((a) => (
                    <tr key={`${a.date}|${a.email}`} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9]">
                      <td className={`${TD} whitespace-nowrap`}>{dayLabel(a.date)}</td>
                      <td className={`${TD} font-medium text-[#2f3941] whitespace-nowrap`} title={a.email}>{short(a.email)}</td>
                      <td className={`${TD} ${NUM} whitespace-nowrap`}>{formatTime(a.first)}</td>
                      <td className={`${TD} ${NUM} whitespace-nowrap`}>{formatTime(a.last)}</td>
                      <td className={`${TD} ${NUM} font-medium text-[#2f3941]`}>{onlineTime(a.secs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </>
  )
}

// ── Month-end ────────────────────────────────────────────────────────────────
function metricCols<T extends Metrics>(first: Col<T>, show: { checkout: boolean; billable: boolean }): Col<T>[] {
  return [
    first,
    { key: 'clicks', label: 'Visitors', num: true, sort: (r) => r.clicks, cell: (r) => num(r.clicks) },
    { key: 'chats', label: 'Chats', num: true, sort: (r) => r.chats, cell: (r) => num(r.chats) },
    { key: 'picked', label: 'Picked up', num: true, sort: (r) => r.picked, cell: (r) => num(r.picked) },
    { key: 'notPicked', label: 'Not picked up', num: true, sort: (r) => r.notPicked, cell: (r) => num(r.notPicked) },
    { key: 'leads', label: 'Leads', num: true, sort: (r) => r.leads, cell: (r) => num(r.leads) },
    ...(show.checkout ? [{ key: 'checkout', label: 'Checkout', num: true, sort: (r: T) => r.checkout, cell: (r: T) => num(r.checkout) }] : []),
    ...(show.billable ? [{ key: 'billable', label: 'Billable', num: true, sort: (r: T) => r.billable, cell: (r: T) => num(r.billable) }] : []),
    { key: 'conversionRate', label: 'Conversion', num: true, sort: (r) => r.conversionRate, cell: (r) => pct(r.conversionRate) },
    { key: 'pickupRate', label: 'Pickup rate', num: true, sort: (r) => r.pickupRate, cell: (r) => pct(r.pickupRate) },
    { key: 'avgResponseMs', label: 'Avg response', num: true, sort: (r) => r.avgResponseMs, cell: (r) => duration(r.avgResponseMs) },
  ]
}

function MonthTab({ admin, report, query, fileStem }: { admin: boolean; report: Api<ReportData>; query: string; fileStem: string }) {
  const [leadsSite, setLeadsSite] = useState('')
  const [busy, setBusy] = useState('')
  const [failed, setFailed] = useState('')

  if (!admin || report.status === 'forbidden') {
    return <Empty text="The month-end report covers every agent and every site, so it is open to workspace admins only." />
  }

  const data = report.data
  const loading = report.status === 'loading'
  const t = data?.totals ?? null
  const show = { checkout: (t?.checkout ?? 0) > 0, billable: (t?.billable ?? 0) > 0 }

  // Fetched and saved here rather than linked, so the file gets this
  // workspace's own name and a failure is said on screen instead of opening a
  // page of JSON.
  async function save(format: string, name: string, extra = '') {
    setBusy(format); setFailed('')
    try {
      const res = await fetch(`/api/admin/report?${query}&format=${format}${extra}`)
      if (!res.ok) { setFailed((await res.json().catch(() => null))?.error || 'That file could not be built. Try again.'); return }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url; a.download = name
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30000)
    } catch {
      setFailed('That file could not be downloaded. Check your connection and try again.')
    } finally {
      setBusy('')
    }
  }
  const exportBtn = (format: string, label: string, name: string, extra = '') => (
    <button type="button" className={BTN_PLAIN} disabled={!data || !!busy} onClick={() => save(format, name, extra)}>
      <Download size={14} aria-hidden />{busy === format ? 'Preparing…' : label}
    </button>
  )

  const footOf = (m: Metrics, first: string): React.ReactNode[] => [
    first, num(m.clicks), num(m.chats), num(m.picked), num(m.notPicked), num(m.leads),
    ...(show.checkout ? [num(m.checkout)] : []), ...(show.billable ? [num(m.billable)] : []),
    pct(m.conversionRate), pct(m.pickupRate), duration(m.avgResponseMs),
  ]

  const agentCols: Col<ReportAgent>[] = [
    { key: 'email', label: 'Agent', sort: (a) => short(a.email), cell: (a) => <span className={a.active ? 'font-medium text-[#2f3941]' : ''} title={a.email}>{short(a.email)}</span> },
    { key: 'chats', label: 'Chats handled', num: true, sort: (a) => a.chats, cell: (a) => num(a.chats) },
    { key: 'replies', label: 'Replies', num: true, sort: (a) => a.replies, cell: (a) => num(a.replies) },
    { key: 'leads', label: 'Leads', num: true, sort: (a) => a.leads, cell: (a) => num(a.leads) },
    { key: 'avg', label: 'Avg response', num: true, sort: (a) => a.avgResponseMs, cell: (a) => duration(a.avgResponseMs) },
    { key: 'slow', label: 'Slow replies', num: true, sort: (a) => a.slowReplies, cell: (a) => num(a.slowReplies) },
    { key: 'measured', label: 'Measured', num: true, hint: 'Replies with a response time on record', sort: (a) => a.measuredReplies, cell: (a) => num(a.measuredReplies) },
  ]
  const siteCols = metricCols<SiteRow>({ key: 'siteName', label: 'Site', sort: (r) => r.siteName, cell: (r) => <span className="font-medium text-[#2f3941]">{r.siteName}</span> }, show)
  const dayCols = metricCols<DayRow>({ key: 'date', label: 'Day', sort: (r) => r.date, cell: (r) => <span className="font-medium text-[#2f3941]">{dayLabel(r.date)}</span> }, show)

  return (
    <>
      {report.status === 'error' && <Notice bad text={`The report could not be built. ${report.error}`} />}
      {data?.truncated && <Notice bad text="This range holds more rows than one report can read, so the latest days may be short. Pick a narrower range for exact figures." />}

      <Section title="Downloads" sub={data ? `Built ${formatDateTime(data.generatedAt)} from the same figures shown below` : 'Built from the same figures shown below'}
        actions={
          <>
            <select value={leadsSite} onChange={(e) => setLeadsSite(e.target.value)} aria-label="Site for the leads PDF" className={`${INPUT} !w-auto !h-8 max-w-[180px] cursor-pointer`}>
              <option value="">All sites</option>
              {(data?.sites ?? []).map((s) => <option key={s.siteId} value={s.siteId}>{s.siteName}</option>)}
            </select>
            {exportBtn('leads.pdf', 'Leads PDF', `${fileStem}-leads${leadsSite ? `-${leadsSite}` : ''}.pdf`, leadsSite ? `&site=${encodeURIComponent(leadsSite)}` : '')}
            {exportBtn('pdf', 'Performance PDF', `${fileStem}.pdf`)}
            {exportBtn('agents.csv', 'Agents CSV', `${fileStem}-agents.csv`)}
            {exportBtn('sites.csv', 'Sites CSV', `${fileStem}-sites.csv`)}
            {exportBtn('daily.csv', 'Daily CSV', `${fileStem}-daily.csv`)}
          </>
        }>
        <div className="px-4 py-2.5 space-y-1">
          <p className="text-[12px] text-[#68737d]">The leads PDF lists every lead in the range one by one and can be limited to a single site. The files call visitors “Clicks”.</p>
          <Notice bad text={failed} />
        </div>
      </Section>

      <Tiles>
        <Tile label="Visitors" loading={loading} value={t ? num(t.clicks) : '—'} sub="Chat widget sessions" />
        <Tile label="Chats" loading={loading} value={t ? num(t.chats) : '—'} sub="Visitors who wrote in" />
        <Tile label="Picked up" loading={loading} value={t ? num(t.picked) : '—'} sub={t ? `${pct(t.pickupRate)} pickup rate` : ''} />
        <Tile label="Not picked up" loading={loading} value={t ? num(t.notPicked) : '—'} sub="Visitors no agent engaged" />
        <Tile label="Leads" loading={loading} value={t ? num(t.leads) : '—'} sub={t ? `${pct(t.conversionRate)} of chats` : ''} />
        {show.checkout && t && <Tile label="Checkout" value={num(t.checkout)} sub="Leads that were store orders" />}
        {show.billable && t && <Tile label="Billable" value={num(t.billable)} sub="Leads, repeats and orders removed" />}
        <Tile label="Avg response" loading={loading} value={t ? duration(t.avgResponseMs) : '—'} sub="Visitor message to agent reply" />
      </Tiles>
      <p className="text-[12px] text-[#68737d]">
        Visitors are chat widget sessions with automated bursts removed. Leads include quote requests that arrive by email without a chat, so the share of chats can pass 100%.
      </p>

      <Section title="Per agent" sub="A chat two agents replied in is credited to both, so these totals can exceed the workspace figure">
        <SortTable label="Per agent" cols={agentCols} rows={data?.agents ?? []} rowKey={(a) => a.email} initial={{ key: 'chats', dir: 'desc' }} loading={loading}
          empty="No agents in this workspace yet."
          foot={data ? ['Total', num(data.agentTotals.chats), num(data.agentTotals.replies), num(data.agentTotals.leads), '—', num(data.agentTotals.slowReplies), num(data.agentTotals.measuredReplies)] : null} />
        {data && data.unattributedReplies > 0 && (
          <p className="px-4 py-2 border-t border-[#e9ebed] text-[12px] text-[#68737d]">{num(data.unattributedReplies)} {data.unattributedReplies === 1 ? 'reply carries' : 'replies carry'} no author and are not in any agent’s row.</p>
        )}
      </Section>

      <Section title="Per site">
        <SortTable label="Per site" cols={siteCols} rows={data?.sites ?? []} rowKey={(r) => r.siteId} initial={{ key: 'clicks', dir: 'desc' }} loading={loading}
          empty="No site is connected yet, so there are no per-site figures." foot={t ? footOf(t, 'Total') : null} />
      </Section>

      <Section title="Daily trend">
        <SortTable label="Daily trend" cols={dayCols} rows={data?.days ?? []} rowKey={(r) => r.date} initial={{ key: 'date', dir: 'asc' }} loading={loading}
          empty="No days to show for this range." foot={t ? footOf(t, 'Total') : null} />
      </Section>
    </>
  )
}
