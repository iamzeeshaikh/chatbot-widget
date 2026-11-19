'use client'

// ZeeDesk pipeline: every lead by stage, as a board of columns or as a list.
//
// It talks to the same three endpoints as the other dashboard's pipeline and
// follows the same rules, because the rules live on the server:
//   GET  /api/pipeline              columns, counts, per-currency totals, filter options
//   POST /api/leads/[id]/stage      the one way a single lead changes stage
//   POST /api/pipeline/bulk         stage / owner / task for a selection, with undo
//   GET  /api/crm/version           "has anything changed?" for the quiet refresh
//
// A card can stand for several records of one customer (mergedIds). Moving the
// card moves all of them. Currencies are never added together.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, ChevronsUpDown, GripVertical, Inbox, KanbanSquare,
  List as ListIcon, ListTodo, Loader2, RefreshCw, Search, Undo2, X,
} from 'lucide-react'
import { CRM_STAGES, CRM_STAGE_LABEL, formatMoney, type CrmStage } from '@/lib/crm'
import { DATE_PRESETS, presetSince, type DatePresetKey, type CurrencyTotal, type PipelineCard, type PipelineColumn } from '@/lib/pipeline'
import { LOST_REASONS, MAX_LOST_NOTE, type LostReason } from '@/lib/lostreasons'
import { TASK_TYPES, TASK_TYPE_LABEL, DEFAULT_DUE_TIME, defaultDueDate, type TaskType } from '@/lib/tasks'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import {
  Avatar, Chip, Empty, Notice, PageHead, postJson, short,
  BTN_PLAIN, BTN_PRIMARY, BTN_DANGER, INPUT, LABEL,
  type ZdScreenProps,
} from '../ui'

type Mode = 'board' | 'list'
type Status = 'loading' | 'ok' | 'error' | 'unavailable'
type LostInput = { reason: LostReason; note: string }

interface Prefs { mode: Mode; site: string; owner: string; stage: CrmStage | 'all'; range: DatePresetKey }
const PREFS_KEY = 'zd-pipeline-prefs'
const DEFAULT_PREFS: Prefs = { mode: 'board', site: '', owner: '', stage: 'all', range: '90d' }
const UNASSIGNED = '__unassigned__'

interface BulkResult {
  applied: number
  skipped: { id: string; reason: string }[]
  failed: { id: string; error: string }[]
  note: string
  undo?: { action: string; entries: unknown[] }
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>()
const EMPTY_COLUMNS: PipelineColumn[] = CRM_STAGES.map((stage) => ({ stage, count: 0, totals: [], unvalued: 0, cards: [], hasMore: false }))

// The rule along the top of each column. Chosen to sit with the ZeeDesk palette.
const STAGE_RULE: Record<CrmStage, string> = {
  new: '#1f73b7',
  contacted: '#337fbd',
  quote_sent: '#6a27b8',
  follow_up: '#ad5918',
  pending_design: '#e34f32',
  on_hold: '#68737d',
  won: '#038153',
  contact_not_successful: '#87929d',
  no_response: '#c79a00',
  not_interested: '#d93f4c',
  duplicate: '#87929d',
  manufacturer: '#49545c',
  lost: '#cc3340',
}

const KIND_LABEL: Record<string, string> = {
  chat: 'Chat', quote: 'Quote request', checkout: 'Checkout', call: 'Call', whatsapp: 'WhatsApp', reorder: 'Reorder',
}

const SELECT = 'h-8 max-w-[160px] pl-2 pr-6 rounded-md border text-[13px] outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 disabled:opacity-40'
const selectCls = (active: boolean) => `${SELECT} ${active ? 'border-[#1f73b7] bg-[#edf7ff] text-[#144a75] font-medium' : 'border-[#d8dcde] bg-white text-[#2f3941]'}`
const plural = (n: number, one = 'lead', many = 'leads') => `${n} ${n === 1 ? one : many}`

// Narrow screens get the list: dragging cards is not a usable phone gesture.
const NARROW_QUERY = '(max-width: 767px)'
function subscribeNarrow(cb: () => void) {
  const mq = window.matchMedia(NARROW_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW_QUERY).matches, () => false)

/** Polls the CRM change marker and calls `onChange` when someone else has
 *  changed a lead. While `paused`, a change is remembered and delivered later. */
function useCrmChanges(paused: boolean, onChange: () => void) {
  const seen = useRef<string | null>(null)
  const waiting = useRef(false)
  const pausedRef = useRef(paused)
  const cb = useRef(onChange)
  useEffect(() => { cb.current = onChange }, [onChange])
  useEffect(() => {
    pausedRef.current = paused
    if (!paused && waiting.current) { waiting.current = false; cb.current() }
  }, [paused])
  useEffect(() => {
    let alive = true
    const check = async () => {
      if (!alive || document.hidden) return
      try {
        const res = await fetch('/api/crm/version')
        if (!res.ok || !alive) return
        const v: string | null = (await res.json()).crm ?? null
        if (v === null) return
        if (seen.current === null) { seen.current = v; return }
        if (v === seen.current) return
        seen.current = v
        if (pausedRef.current) waiting.current = true
        else cb.current()
      } catch { /* a missed poll is harmless; the next one catches up */ }
    }
    const timer = setInterval(check, 45_000)
    const onVisible = () => { if (!document.hidden) check() }
    check()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
    }
  }, [])
}

// Per-currency arithmetic for one card changing column, mirroring the server:
// subtotals are per currency, ordered by how many leads carry that currency.
function adjustTotals(totals: CurrencyTotal[], card: PipelineCard, sign: 1 | -1): CurrencyTotal[] {
  if (card.value === null) return totals
  const next = totals.map((t) => ({ ...t }))
  const hit = next.find((t) => t.currency === card.currency)
  if (hit) {
    hit.total += card.value * sign
    hit.leads += sign
    return next.filter((t) => t.leads > 0)
  }
  return sign === 1
    ? [...next, { currency: card.currency, total: card.value, leads: 1 }].sort((a, b) => b.leads - a.leads || a.currency.localeCompare(b.currency))
    : next
}

