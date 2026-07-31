'use client'

// Small building blocks for the lead record page.
//
// Everything here styles itself with the same light Tailwind utilities the rest
// of the dashboard uses (bg-white / bg-gray-100 / text-gray-900 / border-gray-200).
// That is deliberate: dark mode is a remap of exactly those utilities in
// globals.css, so a hand-rolled color here would be the one element that goes
// dark-on-dark when an agent flips the theme.

import { useEffect, useRef, useState } from 'react'

export function Card({ title, action, children, className = '' }: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`bg-white border border-gray-200 rounded-2xl shadow-sm ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

// Copy-to-clipboard with a short confirmation. Falls back to a hidden textarea
// on browsers/contexts where the async clipboard API is unavailable.
export function CopyButton({ value, label, className = '' }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* nothing else to try */ }
      ta.remove()
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1400)
  }

  return (
    <button type="button" onClick={copy} title={copied ? 'Copied' : `Copy ${label ?? 'value'}`}
      aria-label={copied ? 'Copied' : `Copy ${label ?? 'value'}`}
      className={`shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 transition-colors ${className}`}>
      <span className="text-[11px] leading-none">{copied ? '✓' : '⧉'}</span>
    </button>
  )
}

// A label + value row that turns into an input on click. Saves on Enter or
// blur, reverts on Escape. `href` makes the value a mailto:/tel: link when it
// isn't being edited.
export function InlineField({ label, value, placeholder, href, overridden, onSave, multiline = false }: {
  label: string
  value: string
  placeholder: string
  href?: string
  overridden?: boolean
  onSave: (next: string) => Promise<void> | void
  multiline?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // The draft is seeded when editing STARTS rather than synced from the prop:
  // a background refresh landing mid-keystroke must never overwrite what the
  // agent is typing.
  function startEdit() {
    setDraft(value)
    setEditing(true)
  }

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  async function commit() {
    const next = draft.trim()
    setEditing(false)
    if (next === value.trim()) return
    setSaving(true)
    try { await onSave(next) } finally { setSaving(false) }
  }

  return (
    <div className="px-4 py-2.5 group">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        {overridden && (
          <span title="Edited here — the originally captured value is kept in the timeline"
            className="text-[9px] px-1 py-px rounded bg-blue-100 text-blue-700 border border-blue-200">edited</span>
        )}
        {saving && <span className="text-[10px] text-gray-400">saving…</span>}
      </div>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(value); setEditing(false) }
          }}
          placeholder={placeholder}
          className="mt-1 w-full bg-gray-100 border border-blue-400 rounded-lg px-2 py-1 text-sm text-gray-900 focus:outline-none"
        />
      ) : (
        <div className="mt-0.5 flex items-center gap-1 min-w-0">
          {value ? (
            href ? (
              <a href={href} className="text-sm text-blue-700 hover:underline truncate min-w-0" title={value}>{value}</a>
            ) : (
              <span className={`text-sm text-gray-900 min-w-0 ${multiline ? 'break-words' : 'truncate'}`} title={value}>{value}</span>
            )
          ) : (
            <span className="text-sm text-gray-400 italic">{placeholder}</span>
          )}
          <span className="flex items-center gap-0.5 ml-auto shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {value && <CopyButton value={value} label={label.toLowerCase()} />}
            <button type="button" onClick={startEdit} title={`Edit ${label.toLowerCase()}`}
              aria-label={`Edit ${label.toLowerCase()}`}
              className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 transition-colors">
              <span className="text-[11px] leading-none">✎</span>
            </button>
          </span>
        </div>
      )}
    </div>
  )
}

// A read-only "About this lead" row.
export function MetaRow({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 w-[86px] shrink-0">{label}</span>
      <span className="text-xs text-gray-800 min-w-0 truncate" title={title}>{children}</span>
    </div>
  )
}

// Actions that exist but aren't wired up yet. Rendered disabled with a reason,
// never as a button that silently does nothing.
export function QuickAction({ icon, label, onClick, disabled, hint }: {
  icon: string
  label: string
  onClick?: () => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={hint ?? label}
      aria-label={hint ? `${label} — ${hint}` : label}
      className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-xl border text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
        disabled
          ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
          : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-100 hover:border-gray-300 cursor-pointer'
      }`}>
      <span className="text-base leading-none" aria-hidden>{icon}</span>
      {label}
    </button>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-gray-200 rounded animate-pulse ${className}`} aria-hidden />
}

export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center text-center px-4 py-8">
      <div className="w-10 h-10 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-lg mb-2" aria-hidden>{icon}</div>
      <p className="text-sm font-medium text-gray-700">{title}</p>
      {hint && <p className="text-xs text-gray-500 mt-0.5 max-w-[240px]">{hint}</p>}
    </div>
  )
}
