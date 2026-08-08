'use client'

// Stale-tab recovery. Agents leave the dashboard open for days, and every
// production deploy in that window strands the open tab on a bundle whose
// lazily-loaded route chunks no longer exist on the server. Client-side
// navigation then fails silently: the URL changes but the page never swaps —
// the /pipeline "two clicks" bug (2026-08-08). Vercel Skew Protection keeps
// the old assets servable for 12 hours; this component covers the tab that
// stays open longer than that, and gets everyone onto the new bundle within
// minutes instead of days.
//
// Mounted once in the root layout, so every screen (dashboard, pipeline,
// tasks, lead records) inherits it.
//
// It polls /api/version — an env-var read, no DB — and compares against the
// id seen when the tab loaded. When the id moves:
//   • hidden tab   → reload immediately; nobody is looking at it
//   • visible tab  → show a small reload pill and wait; the reload happens
//     when the tab next goes hidden — never yank the page out from under
//     someone mid-sentence
//   • unsent text  → if any textarea holds text (chat composer, CRM note,
//     task title), never auto-reload — even hidden. The pill stays for a
//     manual reload once the agent has sent or discarded their draft.

import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

// 5 minutes: a deploy is a rare event, so the only job is convergence within
// minutes, not seconds. Chrome throttles hidden-tab timers to ~1/minute
// anyway, so a tighter interval would only spend requests on visible tabs.
// The endpoint is DB-free, so even at 5 minutes the cost is nil. A check also
// fires the moment a tab becomes visible, so a returning agent is told about
// a new version immediately regardless of where the interval sat.
const POLL_MS = 5 * 60 * 1000

// The composer, CRM notes and task forms are all textareas. Plain text inputs
// (search boxes, filters) are deliberately not counted — losing a half-typed
// filter to a reload is annoying; losing a half-typed customer reply is the
// thing this rule exists to prevent.
const hasUnsavedText = () =>
  Array.from(document.querySelectorAll('textarea')).some((t) => t.value.trim().length > 0)

export default function DeployRefresh() {
  const firstId = useRef<string | null>(null)
  const staleRef = useRef(false)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let alive = true

    const maybeReload = () => {
      if (staleRef.current && document.hidden && !hasUnsavedText()) window.location.reload()
    }

    const check = async () => {
      if (!alive || staleRef.current) return
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        if (!res.ok || !alive) return
        const d = await res.json()
        if (!d?.id) return
        if (firstId.current === null) { firstId.current = d.id; return }
        if (d.id !== firstId.current) {
          staleRef.current = true
          setStale(true)
          maybeReload()
        }
      } catch { /* offline or mid-deploy blip — next tick will see it */ }
    }

    check()
    const timer = window.setInterval(check, POLL_MS)
    const onVisibility = () => {
      if (document.hidden) maybeReload()
      else check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  if (!stale) return null
  return (
    <button
      onClick={() => window.location.reload()}
      title="A new version of the dashboard was deployed. This tab is running old code — reload to get current."
      className="fixed bottom-4 left-4 z-[60] flex items-center gap-1.5 rounded-full bg-white border border-gray-300 shadow-lg px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 transition-colors"
    >
      <RefreshCw size={12} strokeWidth={2} aria-hidden className="text-blue-600" />
      New version — reload
    </button>
  )
}