export default function Pipeline({ me, openLead }: ZdScreenProps) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [prefsReady, setPrefsReady] = useState(false)
  const [columns, setColumns] = useState<PipelineColumn[]>(EMPTY_COLUMNS)
  const [stages, setStages] = useState<readonly CrmStage[]>(CRM_STAGES)
  const [options, setOptions] = useState<{ sites: { siteId: string; name: string }[]; owners: string[] }>({ sites: [], owners: [] })
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [excluded, setExcluded] = useState(0)
  const [status, setStatus] = useState<Status>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [lostRequired, setLostRequired] = useState(false)
  const [lostPending, setLostPending] = useState<PipelineCard | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState<CrmStage | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const narrow = useNarrow()

  // Saved view and filters, restored before the first request so the screen
  // never loads one filter set and immediately asks again with another.
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
      } catch { /* unreadable preferences: start from the defaults */ }
      setPrefsReady(true)
    })
  }, [])

  useEffect(() => {
    if (!prefsReady) return
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* storage unavailable */ }
  }, [prefs, prefsReady])

  const query = useMemo(() => {
    const qs = new URLSearchParams({ from: presetSince(prefs.range) })
    if (prefs.site) qs.set('site', prefs.site)
    if (prefs.owner) qs.set('owner', prefs.owner)
    if (prefs.stage !== 'all') qs.set('stage', prefs.stage)
    return qs.toString()
  }, [prefs.site, prefs.owner, prefs.stage, prefs.range])

  // Only the newest request may write its answer, so a slow reply for an old
  // filter set cannot overwrite the current one.
  const loadSeq = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    if (!prefsReady) return
    const seq = ++loadSeq.current
    try {
      const res = await fetch(`/api/pipeline?${query}`)
      if (seq !== loadSeq.current) return
      if (res.status === 401) { window.location.href = '/login'; return }
      if (res.status === 403) { setStatus('unavailable'); return }
      if (!res.ok) { setStatus('error'); return }
      const d = await res.json()
      if (seq !== loadSeq.current) return
      setColumns(Array.isArray(d.columns) ? d.columns : EMPTY_COLUMNS)
      if (Array.isArray(d.stages) && d.stages.length) setStages(d.stages)
      setLostRequired(!!d.lostReasonRequired)
      setOptions(d.options ?? { sites: [], owners: [] })
      setTotal(Number(d.total) || 0)
      setTruncated(!!d.truncated)
      setExcluded(Number(d.excluded) || 0)
      setStatus('ok')
    } catch {
      if (seq === loadSeq.current) setStatus('error')
    }
  }, [query, prefsReady])

  // Deferred a tick: the request itself is what sets state, never the effect body.
  useEffect(() => { queueMicrotask(() => { load() }) }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError('')
    await load()
    setRefreshing(false)
  }, [load])

  const loadMore = useCallback(async (stage: CrmStage) => {
    const col = columns.find((c) => c.stage === stage)
    if (!col) return
    setLoadingMore(stage)
    try {
      const res = await fetch(`/api/pipeline?${query}&more=${stage}&offset=${col.cards.length}`)
      if (!res.ok) throw new Error('load more failed')
      const d = await res.json()
      const fresh: PipelineCard[] = Array.isArray(d.cards) ? d.cards : []
      setColumns((cols) => cols.map((c) => (c.stage === stage
        // A card someone moved between pages must not appear twice.
        ? { ...c, cards: [...c.cards, ...fresh.filter((n) => !c.cards.some((e) => e.id === n.id))], hasMore: !!d.hasMore }
        : c)))
    } catch {
      setError(`Could not load more leads in ${CRM_STAGE_LABEL[stage]}. Try again.`)
    } finally {
      setLoadingMore(null)
    }
  }, [columns, query])

  // ── Moving one lead ────────────────────────────────────────────────────────
  // The card leaves its old column and enters the new one in a single update.
  // If the server refuses, the columns go back to exactly what they were.
  const move = useCallback(async (card: PipelineCard, to: CrmStage, lost?: LostInput) => {
    if (card.stage === to || movingId) return
    if (to === 'lost' && lostRequired && !lost) { setLostPending(card); return }
    const from = card.stage
    const before = columns
    setError('')
    setMovingId(card.id)
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

    let written = 0
    try {
      const ids = card.mergedIds?.length ? card.mergedIds : [card.id]
      let reasonFailed = ''
      // One at a time: each call writes two rows for the same customer.
      for (const id of ids) {
        const res = await fetch(`/api/leads/${encodeURIComponent(id)}/stage`, postJson({
          stage: to, previous: from, ...(lost ? { lostReason: lost.reason, lostNote: lost.note } : {}),
        }))
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(res.status === 403
            ? 'You do not have access to that lead’s site, so it was put back.'
            : `${body.error || 'Could not move that lead'}. It was put back.`)
        }
        written += 1
        if (body.reasonFailed) reasonFailed = String(body.reasonFailed)
      }
      await load()
      if (reasonFailed) setError(`The lead was moved to Lost, but the reason could not be saved: ${reasonFailed}`)
    } catch (err) {
      setColumns(before)
      setError(err instanceof Error ? err.message : 'Could not move that lead. It was put back.')
      // Some of a merged customer's records may already have moved; ask the
      // server for the truth rather than trusting the restored copy.
      if (written > 0) await load()
    } finally {
      setMovingId(null)
    }
  }, [columns, movingId, load, lostRequired])

  // ── What is on screen ──────────────────────────────────────────────────────
  const needle = search.trim().toLowerCase()
  const matches = useCallback((c: PipelineCard) => !needle
    || [c.name, c.email ?? '', c.siteName, c.owner ?? ''].some((v) => v.toLowerCase().includes(needle)), [needle])

  const shownColumns = useMemo(() => {
    const base = prefs.stage === 'all' ? columns : columns.filter((c) => c.stage === prefs.stage)
    return base.filter((c) => stages.includes(c.stage) || c.count > 0)
  }, [columns, prefs.stage, stages])
  const allCards = useMemo(() => columns.flatMap((c) => c.cards), [columns])
  const visibleCards = useMemo(() => allCards.filter(matches), [allCards, matches])

  // ── Selection for bulk changes (list view) ─────────────────────────────────
  // A selection belongs to the filters it was made under; when they change it
  // is treated as empty rather than silently pointing at different leads.
  const [rawSelected, setSelected] = useState<Set<string>>(new Set())
  const [allMatching, setAllMatching] = useState(false)
  const [selectionQuery, setSelectionQuery] = useState('')
  const selectionValid = selectionQuery === query
  const selected = selectionValid ? rawSelected : EMPTY_SELECTION
  const [selectingAll, setSelectingAll] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null)

  const clearSelection = useCallback(() => { setSelected(new Set()); setAllMatching(false) }, [])

  const toggleMany = useCallback((ids: string[], on: boolean) => {
    setAllMatching(false)
    setSelectionQuery(query)
    setSelected((prev) => {
      const next = new Set(selectionValid ? prev : [])
      for (const id of ids) { if (on) next.add(id); else next.delete(id) }
      return next
    })
  }, [query, selectionValid])

  const selectAllMatching = useCallback(async () => {
    setSelectingAll(true)
    setError('')
    try {
      const res = await fetch(`/api/pipeline?${query}&ids=1`)
      if (!res.ok) throw new Error('select all failed')
      const d = await res.json()
      setSelected(new Set<string>(Array.isArray(d.ids) ? d.ids : []))
      setSelectionQuery(query)
      setAllMatching(true)
    } catch {
      setError('Could not select every matching lead. Try again.')
    } finally {
      setSelectingAll(false)
    }
  }, [query])

  const postBulk = useCallback(async (body: unknown, fallback: string): Promise<BulkResult | null> => {
    setBulkBusy(true)
    setError('')
    try {
      const res = await fetch('/api/pipeline/bulk', postJson(body))
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || fallback)
      await load()
      return { applied: Number(d.applied) || 0, skipped: d.skipped ?? [], failed: d.failed ?? [], note: d.note ?? '', undo: d.undo }
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback)
      return null
    } finally {
      setBulkBusy(false)
    }
  }, [load])

  const runBulk = useCallback(async (body: Record<string, unknown>) => {
    // A selected card can stand for several records of one customer; send them
    // all, or the ones not on screen would be left behind.
    const byId = new Map(allCards.map((c) => [c.id, c]))
    const ids = Array.from(new Set(Array.from(selected).flatMap((id) => byId.get(id)?.mergedIds ?? [id])))
    const result = await postBulk({ ...body, ids }, 'The bulk update failed. Nothing was changed.')
    if (result) { setBulkResult(result); clearSelection() }
  }, [allCards, selected, postBulk, clearSelection])

  // Undo writes the previous values back; it does not erase the history.
  const undoBulk = useCallback(async () => {
    if (!bulkResult?.undo) return
    const result = await postBulk(bulkResult.undo, 'Could not undo that change.')
    if (result) setBulkResult(null)
  }, [bulkResult, postBulk])

  useCrmChanges(bulkBusy || selected.size > 0 || !!bulkResult || !!lostPending || !!movingId, load)

  const mode: Mode = narrow ? 'list' : prefs.mode
  const filtersOn = !!prefs.site || !!prefs.owner || prefs.stage !== 'all' || prefs.range !== DEFAULT_PREFS.range
  const sub = status === 'loading' ? 'Loading leads…'
    : status !== 'ok' ? 'Leads by stage'
    : `${plural(total)} in view${excluded > 0 ? ` · ${excluded} marked not a lead and left out` : ''}`

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-white text-[13px] text-[#2f3941]">
      <PageHead title="Pipeline" sub={sub} actions={<>
        <label className="relative">
          <span className="sr-only">Find a lead among the ones loaded</span>
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#87929d]" aria-hidden />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Find in loaded leads" title="Searches the leads already loaded on this screen, by name, email, site or owner"
            className={`${INPUT} !h-8 !w-[190px] pl-7`} />
        </label>
        <select aria-label="Site" value={prefs.site} onChange={(e) => setPrefs((p) => ({ ...p, site: e.target.value }))} className={selectCls(!!prefs.site)}>
          <option value="">All sites</option>
          {options.sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.name}</option>)}
        </select>
        <select aria-label="Owner" value={prefs.owner} onChange={(e) => setPrefs((p) => ({ ...p, owner: e.target.value }))} className={selectCls(!!prefs.owner)}>
          <option value="">Any owner</option>
          <option value={UNASSIGNED}>Unassigned</option>
          {options.owners.map((o) => <option key={o} value={o}>{short(o)}</option>)}
        </select>
        <select aria-label="Stage" value={prefs.stage} onChange={(e) => setPrefs((p) => ({ ...p, stage: e.target.value as CrmStage | 'all' }))} className={selectCls(prefs.stage !== 'all')}>
          <option value="all">All stages</option>
          {stages.map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}
        </select>
        <select aria-label="Created" value={prefs.range} onChange={(e) => setPrefs((p) => ({ ...p, range: e.target.value as DatePresetKey }))} className={selectCls(prefs.range !== DEFAULT_PREFS.range)}>
          {DATE_PRESETS.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        {(filtersOn || !!search) && (
          <button type="button" className={BTN_PLAIN} onClick={() => { setSearch(''); setPrefs((p) => ({ ...DEFAULT_PREFS, mode: p.mode })) }}>
            <X size={14} aria-hidden />Clear filters
          </button>
        )}
        <button type="button" className={BTN_PLAIN} onClick={refresh} disabled={refreshing} aria-label="Refresh" title="Refresh">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden />
        </button>
        {!narrow && (
          <div className="inline-flex rounded-md border border-[#d8dcde] overflow-hidden" role="group" aria-label="View">
            {([['board', KanbanSquare, 'Board'], ['list', ListIcon, 'List']] as const).map(([m, Icon, label]) => (
              <button key={m} type="button" aria-pressed={prefs.mode === m} onClick={() => setPrefs((p) => ({ ...p, mode: m }))}
                className={`h-8 px-2.5 inline-flex items-center gap-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#1f73b7]/40 ${prefs.mode === m ? 'bg-[#edf7ff] text-[#144a75] font-medium' : 'bg-white text-[#49545c] hover:bg-[#f8f9f9]'}`}>
                <Icon size={14} aria-hidden />{label}
              </button>
            ))}
          </div>
        )}
      </>} />

      {(error || truncated) && (
        <div className="px-6 pb-3 space-y-1.5">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-[#f5b5ba] bg-[#fff0f1] px-3 py-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[#cc3340]" aria-hidden />
              <div className="flex-1 min-w-0"><Notice text={error} bad /></div>
              <button type="button" onClick={() => setError('')} aria-label="Dismiss this message" className="shrink-0 text-[#cc3340] hover:text-[#8c232c]"><X size={14} aria-hidden /></button>
            </div>
          )}
          {truncated && (
            <p className="flex items-start gap-2 rounded-md border border-[#fcdba9] bg-[#fff3e4] px-3 py-2 text-[12px] text-[#ad5918]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
              This date range holds more leads than one scan covers, so the counts and totals are partial. Choose a shorter range for exact figures.
            </p>
          )}
        </div>
      )}

      {status === 'unavailable' ? (
        <div className="px-6"><Empty text="The pipeline is not turned on for this workspace." /></div>
      ) : status === 'error' ? (
        <div className="px-6 space-y-3">
          <Empty text="The pipeline could not be loaded. Check your connection and try again." />
          <button type="button" className={BTN_PRIMARY} onClick={refresh} disabled={refreshing}><RefreshCw size={14} aria-hidden />Try again</button>
        </div>
      ) : mode === 'board' ? (
        <Board columns={shownColumns} stages={stages} loading={status === 'loading'} movingId={movingId} loadingMore={loadingMore}
          matches={matches} searching={!!needle} onMove={move} onLoadMore={loadMore} openLead={openLead} />
      ) : (
        <ListView cards={visibleCards} columns={shownColumns} stages={stages} loading={status === 'loading'} movingId={movingId} loadingMore={loadingMore}
          searching={!!needle} loadedCount={allCards.length} totalMatching={total}
          selected={selected} allMatching={allMatching} selectingAll={selectingAll}
          onToggle={toggleMany} onSelectAllMatching={selectAllMatching} onClearSelection={clearSelection}
          onMove={move} onLoadMore={loadMore} openLead={openLead} />
      )}

      {mode === 'list' && (
        <BulkPanel count={selected.size} allMatching={allMatching} stages={stages} lostRequired={lostRequired}
          owners={options.owners} me={me.email} busy={bulkBusy} result={bulkResult}
          onApply={runBulk} onUndo={undoBulk} onClear={clearSelection} onDismiss={() => setBulkResult(null)} />
      )}

      {lostPending && (
        <LostDialog subject={lostPending.name || 'this lead'} records={lostPending.mergedCount}
          onCancel={() => setLostPending(null)}
          onConfirm={(reason, note) => { const c = lostPending; setLostPending(null); move(c, 'lost', { reason, note }) }} />
      )}
    </main>
  )
}

