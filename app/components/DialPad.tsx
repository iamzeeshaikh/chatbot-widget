'use client'

import { useEffect, useState } from 'react'
import { Phone, X } from 'lucide-react'
import { requestBrowserCall, watchSoftphoneReady } from '@/lib/softphonebus'

// Calling a number that is NOT on a record yet.
//
// Until now a call could only start from a lead page, so a number on a business
// card, a missed call on the office phone or a number a customer read out on
// another line had nowhere to be dialled from — the agent's complaint was
// exactly that: "na hamare paas koi dial pad hai".
//
// The pad never dials the number itself. It asks the server which LEAD that
// number belongs to (creating one if nothing holds it) and then places the
// ordinary lead call, so the recording, the timeline entry and the assignment
// all happen the way they already do. See app/api/calls/target/route.ts.
//
// It only appears once the softphone has registered — which is also the only
// state in which a browser call can be placed at all.
export default function DialPad() {
  const [ready, setReady] = useState(false)
  const [open, setOpen] = useState(false)
  const [number, setNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [made, setMade] = useState<{ leadId: string } | null>(null)

  useEffect(() => watchSoftphoneReady(setReady), [])

  if (!ready) return null

  async function call() {
    const typed = number.trim()
    if (!typed || busy) return
    setBusy(true); setError(''); setMade(null)
    try {
      const res = await fetch('/api/calls/target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: typed }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(j?.error ?? 'That call could not be started.'); return }

      // The lead name if we know one, the number if we do not — the panel that
      // takes over from here shows this as "who" for the whole call.
      const placed = requestBrowserCall({ leadId: j.leadId, leadName: j.name || typed })
      if (!placed) { setError('The phone is not ready yet. Try again in a moment.'); return }
      if (j.created) setMade({ leadId: j.leadId })
      else setMade(null)
      setOpen(false)
      setNumber('')
    } catch {
      setError('That call could not be started.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Sits to the LEFT of the softphone panel's corner, so a live call and
          this button never cover each other. */}
      {!open && (
        <button
          type="button" onClick={() => { setOpen(true); setError('') }}
          aria-label="Dial a number"
          className="fixed bottom-4 right-20 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-lg hover:bg-gray-100"
        >
          <Phone className="h-4 w-4" aria-hidden />
        </button>
      )}

      {open && (
        <div role="dialog" aria-label="Dial a number"
          className="fixed bottom-4 right-20 z-40 w-64 rounded-xl border border-gray-200 bg-white p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Dial a number</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close"
              className="ml-auto rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <input
            value={number} onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') call() }}
            inputMode="tel" autoFocus placeholder="+1 555 123 4567"
            aria-label="Phone number"
            className="mt-2 w-full rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400"
          />
          <p className="mt-1 text-[10px] text-gray-500">
            A ten-digit number is treated as US/Canada. For anywhere else, start with +.
          </p>
          {error && <p role="alert" className="mt-1.5 text-[11px] text-red-700">{error}</p>}
          <button
            type="button" onClick={call} disabled={busy || !number.trim()}
            className="mt-2 w-full rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
          >
            {busy ? 'Starting…' : 'Call'}
          </button>
          <p className="mt-1.5 text-[10px] text-gray-500">
            If no record holds this number, one is created for it and assigned to you, so the call is not lost.
          </p>
        </div>
      )}

      {/* Said AFTER the call has started, not instead of starting it. */}
      {made && (
        <div className="fixed bottom-20 right-4 z-40 w-72 rounded-xl border border-gray-200 bg-white p-2.5 shadow-lg">
          <p className="text-[11px] text-gray-600">
            A new record was created for this number.{' '}
            <a href={`/leads/${encodeURIComponent(made.leadId)}`} className="font-semibold text-blue-700 hover:underline">
              Open it
            </a>{' '}
            to add the name and what it is about.
          </p>
          <button type="button" onClick={() => setMade(null)}
            className="mt-1 text-[10px] text-gray-500 hover:text-gray-700">Dismiss</button>
        </div>
      )}
    </>
  )
}
