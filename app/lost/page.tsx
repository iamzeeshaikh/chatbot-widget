'use client'

// Lost — /lost (packaging only).
//
// Every Lost lead this member can see, newest lost first, so somebody can work
// them back: offer a standard or die-cut size instead of the one we could not
// make, quote 1,000 instead of 100, or simply follow up. Each row opens the
// record; "Recover" moves the lead back to a live stage and hands it to an
// agent (/api/lost/recover — stage via applyStageChange, owner via
// setAssignment, plus a note on the timeline). The data is the board's own
// (lib/lost.ts builds on loadPipeline), so access rules are the board's too.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw, TriangleAlert, Lock, Undo2, ExternalLink, X } from 'lucide-react'
import { CRM_STAGE_LABEL } from '@/lib/crm'
import { LOST_REASONS, RECOVER_STAGES, lostReasonLabel } from '@/lib/lostreasons'
import { timeAgo, formatDateTime } from '@/lib/datetime'
import type { LostResult, LostRow } from '@/lib/lost'

const BTN = 'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40'
const SELECT = 'rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-800'

type Data = LostResult & { me: string; ownLeadsOnly: boolean; agents: { email: string; name: string; sites: string[] | null }[] }

const WINDOWS = [
  { days: 90, label: 'Leads from the last 90 days' },
  { days: 365, label: 'Leads from the last year' },
  { days: 3650, label: 'All time' },
] as const
const AGES = [
  { key: '', label: 'Lost any time' },
  { key: '7', label: 'Lost in the last 7 days' },
  { key: '30', label: 'Lost in the last 30 days' },
  { key: '90', label: 'Lost in the last 90 days' },
  { key: 'older', label: 'Lost over 90 days ago' },
] as const

const short = (e: string | null | undefined) => (e ? e.split('@')[0] : '')