// ── Board ────────────────────────────────────────────────────────────────────

interface BoardProps {
  columns: PipelineColumn[]
  stages: readonly CrmStage[]
  loading: boolean
  movingId: string | null
  loadingMore: CrmStage | null
  matches: (c: PipelineCard) => boolean
  searching: boolean
  onMove: (card: PipelineCard, to: CrmStage) => void
  onLoadMore: (stage: CrmStage) => void
  openLead: (recordId: string) => void
}

function Board(props: BoardProps) {
  const [dragging, setDragging] = useState<PipelineCard | null>(null)
  const [over, setOver] = useState<CrmStage | null>(null)
  return (
    <div className="relative flex-1 min-h-0 overflow-x-auto overflow-y-hidden border-t border-[#d8dcde] bg-[#f8f9f9] [scrollbar-width:thin]">
      <div className="flex h-full gap-3 px-6 py-4 w-max min-w-full">
        {props.columns.map((col) => (
          <BoardColumn key={col.stage} {...props} col={col} dragging={dragging} setDragging={setDragging}
            isOver={over === col.stage && !!dragging && dragging.stage !== col.stage} setOver={setOver} />
        ))}
      </div>
    </div>
  )
}

function ColumnMoney({ totals }: { totals: CurrencyTotal[] }) {
  if (totals.length === 0) return null
  const [first, ...rest] = totals
  const lines = totals.map((t) => `${formatMoney(t.total, t.currency)} across ${plural(t.leads)}`)
  return (
    <span className="text-[12px] font-semibold tabular-nums text-[#2f3941]" title={lines.join('\n')} aria-label={`Column value: ${lines.join('; ')}`}>
      {formatMoney(first.total, first.currency)}
      {rest.length > 0 && <span className="ml-1 font-normal text-[#68737d]">+{rest.length} more {rest.length === 1 ? 'currency' : 'currencies'}</span>}
    </span>
  )
}

