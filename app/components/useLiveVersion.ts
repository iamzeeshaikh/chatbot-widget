'use client'

// Live updates, cheaply.
//
// Polls /api/crm/version — one index-backed row — and only calls `onChange`
// when the marker actually moves. The screen then refetches its real payload,
// so a quiet CRM costs one tiny request per interval instead of a full board
// or record load.
//
// Three rules the callers rely on:
//   • the tab must stop polling when it is hidden (a backgrounded dashboard is
//     the single easiest way to melt a Micro Postgres)
//   • it must check IMMEDIATELY on becoming visible again, so coming back to
//     the tab shows current data rather than waiting out an interval
//   • it must never fire while the agent is mid-edit — `paused` defers the
//     refresh rather than dropping it, and it lands once they are done

import { useEffect, useRef } from 'react'

export interface LiveVersionOptions {
  /** Lead record id, when watching one. Omit for board-level screens. */
  leadId?: string
  /** Which marker this screen cares about. */
  watch: 'lead' | 'crm'
  intervalMs: number
  /** True while the agent is mid-edit — the refresh waits, it is not lost. */
  paused?: boolean
  onChange: () => void
}

export function useLiveVersion({ leadId, watch, intervalMs, paused, onChange }: LiveVersionOptions) {
  // Everything the timer needs lives in refs, so changing a prop never restarts
  // the interval and the effect body never calls setState.
  const seen = useRef<string | null>(null)
  const pending = useRef(false)
  const pausedRef = useRef(!!paused)
  const cbRef = useRef(onChange)
  useEffect(() => { pausedRef.current = !!paused }, [paused])
  useEffect(() => { cbRef.current = onChange }, [onChange])

  // A refresh deferred while the agent was typing fires as soon as they stop.
  useEffect(() => {
    if (!paused && pending.current) {
      pending.current = false
      cbRef.current()
    }
  }, [paused])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null

    const check = async () => {
      if (!alive || document.hidden) return
      try {
        const qs = leadId ? `?lead=${encodeURIComponent(leadId)}` : ''
        const res = await fetch(`/api/crm/version${qs}`)
        if (!res.ok || !alive) return
        const d = await res.json()
        const v: string | null = watch === 'lead' ? d.lead : d.crm
        if (v === null) return
        // First answer only establishes the baseline — it is not a change.
        if (seen.current === null) { seen.current = v; return }
        if (v === seen.current) return
        seen.current = v
        if (pausedRef.current) pending.current = true
        else cbRef.current()
      } catch { /* a missed poll is harmless; the next one catches up */ }
    }

    const start = () => {
      if (timer) return
      timer = setInterval(check, intervalMs)
    }
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null }
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else { start(); check() }   // catch up immediately on return
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', check)

    return () => {
      alive = false
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', check)
    }
  }, [leadId, watch, intervalMs])
}