export default function LostPage() {
  const router = useRouter()
  const [data, setData] = useState<Data | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error' | 'unavailable'>('loading')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [site, setSite] = useState('')
  const [owner, setOwner] = useState('')
  const [reason, setReason] = useState('')
  const [age, setAge] = useState('')
  const [days, setDays] = useState(365)
  // The dropdowns keep the options of the widest load, so narrowing by site
  // does not empty the owner list (and vice versa).
  const [opts, setOpts] = useState<Data['options'] | null>(null)
  const [recovering, setRecovering] = useState<string | null>(null)
  const [flash, setFlash] = useState('')

  useEffect(() => {
    try { document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark') } catch { /* private mode */ }
  }, [])

  const load = useCallback(async () => {
    const q = new URLSearchParams()
    if (site) q.set('site', site)
    if (owner) q.set('owner', owner)
    if (reason) q.set('reason', reason)
    if (age) q.set('age', age)
    q.set('days', String(days))
    const res = await fetch(`/api/lost?${q}`).catch(() => null)
    if (!res) { setError('Could not reach the server.'); setStatus('error'); return }
    if (res.status === 401) { window.location.href = '/login'; return }
    if (res.status === 403) { setStatus('unavailable'); return }
    if (!res.ok) { setError((await res.json().catch(() => ({}))).error || 'Could not load Lost leads.'); setStatus('error'); return }
    const d: Data = await res.json()
    setData(d)
    if (!site && !owner) setOpts(d.options)
    setStatus('ok'); setError('')
  }, [site, owner, reason, age, days])

  useEffect(() => {
    const t = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false) }
  const agentName = useCallback((e: string | null) => data?.agents.find((a) => a.email === (e ?? '').toLowerCase())?.name || short(e) || 'Unassigned', [data])

  const totalAll = useMemo(() => Object.values(data?.reasonCounts ?? {}).reduce((a, b) => a + b, 0), [data])

  if (status === 'unavailable') {
    return (
      <Shell>
        <div className="max-w-md mx-auto mt-16 bg-white border border-gray-200 rounded-2xl p-6 text-center">
          <Lock className="mx-auto w-6 h-6 text-gray-400" aria-hidden />
          <p className="mt-3 text-sm font-semibold text-gray-900">The Lost list is not part of this dashboard</p>
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
          <p className="mt-3 text-sm font-semibold text-gray-900">{error || 'Could not load Lost leads.'}</p>
          <button type="button" onClick={() => { setStatus('loading'); void load() }} className={`${BTN} mt-4 bg-gray-900 text-white hover:bg-gray-800`}>Try again</button>
        </div>
      </Shell>
    )
  }

  const subtitle = data
    ? `${data.total} lost lead${data.total === 1 ? '' : 's'}${data.ownLeadsOnly ? ' assigned to you' : ''} — offer a standard size, a better quantity, or just follow up`
    : 'Loading…'

  return (
    <Shell subtitle={subtitle} actions={
      <button type="button" onClick={refresh} disabled={refreshing} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden /> Refresh
      </button>
    }>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select aria-label="Site" className={SELECT} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>
          {(opts?.sites ?? []).map((s) => <option key={s.siteId} value={s.siteId}>{s.name}</option>)}
        </select>
        {!data?.ownLeadsOnly && (
          <select aria-label="Owner" className={SELECT} value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Everyone</option>
            <option value="__unassigned__">Unassigned</option>
            {(opts?.owners ?? []).map((o) => <option key={o} value={o}>{agentName(o)}</option>)}
          </select>
        )}
        <select aria-label="Lost when" className={SELECT} value={age} onChange={(e) => setAge(e.target.value)}>
          {AGES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        <select aria-label="Lead window" className={SELECT} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {WINDOWS.map((w) => <option key={w.days} value={w.days}>{w.label}</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Reason">
        <Chip on={reason === ''} onClick={() => setReason('')} label="Any reason" n={totalAll} />
        {LOST_REASONS.map((r) => <Chip key={r.key} on={reason === r.key} onClick={() => setReason(r.key)} label={r.label} n={data?.reasonCounts[r.key] ?? 0} />)}
        <Chip on={reason === 'none'} onClick={() => setReason('none')} label="No reason given" n={data?.reasonCounts.none ?? 0} />
      </div>

      {flash && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-green-300 bg-green-100 px-3 py-2 text-xs text-green-700">
          <span className="flex-1">{flash}</span>
          <button type="button" onClick={() => setFlash('')} aria-label="Dismiss"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {data?.truncated && (
        <p className="mb-3 text-xs text-amber-700">This window is larger than the board reads in one go, so some older leads may be missing — pick a shorter window.</p>
      )}

      {status === 'loading' || !data ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 rounded-xl bg-gray-200 animate-pulse" />)}</div>
      ) : data.rows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-8 text-center text-sm text-gray-600">No Lost leads match these filters.</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500 border-b border-gray-200">
                <th className="px-3 py-2 font-semibold">Lead</th>
                <th className="px-3 py-2 font-semibold">What they wanted</th>
                <th className="px-3 py-2 font-semibold">Why lost</th>
                <th className="px-3 py-2 font-semibold">Lost</th>
                <th className="px-3 py-2 font-semibold">Owner</th>
                <th className="px-3 py-2 font-semibold">Last contact</th>
                <th className="px-3 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <Row key={r.id} r={r} data={data} agentName={agentName}
                  open={recovering === r.id} onToggle={() => setRecovering(recovering === r.id ? null : r.id)}
                  onOpen={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); router.push(`/leads/${encodeURIComponent(r.id)}`) }}
                  onDone={(msg) => { setRecovering(null); setFlash(msg); void load() }} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  )
}

function Row({ r, data, agentName, open, onToggle, onOpen, onDone }: {
  r: LostRow
  data: Data
  agentName: (e: string | null) => string
  open: boolean
  onToggle: () => void
  onOpen: (e: React.MouseEvent) => void
  onDone: (msg: string) => void
}) {
  const wanted = [r.product, r.size, r.quantity && `qty ${r.quantity}`].filter(Boolean)
  const [settingReason, setSettingReason] = useState(false)
  const [pick, setPick] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function saveReason() {
    if (!pick) return
    setBusy(true); setErr('')
    const res = await fetch('/api/lost/reason', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: r.mergedIds, reason: pick, note }) }).catch(() => null)
    setBusy(false)
    const j = await res?.json().catch(() => ({}))
    if (!res?.ok) { setErr(j?.error || 'Not saved.'); return }
    setSettingReason(false)
    onDone(`Reason saved for ${r.name}.`)
  }

  return (
    <>
      <tr className="border-b border-gray-200 align-top">
        <td className="px-3 py-2.5 min-w-[160px]">
          <a href={`/leads/${encodeURIComponent(r.id)}`} onClick={onOpen} className="font-semibold text-gray-900 hover:underline">{r.name || 'Unnamed lead'}</a>
          <p className="text-[11px] text-gray-500">{r.siteName}{r.kind !== 'quote' ? ` · ${r.kind}` : ''}</p>
        </td>
        <td className="px-3 py-2.5 min-w-[160px] text-gray-700">
          {wanted.length ? wanted.map((w, i) => <p key={i} className="truncate max-w-[240px]" title={String(w)}>{w}</p>) : <span className="text-gray-400">Not stated</span>}
        </td>
        <td className="px-3 py-2.5 min-w-[150px]">
          {r.reason ? (
            <>
              <p className="text-gray-800">{lostReasonLabel(r.reason)}</p>
              {r.reasonNote && <p className="text-[11px] text-gray-500 max-w-[220px]">{r.reasonNote}</p>}
            </>
          ) : settingReason ? (
            <div className="space-y-1">
              <select aria-label="Reason" className={SELECT} value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Pick a reason…</option>
                {LOST_REASONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional), e.g. 14x14x12"
                className="block w-full rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800" />
              <div className="flex gap-1">
                <button type="button" disabled={!pick || busy} onClick={saveReason} className={`${BTN} bg-gray-900 text-white hover:bg-gray-800 px-2 py-1`}>Save</button>
                <button type="button" onClick={() => setSettingReason(false)} className={`${BTN} text-gray-600 px-2 py-1`}>Cancel</button>
              </div>
              {err && <p className="text-[11px] text-red-700">{err}</p>}
            </div>
          ) : (
            <button type="button" onClick={() => setSettingReason(true)} className="text-[11px] text-gray-500 underline decoration-dotted hover:text-gray-800">Add reason</button>
          )}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-gray-700" title={r.lostAt ? formatDateTime(r.lostAt) : 'Moved to Lost before stage history was kept'}>
          {r.lostAt ? timeAgo(r.lostAt) : '—'}
          {r.lostBy && <p className="text-[11px] text-gray-500">by {agentName(r.lostBy)}</p>}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-gray-700">{r.owner ? agentName(r.owner) : <span className="text-gray-400">Unassigned</span>}</td>
        <td className="px-3 py-2.5 whitespace-nowrap text-gray-700" title={r.lastContactAt ? formatDateTime(r.lastContactAt) : ''}>{r.lastContactAt ? timeAgo(r.lastContactAt) : <span className="text-gray-400">Never</span>}</td>
        <td className="px-3 py-2.5 text-right whitespace-nowrap">
          <a href={`/leads/${encodeURIComponent(r.id)}`} onClick={onOpen} className={`${BTN} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50`}>
            <ExternalLink className="w-3.5 h-3.5" aria-hidden /> Open
          </a>{' '}
          <button type="button" onClick={onToggle} aria-expanded={open} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>
            <Undo2 className="w-3.5 h-3.5" aria-hidden /> Recover
          </button>
        </td>
      </tr>
      {open && <RecoverPanel r={r} data={data} onDone={onDone} onCancel={onToggle} />}
    </>
  )
}