function BoardColumn({
  col, stages, loading, movingId, loadingMore, matches, searching, onMove, onLoadMore, openLead, dragging, setDragging, isOver, setOver,
}: BoardProps & {
  col: PipelineColumn
  dragging: PipelineCard | null
  setDragging: (c: PipelineCard | null) => void
  isOver: boolean
  setOver: (s: CrmStage | null) => void
}) {
  const busy = loadingMore === col.stage
  const label = CRM_STAGE_LABEL[col.stage]
  const cards = searching ? col.cards.filter(matches) : col.cards

  // Scrolling near the bottom brings in the next page, once per page.
  const asked = useRef(0)
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!col.hasMore || busy) return
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
    if (asked.current === col.cards.length) return
    asked.current = col.cards.length
    onLoadMore(col.stage)
  }

  return (
    <section aria-label={`${label}, ${plural(col.count)}`}
      onDragOver={(e) => { if (dragging) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(col.stage) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null) }}
      onDrop={(e) => {
        e.preventDefault()
        setOver(null)
        if (dragging && dragging.stage !== col.stage) onMove(dragging, col.stage)
        setDragging(null)
      }}
      className={`w-[272px] shrink-0 flex flex-col min-h-0 rounded-md border bg-white ${isOver ? 'border-[#1f73b7] ring-2 ring-[#1f73b7]/25' : 'border-[#d8dcde]'}`}>
      <div className="h-[3px] rounded-t-md" style={{ backgroundColor: STAGE_RULE[col.stage] }} aria-hidden />
      <header className="shrink-0 px-3 pt-2 pb-2 border-b border-[#e9ebed]">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[13px] font-semibold truncate">{label}</h2>
          <span className="rounded-full bg-[#e9ebed] px-1.5 text-[11px] font-semibold tabular-nums text-[#49545c]">{col.count}</span>
          <span className="ml-auto"><ColumnMoney totals={col.totals} /></span>
        </div>
        {(searching || (col.count > col.cards.length && col.cards.length > 0)) && (
          <p className="mt-0.5 text-[11px] text-[#68737d] tabular-nums">
            {searching ? `${cards.length} of ${col.cards.length} loaded match your search` : `Showing ${col.cards.length} of ${col.count}`}
          </p>
        )}
      </header>

      <div onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-2 space-y-2 [scrollbar-width:thin]">
        {loading ? (
          <div aria-busy="true" aria-label={`Loading ${label}`} className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-[76px] rounded-md bg-[#e9ebed] animate-pulse" />)}
          </div>
        ) : cards.length === 0 ? (
          <div className={`h-full min-h-[96px] rounded-md border border-dashed flex items-center justify-center px-3 text-center text-[12px] ${isOver ? 'border-[#1f73b7] bg-[#edf7ff] text-[#144a75]' : 'border-[#d8dcde] text-[#87929d]'}`}>
            {isOver ? `Drop to move to ${label}` : searching && col.cards.length > 0 ? 'No loaded lead here matches your search' : 'No leads in this stage'}
          </div>
        ) : cards.map((card) => (
          <BoardCard key={card.id} card={card} stages={stages} moving={movingId === card.id} locked={!!movingId}
            onDragStart={() => setDragging(card)} onDragEnd={() => { setDragging(null); setOver(null) }}
            onMove={onMove} openLead={openLead} />
        ))}
        {!loading && busy && (
          <p role="status" className="flex items-center justify-center gap-1.5 py-2 text-[12px] text-[#68737d]"><Loader2 size={13} className="animate-spin" aria-hidden />Loading more…</p>
        )}
        {!loading && !busy && col.hasMore && (
          <button type="button" onClick={() => onLoadMore(col.stage)} className={`${BTN_PLAIN} w-full justify-center`}>
            Load more ({col.count - col.cards.length} left)
          </button>
        )}
      </div>
    </section>
  )
}

