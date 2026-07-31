'use client'

// Pipeline — /pipeline. Kanban and list over one data source and one filter bar.
//
// Stage changes do NOT have their own endpoint: both the drag and the select
// call /api/leads/[id]/stage, the Phase 1 path, so the legacy lead_status
// dual-write and the server-side access check are shared rather than forked.
//
// Mode and filters persist in localStorage — the same mechanism the dashboard
// already uses for its theme and active tab. They are pure UI preference, so
// they do not belong in the database and no new control role was added.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, LayoutGrid, List as ListIcon, RefreshCw, TriangleAlert, Filter,
} from 'lucide-react'
import { CRM_STAGES, CRM_STAGE_LABEL, type CrmStage } from '@/lib/crm'
import {
  DATE_PRESETS, presetSince, type DatePresetKey,
  type PipelineCard, type PipelineColumn,
} from '@/lib/pipeline'
import Board from './Board'
import ListView from './ListView'

type Mode = 'board' | 'list'
const PREFS_KEY = 'zee-pipeline-prefs'

interface Prefs {
  mode: Mode
  site: string
  owner: string
  stage: CrmStage | 'all'
  range: DatePresetKey
}

const DEFAULT_PREFS: Prefs = { mode: 'board', site: '', owner: '', stage: 'all', range: '90d' }

const EMPTY_COLUMNS: PipelineColumn[] = CRM_STAGES.map((stage) => ({
  stage, count: 0, totals: [], unvalued: 0, cards: [], hasMore: false,
}))

