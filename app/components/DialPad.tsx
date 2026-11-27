'use client'

import { useEffect, useState } from 'react'
import { Delete, Phone, X } from 'lucide-react'
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
const KEYS: [string, string][] = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['+', ''], ['0', ''], ['#', ''],
]

// What the typed number will be read as, said before the call is placed.
function dialHint(typed: string): string {
  const t = typed.trim()
  const digits = t.replace(/\D/g, '')
  if (!digits) return 'Ten digits = US/Canada. Anywhere else, start with +'
  if (t.startsWith('+')) return digits.startsWith('1') ? 'US/Canada' : digits.startsWith('44') ? 'United Kingdom' : 'International number'
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) return 'US/Canada'
  if (digits.length < 10) return `${10 - digits.length} more digit${10 - digits.length === 1 ? '' : 's'} for a US/Canada number`
  return 'Start with + and the country code'
}

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
          className="print:hidden fixed bottom-4 right-20 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-700 shadow-lg hover:bg-gray-100"
        >
          <Phone className="h-4 w-4" aria-hidden />
        </button>
      )}

      {open && (
        <div role="dialog" aria-label="Dial a number"
          className="print:hidden fixed bottom-4 right-20 z-40 w-72 rounded-2xl border border-gray-200 bg-white p-4 shadow-lg">
          <div className="flex items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Dial a number</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close"
              className="ml-auto rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          {/* The number as it will be dialled: typed, pasted or tapped in. */}
          <div className="mt-3 flex items-center gap-1 border-b border-gray-200 pb-2">
            <input
              value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d+*#\s()-]/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') call() }}
              inputMode="tel" autoFocus placeholder="Enter a number"
              aria-label="Phone number"
              className="min-w-0 flex-1 bg-transparent text-center text-2xl font-semibold tracking-wide tabular-nums text-gray-900 placeholder:text-base placeholder:font-normal placeholder:tracking-normal placeholder:text-gray-400 focus:outline-none"
            />
            <button type="button" onClick={() => setNumber((n) => n.slice(0, -1))} disabled={!number}
              aria-label="Delete last digit"
              className="rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:invisible">
              <Delete className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <p className="mt-1.5 h-4 text-center text-[11px] text-gray-500">{dialHint(number)}</p>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {KEYS.map(([k, sub]) => (
              <button key={k} type="button" onClick={() => setNumber((n) => n + k)}
                aria-label={k === '+' ? 'Plus' : k === '#' ? 'Hash' : k}
                className="flex h-12 flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-50 text-gray-900 hover:bg-gray-100 active:bg-gray-200">
                <span className="text-lg font-semibold leading-none tabular-nums">{k}</span>
                {sub && <span className="mt-0.5 text-[9px] font-medium tracking-widest text-gray-500">{sub}</span>}
              </button>
            ))}
          </div>
          {error && <p role="alert" className="mt-2 text-center text-[11px] text-red-700">{error}</p>}
          <button
            type="button" onClick={call} disabled={busy || !number.trim()}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-full bg-green-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
          >
            <Phone className="h-4 w-4" aria-hidden />
            {busy ? 'Starting…' : 'Call'}
          </button>
          <p className="mt-2 text-center text-[10px] text-gray-500">
            A number with no record gets one, assigned to you, so the call is not lost.
          </p>
        </div>
      )}

      {/* Said AFTER the call has started, not instead of starting it. */}
      {made && (
        <div className="print:hidden fixed bottom-20 right-4 z-40 w-72 rounded-xl border border-gray-200 bg-white p-2.5 shadow-lg">
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