function CardBadges({ card }: { card: PipelineCard }) {
  return (
    <>
      {card.unreadReplies > 0 && (
        <span title={`${plural(card.unreadReplies, 'unread email reply', 'unread email replies')} from the customer`}
          className="inline-flex items-center gap-1 rounded bg-[#1f73b7] px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
          <Inbox size={11} aria-hidden />{card.unreadReplies}<span className="sr-only"> unread email {card.unreadReplies === 1 ? 'reply' : 'replies'}</span>
        </span>
      )}
      {card.openTasks > 0 && (
        <span title={card.overdueTasks > 0 ? `${card.overdueTasks} overdue of ${plural(card.openTasks, 'open task', 'open tasks')}` : plural(card.openTasks, 'open task', 'open tasks')}
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${card.overdueTasks > 0 ? 'bg-[#fff0f1] text-[#cc3340]' : 'bg-[#e9ebed] text-[#49545c]'}`}>
          {card.overdueTasks > 0 ? <AlertTriangle size={11} aria-hidden /> : <ListTodo size={11} aria-hidden />}{card.openTasks}
          <span className="sr-only"> open {card.openTasks === 1 ? 'task' : 'tasks'}{card.overdueTasks > 0 ? `, ${card.overdueTasks} overdue` : ''}</span>
        </span>
      )}
    </>
  )
}

/** The stages a card can move to: every stage but the one it is in. */
function MoveOptions({ card, stages }: { card: PipelineCard; stages: readonly CrmStage[] }) {
  return <>{stages.filter((s) => s !== card.stage).map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}</>
}

function BoardCard({ card, stages, moving, locked, onDragStart, onDragEnd, onMove, openLead }: {
  card: PipelineCard
  stages: readonly CrmStage[]
  moving: boolean
  locked: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (card: PipelineCard, to: CrmStage) => void
  openLead: (recordId: string) => void
}) {
  const name = card.name || 'Unnamed lead'
  return (
    <article draggable={!locked}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); onDragStart() }}
      onDragEnd={onDragEnd}
      aria-busy={moving}
      className={`group rounded-md border border-[#d8dcde] bg-white px-2.5 py-2 ${moving ? 'opacity-50' : 'hover:border-[#87929d] hover:shadow-sm cursor-grab active:cursor-grabbing'}`}>
      <div className="flex items-start gap-1.5 min-w-0">
        <GripVertical size={13} className="mt-0.5 -ml-1 shrink-0 text-[#c2c8cc] group-hover:text-[#87929d]" aria-hidden />
        <button type="button" onClick={() => openLead(card.id)} title="Open the full record"
          className="min-w-0 flex-1 text-left text-[13px] font-semibold leading-snug text-[#1f73b7] hover:text-[#144a75] hover:underline break-words outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded">
          {name}
        </button>
        {card.value !== null && <span className="shrink-0 text-[13px] font-semibold tabular-nums">{formatMoney(card.value, card.currency)}</span>}
      </div>

      <p className="mt-1 flex items-center gap-1.5 min-w-0 text-[12px] text-[#49545c]">
        <span className="shrink-0">{KIND_LABEL[card.kind] ?? 'Lead'}</span>
        <span className="text-[#c2c8cc]" aria-hidden>·</span>
        <span className="truncate" title={card.siteName}>{card.siteName}</span>
      </p>

      {(card.mergedCount > 1 || card.unreadReplies > 0 || card.openTasks > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {card.mergedCount > 1 && (
            <span title={`${card.mergedCount} records from this customer are shown as one card. Changing the stage changes all of them.`}>
              <Chip>{card.mergedCount} records</Chip>
            </span>
          )}
          <CardBadges card={card} />
        </div>
      )}

      <div className="mt-2 flex items-center gap-1.5 min-w-0">
        {card.owner
          ? <><Avatar label={short(card.owner)} tone="agent" size={20} /><span className="truncate text-[12px] text-[#49545c]" title={card.owner}>{short(card.owner)}</span></>
          : <span className="text-[12px] text-[#87929d]">Unassigned</span>}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[#87929d]"
          title={card.lastActivityAt ? `Last activity ${formatDateTime(card.lastActivityAt)}` : 'No activity yet'}>
          {card.lastActivityAt ? timeAgo(card.lastActivityAt) : 'No activity'}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <select value="" disabled={locked} aria-label={`Move ${name} to another stage`}
          onChange={(e) => { if (e.target.value) onMove(card, e.target.value as CrmStage) }}
          className="h-7 flex-1 min-w-0 rounded border border-[#d8dcde] bg-[#f8f9f9] px-1.5 text-[12px] text-[#49545c] cursor-pointer outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 disabled:opacity-40">
          <option value="">Move to…</option>
          <MoveOptions card={card} stages={stages} />
        </select>
        {moving && <Loader2 size={13} className="shrink-0 animate-spin text-[#68737d]" aria-label="Moving" />}
      </div>
    </article>
  )
}

// ── List ─────────────────────────────────────────────────────────────────────

type SortKey = 'name' | 'siteName' | 'stage' | 'value' | 'owner' | 'lastActivityAt' | 'openTasks'
const LIST_COLUMNS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'name', label: 'Lead' },
  { key: 'siteName', label: 'Site' },
  { key: 'stage', label: 'Stage' },
  { key: 'value', label: 'Value', right: true },
  { key: 'owner', label: 'Owner' },
  { key: 'lastActivityAt', label: 'Last activity' },
  { key: 'openTasks', label: 'Tasks', right: true },
]
const stageRank = (s: CrmStage) => CRM_STAGES.indexOf(s)

function ListView({
  cards, columns, stages, loading, movingId, loadingMore, searching, loadedCount, totalMatching,
  selected, allMatching, selectingAll, onToggle, onSelectAllMatching, onClearSelection, onMove, onLoadMore, openLead,
}: {
  cards: PipelineCard[]
  columns: PipelineColumn[]
  stages: readonly CrmStage[]
  loading: boolean
  movingId: string | null
  loadingMore: CrmStage | null
  searching: boolean
  loadedCount: number
  totalMatching: number
  selected: ReadonlySet<string>
  allMatching: boolean
  selectingAll: boolean
  onToggle: (ids: string[], on: boolean) => void
  onSelectAllMatching: () => void
  onClearSelection: () => void
  onMove: (card: PipelineCard, to: CrmStage) => void
  onLoadMore: (stage: CrmStage) => void
  openLead: (recordId: string) => void
}) {
  const [sort, setSort] = useState<SortKey>('lastActivityAt')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const mul = dir === 'asc' ? 1 : -1
    return [...cards].sort((a, b) => {
      switch (sort) {
        case 'value':
          // A lead with no value sinks whichever way the column is sorted.
          if (a.value === null && b.value === null) return 0
          if (a.value === null) return 1
          if (b.value === null) return -1
          return (a.value - b.value) * mul
        case 'openTasks': return (a.openTasks - b.openTasks) * mul
        case 'stage': return (stageRank(a.stage) - stageRank(b.stage)) * mul
        case 'lastActivityAt': return (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? '') * mul
        case 'owner': return (a.owner ?? '').localeCompare(b.owner ?? '') * mul
        case 'siteName': return a.siteName.localeCompare(b.siteName) * mul
        default: return a.name.localeCompare(b.name) * mul
      }
    })
  }, [cards, sort, dir])

  const shownIds = cards.map((c) => c.id)
  const shownSelected = shownIds.filter((id) => selected.has(id)).length
  const allShownSelected = shownIds.length > 0 && shownSelected === shownIds.length
  const headerBox = (el: HTMLInputElement | null) => { if (el) el.indeterminate = shownSelected > 0 && !allShownSelected }
  const moreColumns = columns.filter((c) => c.hasMore)

  function toggleSort(key: SortKey) {
    if (key === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(key); setDir(key === 'name' || key === 'siteName' || key === 'owner' ? 'asc' : 'desc') }
  }

  if (!loading && cards.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6">
        <Empty text={searching && loadedCount > 0 ? 'None of the loaded leads match your search.' : 'No leads match these filters.'} />
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-6 [scrollbar-width:thin]">
      {allShownSelected && !allMatching && !searching && totalMatching > shownIds.length && (
        <p className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-[#edf7ff] px-3 py-2 text-[12px] text-[#144a75]">
          The {plural(shownIds.length, 'loaded lead is', 'loaded leads are')} selected. The rest of the {totalMatching} matching are not.
          <button type="button" onClick={onSelectAllMatching} disabled={selectingAll} className="font-semibold underline underline-offset-2 disabled:opacity-50">
            {selectingAll ? 'Selecting…' : `Select all ${totalMatching} matching`}
          </button>
        </p>
      )}
      {allMatching && (
        <p className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-[#dceefb] px-3 py-2 text-[12px] text-[#144a75]">
          All {plural(selected.size)} matching these filters are selected, including ones not shown below.
          <button type="button" onClick={onClearSelection} className="font-semibold underline underline-offset-2">Clear selection</button>
        </p>
      )}

      <div className="rounded-lg border border-[#d8dcde] overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-[#f8f9f9] text-left">
              <th scope="col" className="w-9 pl-4 py-2.5">
                <input type="checkbox" ref={headerBox} checked={allShownSelected} disabled={loading || shownIds.length === 0}
                  onChange={(e) => onToggle(shownIds, e.target.checked)}
                  aria-label={`Select the ${plural(shownIds.length)} shown`} className="h-3.5 w-3.5 align-middle accent-[#1f73b7] cursor-pointer" />
              </th>
              {LIST_COLUMNS.map((c) => {
                const active = sort === c.key
                return (
                  <th key={c.key} scope="col" aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`px-4 py-2.5 whitespace-nowrap ${c.right ? 'text-right' : ''}`}>
                    <button type="button" onClick={() => toggleSort(c.key)}
                      className={`inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded ${active ? 'text-[#2f3941]' : 'text-[#68737d] hover:text-[#2f3941]'}`}>
                      {c.label}
                      {active ? (dir === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />) : <ChevronsUpDown size={12} className="text-[#c2c8cc]" aria-hidden />}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="border-t border-[#e9ebed]">
                <td colSpan={LIST_COLUMNS.length + 1} className="px-4 py-3"><div className="h-3.5 rounded bg-[#e9ebed] animate-pulse" /></td>
              </tr>
            )) : sorted.map((card) => {
              const name = card.name || 'Unnamed lead'
              const on = selected.has(card.id)
              return (
                <tr key={card.id} aria-busy={movingId === card.id}
                  className={`border-t border-[#e9ebed] ${on ? 'bg-[#edf7ff]' : 'hover:bg-[#f8f9f9]'} ${movingId === card.id ? 'opacity-50' : ''}`}>
                  <td className="pl-4 py-2">
                    <input type="checkbox" checked={on} onChange={() => onToggle([card.id], !on)} aria-label={`Select ${name}`}
                      className="h-3.5 w-3.5 align-middle accent-[#1f73b7] cursor-pointer" />
                  </td>
                  <td className="px-4 py-2 max-w-[280px]">
                    <button type="button" onClick={() => openLead(card.id)}
                      className="text-left font-medium text-[#1f73b7] hover:text-[#144a75] hover:underline break-words outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded">
                      {name}
                    </button>
                    <span className="block text-[11px] text-[#68737d]">
                      {KIND_LABEL[card.kind] ?? 'Lead'}
                      {card.mergedCount > 1 && <span title="Changing the stage changes every record of this customer."> · {card.mergedCount} records</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2 max-w-[200px] truncate text-[#49545c]" title={card.siteName}>{card.siteName}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: STAGE_RULE[card.stage] }} aria-hidden />
                      <select value={card.stage} disabled={!!movingId} aria-label={`Stage for ${name}`}
                        onChange={(e) => onMove(card, e.target.value as CrmStage)}
                        className="h-7 max-w-[170px] rounded border border-[#d8dcde] bg-white px-1.5 text-[12px] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 disabled:opacity-40">
                        {(stages.includes(card.stage) ? stages : [card.stage, ...stages]).map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}
                      </select>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {card.value === null ? <span className="font-normal text-[#87929d]">None</span> : formatMoney(card.value, card.currency)}
                  </td>
                  <td className="px-4 py-2 text-[#49545c]">
                    {card.owner
                      ? <span className="inline-flex items-center gap-1.5" title={card.owner}><Avatar label={short(card.owner)} tone="agent" size={20} />{short(card.owner)}</span>
                      : <span className="text-[#87929d]">Unassigned</span>}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap tabular-nums text-[#49545c]" title={card.lastActivityAt ? formatDateTime(card.lastActivityAt) : undefined}>
                    {card.lastActivityAt ? timeAgo(card.lastActivityAt) : <span className="text-[#87929d]">None</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      {card.openTasks === 0 && card.unreadReplies === 0 ? <span className="text-[#87929d]">None</span> : <CardBadges card={card} />}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {!loading && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[#68737d]">
          <span>
            Showing {plural(cards.length)}{searching ? ` that match your search, out of ${loadedCount} loaded` : ''}
            {totalMatching > loadedCount ? `. ${totalMatching} match the filters in total` : ''}. Sorting and checkboxes apply to the leads shown.
          </span>
          {moreColumns.map((c) => (
            <button key={c.stage} type="button" className={BTN_PLAIN} disabled={!!loadingMore} onClick={() => onLoadMore(c.stage)}>
              {loadingMore === c.stage && <Loader2 size={13} className="animate-spin" aria-hidden />}
              Load more in {CRM_STAGE_LABEL[c.stage]} ({c.cards.length} of {c.count})
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Lost reason ──────────────────────────────────────────────────────────────

function LostFields({ reason, note, onReason, onNote, disabled }: {
  reason: LostReason | ''
  note: string
  onReason: (r: LostReason) => void
  onNote: (n: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-3">
      <fieldset disabled={disabled}>
        <legend className={LABEL}>Reason</legend>
        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {LOST_REASONS.map((r) => (
            <label key={r.key} className={`flex items-center gap-2 rounded px-2 py-1.5 cursor-pointer ${reason === r.key ? 'bg-[#edf7ff]' : 'hover:bg-[#f8f9f9]'}`}>
              <input type="radio" name="zd-lost-reason" value={r.key} checked={reason === r.key} onChange={() => onReason(r.key)} className="accent-[#1f73b7]" />
              <span>{r.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className={LABEL}>Note (optional)</span>
        <input value={note} maxLength={MAX_LOST_NOTE} disabled={disabled} onChange={(e) => onNote(e.target.value)}
          placeholder="For example: needed 14 x 14 x 12, which we cannot make" className={INPUT} />
      </label>
    </div>
  )
}

function LostDialog({ subject, records, onCancel, onConfirm }: {
  subject: string
  records: number
  onCancel: () => void
  onConfirm: (reason: LostReason, note: string) => void
}) {
  const [reason, setReason] = useState<LostReason | ''>('')
  const [note, setNote] = useState('')
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>('input[type="radio"]')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-labelledby="zd-lost-title">
      <button type="button" aria-label="Cancel" className="absolute inset-0 bg-[#2f3941]/30 cursor-default" onClick={onCancel} />
      <div ref={panel} className="relative w-full max-w-[520px] rounded-lg border border-[#d8dcde] bg-white shadow-xl">
        <div className="flex items-center gap-2 border-b border-[#d8dcde] px-5 py-3">
          <h2 id="zd-lost-title" className="text-[15px] font-semibold truncate">Why was {subject} lost?</h2>
          <button type="button" onClick={onCancel} aria-label="Cancel" className="ml-auto h-8 w-8 shrink-0 rounded flex items-center justify-center hover:bg-[#e9ebed]"><X size={16} aria-hidden /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <LostFields reason={reason} note={note} onReason={setReason} onNote={setNote} />
          {records > 1 && <Notice text={`This customer has ${records} records. All of them move to Lost with this reason.`} />}
        </div>
        <div className="flex items-center justify-end gap-2 rounded-b-lg border-t border-[#d8dcde] bg-[#f8f9f9] px-5 py-3">
          <span className="mr-auto text-[12px] text-[#68737d]">Nothing moves until you choose a reason.</span>
          <button type="button" className={BTN_PLAIN} onClick={onCancel}>Cancel</button>
          <button type="button" className={BTN_DANGER} disabled={!reason} onClick={() => { if (reason) onConfirm(reason, note.trim()) }}>Move to Lost</button>
        </div>
      </div>
    </div>
  )
}

// ── Bulk changes ─────────────────────────────────────────────────────────────
// Nothing is written on the first click: choosing a stage, an owner or a task
// opens a line that says exactly what will happen, and Apply writes it.

type Pending = { kind: 'stage'; stage: CrmStage } | { kind: 'owner'; email: string } | { kind: 'task' } | null

function BulkPanel({ count, allMatching, stages, lostRequired, owners, me, busy, result, onApply, onUndo, onClear, onDismiss }: {
  count: number
  allMatching: boolean
  stages: readonly CrmStage[]
  lostRequired: boolean
  owners: string[]
  me: string
  busy: boolean
  result: BulkResult | null
  onApply: (body: Record<string, unknown>) => void
  onUndo: () => void
  onClear: () => void
  onDismiss: () => void
}) {
  const [pending, setPendingRaw] = useState<Pending>(null)
  const [lost, setLost] = useState<{ reason: LostReason | ''; note: string }>({ reason: '', note: '' })
  const [task, setTask] = useState({ title: '', type: 'follow_up' as TaskType, dueDate: defaultDueDate(), dueTime: DEFAULT_DUE_TIME, assignee: '' })
  const setPending = (p: Pending) => { setPendingRaw(p); setLost({ reason: '', note: '' }) }
  const askLost = lostRequired && pending?.kind === 'stage' && pending.stage === 'lost'
  const leads = plural(count)
  const shell = 'shrink-0 border-t border-[#d8dcde] bg-white shadow-[0_-4px_12px_rgba(47,57,65,0.08)]'
  const field = 'h-8 rounded-md border border-[#d8dcde] bg-white px-2 text-[13px] outline-none focus:border-[#1f73b7] disabled:opacity-40'

  if (result) {
    const problems = result.failed.length + result.skipped.length
    return (
      <div className={`${shell} px-6 py-3 flex flex-wrap items-center gap-3`} role="status">
        {problems ? <AlertTriangle size={16} className="shrink-0 text-[#ad5918]" aria-hidden /> : <Check size={16} className="shrink-0 text-[#038153]" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{plural(result.applied)} updated</p>
          {(result.note || result.failed.length > 0) && (
            <p className="text-[12px] text-[#68737d]">
              {result.note}
              {result.failed.length > 0 && ` ${result.failed.length} could not be saved and ${result.failed.length === 1 ? 'was' : 'were'} left unchanged.`}
            </p>
          )}
        </div>
        {result.undo && result.applied > 0 && (
          <button type="button" className={BTN_PLAIN} onClick={onUndo} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Undo2 size={14} aria-hidden />}Undo
          </button>
        )}
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="h-8 w-8 rounded flex items-center justify-center hover:bg-[#e9ebed]"><X size={16} aria-hidden /></button>
      </div>
    )
  }

  if (count === 0) return null

  const apply = () => {
    if (!pending) return
    if (pending.kind === 'stage') onApply({ action: 'stage', stage: pending.stage, ...(askLost ? { lostReason: lost.reason, lostNote: lost.note.trim() } : {}) })
    else if (pending.kind === 'owner') onApply({ action: 'owner', email: pending.email })
    else onApply({ action: 'task', ...task, title: task.title.trim() })
    setPending(null)
  }

  return (
    <div className={shell} role="region" aria-label="Change the selected leads">
      {pending && (
        <div className="border-b border-[#e9ebed] bg-[#f8f9f9] px-6 py-3 space-y-3">
          {pending.kind === 'task' ? (
            <>
              <p className="font-semibold">Add a task to {leads}</p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex-1 min-w-[220px]"><span className={LABEL}>Task</span>
                  <input value={task.title} maxLength={200} autoFocus onChange={(e) => setTask({ ...task, title: e.target.value })} placeholder="What needs doing?" className={`${INPUT} !h-8`} />
                </label>
                <label><span className={LABEL}>Type</span>
                  <select value={task.type} onChange={(e) => setTask({ ...task, type: e.target.value as TaskType })} className={field}>
                    {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
                  </select>
                </label>
                <label><span className={LABEL}>Due date</span>
                  <input type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })} className={field} />
                </label>
                <label><span className={LABEL}>Due time (Pakistan)</span>
                  <input type="time" value={task.dueTime} onChange={(e) => setTask({ ...task, dueTime: e.target.value })} className={field} />
                </label>
                <label><span className={LABEL}>Assign to</span>
                  <select value={task.assignee} onChange={(e) => setTask({ ...task, assignee: e.target.value })} className={field}>
                    <option value="">Me ({short(me)})</option>
                    {owners.filter((o) => o !== me).map((o) => <option key={o} value={o}>{short(o)}</option>)}
                  </select>
                </label>
              </div>
            </>
          ) : askLost ? (
            <>
              <p className="font-semibold">Move {leads} to Lost. Why were they lost?</p>
              <LostFields reason={lost.reason} note={lost.note} disabled={busy} onReason={(r) => setLost({ ...lost, reason: r })} onNote={(n) => setLost({ ...lost, note: n })} />
            </>
          ) : (
            <p className="font-semibold">
              {pending.kind === 'stage' ? `Move ${leads} to ${CRM_STAGE_LABEL[pending.stage]}`
                : pending.email ? `Assign ${leads} to ${short(pending.email)}` : `Remove the owner from ${leads}`}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={apply}
              disabled={busy || (pending.kind === 'task' && (!task.title.trim() || !task.dueDate || !task.dueTime)) || (askLost && !lost.reason)}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Check size={14} aria-hidden />}Apply to {leads}
            </button>
            <button type="button" className={BTN_PLAIN} onClick={() => setPending(null)} disabled={busy}>Cancel</button>
            <span className="text-[12px] text-[#68737d]">You can undo this afterwards.</span>
          </div>
        </div>
      )}

      <div className="px-6 py-2.5 flex flex-wrap items-center gap-2">
        <span className="font-semibold tabular-nums">{count} selected{allMatching && <span className="ml-1 font-normal text-[#68737d]">(all matching)</span>}</span>
        {busy && <Loader2 size={14} className="animate-spin text-[#68737d]" aria-label="Saving" />}
        <select value="" disabled={busy} aria-label="Set the stage of the selected leads" className={field}
          onChange={(e) => { if (e.target.value) setPending({ kind: 'stage', stage: e.target.value as CrmStage }) }}>
          <option value="">Set stage…</option>
          {stages.map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}
        </select>
        <select value="" disabled={busy} aria-label="Set the owner of the selected leads" className={field}
          onChange={(e) => { if (e.target.value) setPending({ kind: 'owner', email: e.target.value === '__none' ? '' : e.target.value }) }}>
          <option value="">Set owner…</option>
          <option value={me}>Me ({short(me)})</option>
          {owners.filter((o) => o !== me).map((o) => <option key={o} value={o}>{short(o)}</option>)}
          <option value="__none">Unassign</option>
        </select>
        <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => setPending({ kind: 'task' })}><ListTodo size={14} aria-hidden />Add task</button>
        <button type="button" className={`${BTN_PLAIN} ml-auto`} disabled={busy} onClick={onClear}><X size={14} aria-hidden />Clear selection</button>
      </div>
    </div>
  )
}
