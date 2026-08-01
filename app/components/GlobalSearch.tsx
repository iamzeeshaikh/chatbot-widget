'use client'

// Global lead search: a nav button plus a command palette on Cmd/Ctrl-K.
//
// Mounted in every CRM header rather than living on one page, because the
// moment it is needed is a phone call arriving while you are somewhere else.
//
// Keyboard end to end: Cmd/Ctrl-K (or "/") opens, typing filters, arrows move,
// Enter opens the highlighted lead, Esc closes. The list is a listbox with
// aria-activedescendant so a screen reader follows the highlight without focus
// ever leaving the input.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, Loader2, Users, CornerDownLeft } from 'lucide-react'
import { CRM_STAGE_LABEL, CRM_STAGE_STYLE, type CrmStage } from '@/lib/crm'
import { timeAgo } from '@/lib/datetime'
import type { SearchHit } from '@/lib/leadsearch'

const DEBOUNCE_MS = 220

const MATCH_LABEL: Record<string, string> = {
  name: 'name', email: 'email', phone: 'phone', enquiry: 'enquiry', site: 'site',
}

export default function GlobalSearch({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  // The term the current `hits` belong to. Loading is DERIVED from this
  // (results ≠ what is typed) rather than set from the effect, which keeps the
  // debounce free of synchronous setState and shows the spinner for the whole
  // wait — including the debounce — instead of only the fetch.
  const [resultTerm, setResultTerm] = useState('')
  const [stages, setStages] = useState<Record<string, { stage: CrmStage; owner: string | null }>>({})
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  // ── open / close ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        || (el instanceof HTMLElement && el.isContentEditable)
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); setOpen(true); return
      }
      // "/" is the other muscle memory, but must not hijack typing a slash.
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault(); setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    // Focus after paint so the caret lands reliably on every browser.
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const close = useCallback(() => {
    setOpen(false); setTerm(''); setHits([]); setResultTerm(''); setFailed(false)
    setActive(0); setTruncated(false)
  }, [])

  const q = term.trim()
  const tooShort = q.length < 2
  // Only ever show hits that belong to what is currently typed.
  const visible = !tooShort && resultTerm === q ? hits : []
  const loading = !tooShort && resultTerm !== q && !failed

  // ── query, debounced ───────────────────────────────────────────────────────
  // One timer, restarted on every keystroke, and every response carries the
  // sequence number of the request that asked for it — so a slow early query
  // landing after a fast later one cannot overwrite fresher results.
  useEffect(() => {
    const typed = term.trim()
    if (typed.length < 2) return
    const mine = ++seq.current
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(typed)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('search failed'))))
        .then((d) => {
          if (mine !== seq.current) return
          setHits(d.hits ?? [])
          setResultTerm(typed)
          setFailed(false)
          setTruncated(!!d.truncated)
          setActive(0)
          // Stage/owner come from the pipeline's own fold; fetched separately so
          // a slow enrichment never delays showing the matches.
          const ids: string[] = (d.hits ?? []).map((h: SearchHit) => h.id)
          if (ids.length) {
            fetch('/api/search/state', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids }),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((s) => { if (s && mine === seq.current) setStages(s.state ?? {}) })
              .catch(() => { /* the row still identifies the lead without it */ })
          }
        })
        .catch(() => { if (mine === seq.current) { setFailed(true); setResultTerm(typed) } })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term])

  const go = useCallback((hit: SearchHit) => {
    close()
    window.location.assign(`/leads/${encodeURIComponent(hit.id)}`)
  }, [close])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, visible.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Home' && visible.length) { e.preventDefault(); setActive(0) }
    else if (e.key === 'End' && visible.length) { e.preventDefault(); setActive(visible.length - 1) }
    else if (e.key === 'Enter' && visible[active]) { e.preventDefault(); go(visible[active]) }
  }

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // How many leads share each party, so a repeat customer is obvious.
  const groupSize = new Map<number, number>()
  for (const h of visible) groupSize.set(h.group, (groupSize.get(h.group) ?? 0) + 1)

  return (
    <>
      <button onClick={() => setOpen(true)}
        title="Search leads (⌘K)" aria-label="Search leads"
        aria-keyshortcuts="Meta+K Control+K"
        className={compact
          ? 'shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
          : 'shrink-0 inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'}>
        <Search size={compact ? 16 : 13} strokeWidth={2} aria-hidden />
        {!compact && (
          <>
            <span className="text-[11px] font-medium">Search leads</span>
            <kbd className="text-[9px] font-semibold px-1 py-px rounded border border-gray-300 bg-gray-100 text-gray-600">⌘K</kbd>
          </>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[8vh] bg-gray-900/40 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) close() }}>
          <div role="dialog" aria-modal="true" aria-label="Search leads"
            className="w-full max-w-2xl bg-white border border-gray-300 rounded-2xl shadow-2xl overflow-hidden">

            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200">
              <span className="text-gray-500 shrink-0">
                {loading
                  ? <Loader2 size={15} strokeWidth={2} className="animate-spin" aria-hidden />
                  : <Search size={15} strokeWidth={2} aria-hidden />}
              </span>
              <input ref={inputRef} value={term} onChange={(e) => setTerm(e.target.value)} onKeyDown={onKeyDown}
                placeholder="Search by name, email, phone, site or what they asked for…"
                aria-label="Search leads" role="combobox" aria-expanded={visible.length > 0}
                aria-controls="zee-search-results" aria-autocomplete="list"
                aria-activedescendant={visible[active] ? `zee-hit-${active}` : undefined}
                className="flex-1 min-w-0 bg-transparent text-sm text-gray-900 placeholder-gray-400 focus:outline-none" />
              <button onClick={close} aria-label="Close search"
                className="shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors">
                <X size={14} strokeWidth={2} aria-hidden />
              </button>
            </div>

            <div id="zee-search-results" ref={listRef} role="listbox" aria-label="Search results"
              className="max-h-[52vh] overflow-y-auto">

              {tooShort ? (
                <p className="px-3 py-6 text-center text-xs text-gray-500">
                  Type at least two characters. Searches name, email, phone, site and the enquiry text.
                </p>
              ) : loading ? (
                <div className="px-3 py-3 space-y-2" role="status" aria-live="polite">
                  <span className="sr-only">Searching…</span>
                  {[0, 1, 2].map((i) => <div key={i} className="h-9 bg-gray-100 rounded-lg animate-pulse" />)}
                </div>
              ) : failed ? (
                <p className="px-3 py-6 text-center text-xs text-gray-600">
                  Search could not run just now. Try again in a moment.
                </p>
              ) : visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-gray-500">
                  Nothing matches <span className="font-semibold text-gray-700">“{term.trim()}”</span>.
                  Try part of a name, an email, or a phone number.
                </p>
              ) : (
                <>
                  {visible.map((h, i) => {
                    const st = stages[h.id]
                    const shared = (groupSize.get(h.group) ?? 1) > 1
                    return (
                      <div key={h.id} id={`zee-hit-${i}`} data-idx={i} role="option" aria-selected={i === active}
                        onMouseMove={() => setActive(i)} onClick={() => go(h)}
                        className={`px-3 py-2 cursor-pointer border-b border-gray-100 last:border-b-0 ${
                          i === active ? 'bg-blue-50' : 'hover:bg-gray-50'
                        }`}>
                        <div className="flex items-baseline gap-2 min-w-0">
                          <span className="text-xs font-semibold text-gray-900 truncate">{h.name}</span>
                          {st && (
                            <span className={`shrink-0 text-[9px] font-bold px-1.5 rounded-full border ${CRM_STAGE_STYLE[st.stage]}`}>
                              {CRM_STAGE_LABEL[st.stage]}
                            </span>
                          )}
                          {shared && (
                            <span title="The same person appears as more than one lead"
                              className="shrink-0 inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 rounded-full border bg-purple-100 text-purple-700 border-purple-300">
                              <Users size={8} strokeWidth={2.5} aria-hidden />
                              {groupSize.get(h.group)} leads
                            </span>
                          )}
                          <span className="ml-auto shrink-0 text-[10px] text-gray-500 tabular-nums">
                            {h.at ? timeAgo(h.at) : '—'}
                          </span>
                        </div>
                        <div className="flex items-baseline gap-1.5 mt-0.5 min-w-0">
                          <span className="text-[11px] text-gray-600 truncate">{h.email ?? h.phone ?? '—'}</span>
                          <span className="text-gray-300" aria-hidden>·</span>
                          <span className="text-[11px] text-gray-500 truncate">{h.siteName}</span>
                          <span className="text-gray-300" aria-hidden>·</span>
                          <span className="text-[10px] text-gray-500 truncate">
                            {st?.owner ? st.owner.split('@')[0] : 'Unassigned'}
                          </span>
                          <span className="ml-auto shrink-0 text-[9px] text-gray-500 uppercase tracking-wide">
                            {MATCH_LABEL[h.matchedOn] ?? h.matchedOn}
                          </span>
                        </div>
                        {h.snippet && (
                          <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-1 italic">{h.snippet}</p>
                        )}
                      </div>
                    )
                  })}
                  {truncated && (
                    <p className="px-3 py-1.5 text-[10px] text-gray-500 border-t border-gray-100">
                      Showing the {visible.length} most recent matches. Narrow the search to see others.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-3 px-3 py-1.5 border-t border-gray-200 bg-gray-50 text-[10px] text-gray-500">
              <span className="inline-flex items-center gap-1"><kbd className="px-1 rounded border border-gray-300 bg-white">↑↓</kbd> move</span>
              <span className="inline-flex items-center gap-1"><CornerDownLeft size={9} strokeWidth={2.5} aria-hidden /> open</span>
              <span className="inline-flex items-center gap-1"><kbd className="px-1 rounded border border-gray-300 bg-white">Esc</kbd> close</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
