'use client'

// "Why was it lost?" — asked BEFORE a packaging lead moves to Lost (owner,
// 2026-11-11: the reason is required). The server refuses the move without
// one (lib/lostwrite.ts), so every place that can move a lead to Lost opens
// this first: the record's stage select, the board drag, the list select, the
// dashboard's leads list (the dialog) and the bulk bar (the fields, inline in
// its confirm panel). Cancel = no move.

import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { LOST_REASONS, MAX_LOST_NOTE, type LostReason } from '@/lib/lostreasons'

export function LostReasonFields({ reason, note, onReason, onNote, disabled }: {
  reason: LostReason | ''
  note: string
  onReason: (r: LostReason) => void
  onNote: (n: string) => void
  disabled?: boolean
}) {
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Why was it lost?" className="flex flex-wrap gap-1.5">
        {LOST_REASONS.map((r) => {
          const on = reason === r.key
          return (
            <button key={r.key} type="button" role="radio" aria-checked={on} disabled={disabled}
              onClick={() => onReason(r.key)}
              className={`text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${on
                ? 'bg-red-100 text-red-700 border-red-300'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'}`}>
              {r.label}
            </button>
          )
        })}
      </div>
      <input value={note} maxLength={MAX_LOST_NOTE} disabled={disabled} onChange={(e) => onNote(e.target.value)}
        aria-label="Note (optional)" placeholder="Note (optional), e.g. 14x14x12 — we can't make it"
        className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
    </div>
  )
}

export default function LostReasonDialog({ subject, busy, error, onCancel, onConfirm }: {
  /** "this lead", "Acme Ltd", "3 leads" */
  subject: string
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: (reason: LostReason, note: string) => void
}) {
  const [reason, setReason] = useState<LostReason | ''>('')
  const [note, setNote] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-16 bg-gray-900/40 backdrop-blur-sm whitespace-normal text-left font-normal"
      role="dialog" aria-modal="true" aria-label="Why was it lost?"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm w-full max-w-md">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Why was {subject} lost?</h2>
          <button type="button" onClick={onCancel} disabled={busy} aria-label="Cancel"
            className="ml-auto p-1 rounded-md text-gray-400 hover:text-gray-800 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <X size={13} strokeWidth={2} aria-hidden />
          </button>
        </header>
        <div className="p-4 space-y-3">
          <LostReasonFields reason={reason} note={note} onReason={setReason} onNote={setNote} disabled={busy} />
          {error && (
            <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{error}</p>
          )}
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={!reason || busy}
              onClick={() => { if (reason) onConfirm(reason, note.trim()) }}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              {busy && <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden />}
              Move to Lost
            </button>
            <button type="button" onClick={onCancel} disabled={busy}
              className="text-xs font-medium px-2 py-1.5 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <span className="text-[10px] text-gray-500 ml-auto">Shown on the Lost page</span>
          </div>
        </div>
      </div>
    </div>
  )
}
