'use client'

// Per-member reminder preferences, opened from the /tasks header.
//
// Deliberately small: five decisions, sensible defaults, saved on change. A
// member who never opens this still gets reminders at the due time, 30 minutes
// before, and a 9am digest — with nothing arriving between 9pm and 8am.
//
// Times are labelled PKT throughout because that is what they are: quiet hours
// and the digest hour are Karachi hours, not the browser's.

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { LEAD_TIME_CHOICES, leadTimeLabel, hourLabel, type ReminderPrefs } from '@/lib/reminders'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

export default function ReminderSettings({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState<ReminderPrefs | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    fetch('/api/tasks/prefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return
        if (d?.prefs) { setPrefs(d.prefs); setStatus('ok') } else setStatus('error')
      })
      .catch(() => { if (alive) setStatus('error') })
    return () => { alive = false }
  }, [])

  // Optimistic: the control moves immediately and rolls back if the write fails,
  // so the panel never shows a setting the server did not accept.
  const save = useCallback(async (patch: Partial<ReminderPrefs>) => {
    if (!prefs) return
    const previous = prefs
    setPrefs({ ...prefs, ...patch })
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/tasks/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save')
      const d = await res.json()
      if (d?.prefs) setPrefs(d.prefs)
    } catch (err) {
      setPrefs(previous)
      setError(err instanceof Error ? err.message : 'Could not save — put back')
    } finally {
      setSaving(false)
    }
  }, [prefs])

  const quietOff = !!prefs && prefs.quietStart === prefs.quietEnd

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center px-4 py-10 bg-gray-900/40 backdrop-blur-sm"
      role="dialog" aria-modal="true" aria-label="Reminder settings"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm w-full max-w-md animate-in">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Reminder settings</h2>
          {saving && <span className="text-[10px] text-gray-400">saving…</span>}
          <button onClick={onClose} aria-label="Close"
            className="ml-auto p-1 rounded-md text-gray-400 hover:text-gray-800 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
            <X size={13} strokeWidth={2} aria-hidden />
          </button>
        </header>

        {status === 'loading' ? (
          <div className="p-4 space-y-3">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 bg-gray-200 rounded-lg animate-pulse" />)}
            <span className="sr-only" role="status">Loading your reminder settings…</span>
          </div>
        ) : status === 'error' || !prefs ? (
          <p className="px-4 py-6 text-xs text-gray-500">
            Could not load your settings. Close this and try again in a moment.
          </p>
        ) : (
          <div className="p-4 space-y-4">
            {error && (
              <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                {error}
              </p>
            )}

            <Toggle
              label="Task reminders"
              hint="A notification at the due time, and one before it."
              checked={prefs.enabled}
              onChange={(v) => save({ enabled: v })}
            />

            <Row label="Early reminder" disabled={!prefs.enabled}>
              <select value={prefs.leadMinutes} disabled={!prefs.enabled}
                onChange={(e) => save({ leadMinutes: Number(e.target.value) })}
                className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400 disabled:opacity-50">
                {LEAD_TIME_CHOICES.map((m) => (
                  <option key={m} value={m} className="bg-white text-gray-800">{leadTimeLabel(m)}</option>
                ))}
              </select>
            </Row>

            <hr className="border-gray-100" />

            <Toggle
              label="Daily digest"
              hint="One summary of what is overdue and due today."
              checked={prefs.digestEnabled}
              onChange={(v) => save({ digestEnabled: v })}
            />

            <Row label="Digest at" disabled={!prefs.digestEnabled}>
              <select value={prefs.digestHour} disabled={!prefs.digestEnabled}
                onChange={(e) => save({ digestHour: Number(e.target.value) })}
                className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400 disabled:opacity-50">
                {HOURS.map((h) => <option key={h} value={h} className="bg-white text-gray-800">{hourLabel(h)}</option>)}
              </select>
              <span className="text-[10px] text-gray-400">PKT</span>
            </Row>

            <hr className="border-gray-100" />

            <div>
              <p className="text-xs font-medium text-gray-900">Quiet hours</p>
              <p className="text-[11px] text-gray-500 mt-0.5">
                Nothing arrives in this window. Anything that comes due is held and delivered when it opens —
                never dropped.
              </p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <select value={prefs.quietStart} onChange={(e) => save({ quietStart: Number(e.target.value) })}
                  aria-label="Quiet hours start"
                  className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400">
                  {HOURS.map((h) => <option key={h} value={h} className="bg-white text-gray-800">{hourLabel(h)}</option>)}
                </select>
                <span className="text-[11px] text-gray-500">to</span>
                <select value={prefs.quietEnd} onChange={(e) => save({ quietEnd: Number(e.target.value) })}
                  aria-label="Quiet hours end"
                  className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1.5 text-xs text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400">
                  {HOURS.map((h) => <option key={h} value={h} className="bg-white text-gray-800">{hourLabel(h)}</option>)}
                </select>
                <span className="text-[10px] text-gray-400">PKT</span>
              </div>
              {quietOff && (
                <p className="text-[11px] text-amber-700 mt-1.5">
                  Start and end are the same — quiet hours are off, so reminders can arrive at any time.
                </p>
              )}
            </div>

            <p className="text-[10px] text-gray-400 pt-1">
              {summarise(prefs)}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function summarise(p: ReminderPrefs): string {
  if (!p.enabled && !p.digestEnabled) return 'All reminders are off — you will not be notified about tasks.'
  const bits: string[] = []
  if (p.enabled) {
    bits.push(p.leadMinutes > 0
      ? `Reminders at the due time and ${leadTimeLabel(p.leadMinutes).replace(' before', '')} before`
      : 'Reminders at the due time')
  }
  if (p.digestEnabled) bits.push(`a digest at ${hourLabel(p.digestHour)}`)
  const quiet = p.quietStart === p.quietEnd
    ? 'no quiet hours'
    : `held during ${hourLabel(p.quietStart)}–${hourLabel(p.quietEnd)}`
  return `${bits.join(', ')} — ${quiet}. All times Pakistan time.`
}

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium text-gray-900">{label}</span>
        <span className="block text-[11px] text-gray-500 mt-0.5">{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 accent-blue-600 cursor-pointer" />
    </label>
  )
}

function Row({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-2 flex-wrap ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-xs text-gray-700 w-[110px] shrink-0">{label}</span>
      {children}
    </div>
  )
}