export default function PipelinePage() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [prefsReady, setPrefsReady] = useState(false)
  const [columns, setColumns] = useState<PipelineColumn[]>(EMPTY_COLUMNS)
  const [options, setOptions] = useState<{ sites: { siteId: string; name: string }[]; owners: string[] }>({ sites: [], owners: [] })
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [movingId, setMovingId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState<CrmStage | null>(null)
  const [error, setError] = useState('')
  const [narrow, setNarrow] = useState(false)

  // Theme, same restore the record page does.
  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode */ }
  }, [])

  // Small screens force list: a drag-and-drop board is not a usable phone
  // interaction, so it is never rendered there rather than shipped broken.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  // Restore preferences before the first fetch, so the page never loads one
  // filter set and then immediately re-fetches with another.
  //
  // Deferred to a microtask rather than run in the effect body: localStorage
  // cannot be read during render (this component is server-rendered first, and
  // reading it there would desync hydration on the filter selects), and a
  // synchronous setState in an effect cascades an extra render before paint.
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(PREFS_KEY)
        if (raw) {
          const p = JSON.parse(raw)
          setPrefs({
            mode: p.mode === 'list' ? 'list' : 'board',
            site: typeof p.site === 'string' ? p.site : '',
            owner: typeof p.owner === 'string' ? p.owner : '',
            stage: CRM_STAGES.includes(p.stage) ? p.stage : 'all',
            range: DATE_PRESETS.some((d) => d.key === p.range) ? p.range : '90d',
          })
        }
      } catch { /* ignore malformed prefs */ }
      setPrefsReady(true)
    })
  }, [])

  useEffect(() => {
    if (!prefsReady) return
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* quota / private mode */ }
  }, [prefs, prefsReady])

  const query = useMemo(() => {
    const qs = new URLSearchParams({ from: presetSince(prefs.range) })
    if (prefs.site) qs.set('site', prefs.site)
    if (prefs.owner) qs.set('owner', prefs.owner)
    if (prefs.stage !== 'all') qs.set('stage', prefs.stage)
    return qs.toString()
  }, [prefs.site, prefs.owner, prefs.stage, prefs.range])

  const load = useCallback((): Promise<void> => {
    if (!prefsReady) return Promise.resolve()
    return fetch(`/api/pipeline?${query}`)
      .then(async (res) => {
        if (res.status === 401) { window.location.href = '/login'; return }
        if (!res.ok) { setStatus('error'); return }
        const d = await res.json()
        setColumns(d.columns ?? EMPTY_COLUMNS)
        setOptions(d.options ?? { sites: [], owners: [] })
        setTotal(d.total ?? 0)
        setTruncated(!!d.truncated)
        setStatus('ok')
      })
      .catch(() => setStatus('error'))
  }, [query, prefsReady])

  useEffect(() => { load() }, [load])

  const loadMore = useCallback(async (stage: CrmStage) => {
    const col = columns.find((c) => c.stage === stage)
    if (!col) return
    setLoadingMore(stage)
    try {
      const res = await fetch(`/api/pipeline?${query}&more=${stage}&offset=${col.cards.length}`)
      if (!res.ok) throw new Error('Could not load more')
      const d = await res.json()
      setColumns((cols) => cols.map((c) => (
        c.stage === stage
          // Dedupe on id: a card moved by someone else between pages must not
          // land twice.
          ? { ...c, cards: [...c.cards, ...(d.cards ?? []).filter((n: PipelineCard) => !c.cards.some((e) => e.id === n.id))], hasMore: !!d.hasMore }
          : c
      )))
    } catch {
      setError('Could not load more leads in that column.')
    } finally {
      setLoadingMore(null)
    }
  }, [columns, query])

  // ── Optimistic move ───────────────────────────────────────────────────────
  // The card is removed from its old column and inserted into the new one in a
  // SINGLE state update, so it can never be painted in two columns at once. On
  // failure the whole previous column set is restored.
  const snapshot = useRef<PipelineColumn[] | null>(null)

  const move = useCallback(async (card: PipelineCard, to: CrmStage) => {
    if (card.stage === to || movingId) return
    const from = card.stage
    setError('')
    setMovingId(card.id)
    snapshot.current = columns

    setColumns((cols) => cols.map((c) => {
      if (c.stage === from) {
        const wasLoaded = c.cards.some((x) => x.id === card.id)
        return {
          ...c,
          cards: c.cards.filter((x) => x.id !== card.id),
          count: Math.max(0, c.count - 1),
          totals: adjustTotals(c.totals, card, -1),
          unvalued: card.value === null && wasLoaded ? Math.max(0, c.unvalued - 1) : c.unvalued,
        }
      }
      if (c.stage === to) {
        return {
          ...c,
          cards: [{ ...card, stage: to }, ...c.cards],
          count: c.count + 1,
          totals: adjustTotals(c.totals, card, 1),
          unvalued: card.value === null ? c.unvalued + 1 : c.unvalued,
        }
      }
      return c
    }))

    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(card.id)}/stage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: to, previous: from }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(res.status === 403
          ? 'You don’t have access to that lead’s site.'
          : body.error || 'Could not move that lead')
      }
      // Re-fetch so the totals are the server's, not the optimistic arithmetic.
      await load()
    } catch (err) {
      if (snapshot.current) setColumns(snapshot.current)
      setError(err instanceof Error ? err.message : 'Could not move that lead — it was put back.')
    } finally {
      setMovingId(null)
      snapshot.current = null
    }
  }, [columns, movingId, load])

  const allCards = useMemo(() => columns.flatMap((c) => c.cards), [columns])
  const mode: Mode = narrow ? 'list' : prefs.mode
  const shownColumns = useMemo(
    () => (prefs.stage === 'all' ? columns : columns.filter((c) => c.stage === prefs.stage)),
    [columns, prefs.stage],
  )

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1600px] mx-auto px-3 sm:px-5 py-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <Link href="/" title="Back to the dashboard" aria-label="Back to the dashboard"
              className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            </Link>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-gray-900 leading-tight">Pipeline</h1>
              <p className="text-[11px] text-gray-500 leading-tight tabular-nums">
                {status === 'loading' ? 'Loading…' : `${total} lead${total === 1 ? '' : 's'} matching`}
              </p>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => load()} title="Refresh" aria-label="Refresh"
                className="p-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <RefreshCw size={13} strokeWidth={2} aria-hidden />
              </button>
              {/* Mode toggle is hidden on phones, where list is the only mode. */}
              {!narrow && (
                <div className="flex gap-0.5 bg-gray-100 p-0.5 rounded-lg border border-gray-200" role="tablist" aria-label="View mode">
                  {([['board', LayoutGrid, 'Board'], ['list', ListIcon, 'List']] as const).map(([m, Icon, label]) => (
                    <button key={m} role="tab" aria-selected={prefs.mode === m}
                      onClick={() => setPrefs((p) => ({ ...p, mode: m }))}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                        prefs.mode === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}>
                      <Icon size={12} strokeWidth={2} aria-hidden />{label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Filters, shared by both modes ── */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            <Filter size={12} strokeWidth={2} className="text-gray-400 shrink-0" aria-hidden />
            <Select label="Site" value={prefs.site} onChange={(v) => setPrefs((p) => ({ ...p, site: v }))}
              options={[{ value: '', label: 'All sites' }, ...options.sites.map((s) => ({ value: s.siteId, label: s.name }))]} />
            <Select label="Owner" value={prefs.owner} onChange={(v) => setPrefs((p) => ({ ...p, owner: v }))}
              options={[
                { value: '', label: 'Anyone' },
                { value: '__unassigned__', label: 'Unassigned' },
                ...options.owners.map((o) => ({ value: o, label: o.split('@')[0] })),
              ]} />
            <Select label="Stage" value={prefs.stage} onChange={(v) => setPrefs((p) => ({ ...p, stage: v as CrmStage | 'all' }))}
              options={[{ value: 'all', label: 'All stages' }, ...CRM_STAGES.map((s) => ({ value: s, label: CRM_STAGE_LABEL[s] }))]} />
            <Select label="Created" value={prefs.range} onChange={(v) => setPrefs((p) => ({ ...p, range: v as DatePresetKey }))}
              options={DATE_PRESETS.map((d) => ({ value: d.key, label: d.label }))} />
            {(prefs.site || prefs.owner || prefs.stage !== 'all' || prefs.range !== '90d') && (
              <button onClick={() => setPrefs((p) => ({ ...DEFAULT_PREFS, mode: p.mode }))}
                className="text-[11px] text-gray-500 hover:text-gray-900 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                Reset
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-3 sm:px-5 py-3 space-y-2 animate-in">
        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
            <TriangleAlert size={12} strokeWidth={2} aria-hidden />{error}
          </p>
        )}
        {truncated && (
          <p className="flex items-center gap-1.5 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
            <TriangleAlert size={12} strokeWidth={2} aria-hidden />
            This range holds more leads than the page will scan. Totals cover what was scanned — narrow the date range for exact figures.
          </p>
        )}
        {status === 'error' ? (
          <section className="bg-white border border-gray-200 rounded-xl shadow-sm px-4 py-6 text-center">
            <p className="text-sm font-semibold text-gray-800">Could not load the pipeline</p>
            <p className="text-xs text-gray-500 mt-0.5">Something went wrong on our side. Try again in a moment.</p>
          </section>
        ) : mode === 'board' ? (
          <Board columns={shownColumns} loading={status === 'loading'} movingId={movingId}
            loadingMore={loadingMore} onMove={move} onLoadMore={loadMore} />
        ) : (
          <ListView cards={allCards} movingId={movingId} onMove={move} loading={status === 'loading'} />
        )}
      </main>
    </div>
  )
}

// Optimistic per-currency arithmetic for a single card moving between columns.
// Mirrors the server rule exactly: subtotals are per currency and never merged.
function adjustTotals(
  totals: PipelineColumn['totals'],
  card: PipelineCard,
  sign: 1 | -1,
): PipelineColumn['totals'] {
  if (card.value === null) return totals
  const next = totals.map((t) => ({ ...t }))
  const hit = next.find((t) => t.currency === card.currency)
  if (hit) {
    hit.total += card.value * sign
    hit.leads += sign
    return next.filter((t) => t.leads > 0)
  }
  // Same ordering rule as the server: by lead count, never by amount.
  return sign === 1
    ? [...next, { currency: card.currency, total: card.value, leads: 1 }]
        .sort((a, b) => b.leads - a.leads || a.currency.localeCompare(b.currency))
    : next
}

function Select({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="bg-gray-100 border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500">
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-white text-gray-800">{o.label}</option>
        ))}
      </select>
    </label>
  )
}
