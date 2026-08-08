'use client'

// Route-level error boundary — and the last line of stale-tab recovery.
//
// When a tab loaded before a deploy navigates to a route whose code chunk no
// longer exists (deployment skew), Next renders this boundary instead of the
// route. The correct recovery is a full load of the SAME url: the fresh HTML
// references the new deployment's chunks, which do exist. So for chunk-load
// failures this reloads automatically — the agent sees the page arrive a beat
// late, not an error screen. A sessionStorage stamp keeps it to one attempt
// per minute so a genuinely broken server shows the card below instead of a
// reload loop.
//
// Everything else (a real render bug) gets the card immediately: Try again
// re-renders the segment, Reload does a full load.

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk|failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Failed to load chunk/i

const isStaleChunkError = (e: Error) => CHUNK_ERROR_RE.test(`${e?.name ?? ''}: ${e?.message ?? ''}`)

const RELOAD_STAMP = 'zee-chunk-reload'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The card renders only when auto-reload is not the answer; until that is
  // decided (in the effect below) render nothing, so the agent never sees an
  // error flash before a successful automatic recovery.
  const [showCard, setShowCard] = useState(false)

  useEffect(() => {
    if (isStaleChunkError(error)) {
      let last = 0
      try { last = Number(sessionStorage.getItem(RELOAD_STAMP) || 0) } catch { /* storage off */ }
      if (Date.now() - last > 60_000) {
        try { sessionStorage.setItem(RELOAD_STAMP, String(Date.now())) } catch { /* storage off */ }
        window.location.reload()
        return
      }
    }
    setShowCard(true)
  }, [error])

  if (!showCard) return null
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-6">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 max-w-sm w-full text-center">
        <p className="text-sm font-semibold text-gray-900">This page couldn&rsquo;t load</p>
        <p className="text-xs text-gray-500 mt-1.5">
          If this keeps happening, the dashboard may have been updated underneath this tab — a reload gets the current version.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button onClick={() => reset()}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors">
            Try again
          </button>
          <button onClick={() => window.location.reload()}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors inline-flex items-center gap-1.5">
            <RefreshCw size={12} strokeWidth={2} aria-hidden /> Reload
          </button>
        </div>
      </div>
    </div>
  )
}