function RecoverPanel({ r, data, onDone, onCancel }: { r: LostRow; data: Data; onDone: (msg: string) => void; onCancel: () => void }) {
  // Agents who can work this lead's site. Default: the previous owner if they
  // still can, otherwise the person recovering it.
  const agents = data.agents.filter((a) => a.sites === null || a.sites.includes(r.siteId))
  const def = agents.find((a) => a.email === (r.owner ?? '').toLowerCase())?.email ?? agents.find((a) => a.email === data.me.toLowerCase())?.email ?? agents[0]?.email ?? ''
  const [stage, setStage] = useState<string>('follow_up')
  const [assignee, setAssignee] = useState(def)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function recover() {
    setBusy(true); setErr('')
    const res = await fetch('/api/lost/recover', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: r.mergedIds, stage, assignee }),
    }).catch(() => null)
    setBusy(false)
    const j = await res?.json().catch(() => ({}))
    if (!res?.ok && !j?.recovered?.length) { setErr(j?.error || j?.failed?.[0]?.why || j?.skipped?.[0]?.why || 'Could not recover it.'); return }
    if (!j.recovered?.length) { setErr(j?.skipped?.[0]?.why ? `Not moved: ${j.skipped[0].why}` : 'Nothing was moved.'); return }
    onDone(`${r.name} is back in ${CRM_STAGE_LABEL[stage as keyof typeof CRM_STAGE_LABEL]} with ${data.agents.find((a) => a.email === assignee)?.name ?? assignee}.`)
  }

  return (
    <tr className="border-b border-gray-200 bg-blue-100/40">
      <td colSpan={7} className="px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-gray-800">Recover {r.name}:</span>
          <label className="flex items-center gap-1 text-gray-600">move to
            <select className={SELECT} value={stage} onChange={(e) => setStage(e.target.value)}>
              {RECOVER_STAGES.map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-gray-600">and give it to
            <select className={SELECT} value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={data.ownLeadsOnly}>
              {agents.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || !assignee} onClick={recover} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700`}>{busy ? 'Recovering…' : 'Recover'}</button>
          <button type="button" onClick={onCancel} className={`${BTN} text-gray-600`}>Cancel</button>
          {err && <span className="text-red-700">{err}</span>}
        </div>
      </td>
    </tr>
  )
}

function Chip({ on, onClick, label, n }: { on: boolean; onClick: () => void; label: string; n: number }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${on ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'}`}>
      {label}<span className={`tabular-nums ${on ? 'text-white' : 'text-gray-500'}`}>{n}</span>
    </button>
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
            <h1 className="text-base font-bold text-gray-900 leading-tight">Lost inquiries</h1>
            {subtitle && <p className="text-[11px] text-gray-500 leading-tight">{subtitle}</p>}
          </div>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-3 sm:px-5 py-4">{children}</main>
    </div>
  )
}
