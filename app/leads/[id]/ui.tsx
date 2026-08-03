'use client'

// Building blocks for the lead record page.
//
// COLOUR RULE (the one that breaks things if ignored): everything here is
// authored in the LIGHT Tailwind utilities the dashboard uses — bg-white,
// bg-gray-100, text-gray-900, border-gray-200 and the -50/-100/-700 tinted
// families. app/globals.css remaps exactly those under html.dark, so the page
// follows the dashboard's theme for free. A hand-picked hex or an un-remapped
// shade is the one element that goes dark-on-dark when an agent flips the theme.
//
// TYPE SCALE — four steps, so the eye always knows where to land:
//   page title   text-lg  font-bold    text-gray-900
//   section head text-[11px] font-semibold uppercase tracking-wider text-gray-500
//   body         text-sm  / text-xs    text-gray-900 / text-gray-700
//   metadata     text-[11px]           text-gray-500
// Hierarchy comes from weight and colour, not from size alone.

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Pencil, type LucideIcon } from 'lucide-react'

// ── Card ─────────────────────────────────────────────────────────────────────
// Tighter than before: 10px header padding rather than 12–16, and the body
// controls its own spacing so cards can sit flush against dense lists.
/**
 * Card weight.
 *
 * Every card used to carry the same border, radius and header, so Activity —
 * where agents actually live — competed on equal terms with Attachments. Three
 * tones instead:
 *   primary   the section being worked in; strongest border and header
 *   default   supporting content
 *   muted     reference material, deliberately recessive
 */
export type CardTone = 'primary' | 'default' | 'muted'

const CARD_SHELL: Record<CardTone, string> = {
  primary: 'bg-white border-gray-300 shadow-sm',
  default: 'bg-white border-gray-200 shadow-sm',
  muted: 'bg-white/70 border-gray-200 shadow-none',
}
const CARD_HEAD: Record<CardTone, string> = {
  primary: 'text-[11px] font-bold uppercase tracking-wider text-gray-700',
  default: 'text-[11px] font-semibold uppercase tracking-wider text-gray-600',
  muted: 'text-[10px] font-semibold uppercase tracking-wider text-gray-500',
}

export function Card({ title, icon: Icon, action, children, className = '', bodyClass = '', tone = 'default' }: {
  title?: string
  icon?: LucideIcon
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClass?: string
  tone?: CardTone
}) {
  return (
    <section className={`border rounded-xl overflow-hidden ${CARD_SHELL[tone]} ${className}`}>
      {title && (
        <header className={`flex items-center gap-2 px-3 border-b border-gray-100 ${tone === 'muted' ? 'py-1.5' : 'py-2'}`}>
          {Icon && <Icon size={tone === 'muted' ? 11 : 13} strokeWidth={2} className="text-gray-500 shrink-0" aria-hidden />}
          <h2 className={CARD_HEAD[tone]}>{title}</h2>
          {action && <div className="ml-auto flex items-center gap-1.5">{action}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  )
}

// ── Copy ─────────────────────────────────────────────────────────────────────
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
      className={`shrink-0 p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors ${className}`}>
      {copied ? <Check size={12} strokeWidth={2.5} className="text-green-600" /> : <Copy size={12} strokeWidth={2} />}
    </button>
  )
}

// ── Editable property ────────────────────────────────────────────────────────
// Reads as a value, not as a form control: no permanent input chrome. The edit
// affordance only appears on hover / keyboard focus, and the whole row is a
// click target for editing.
export function InlineField({ label, value, placeholder, href, overridden, onSave }: {
  label: string
  value: string
  placeholder: string
  href?: string
  overridden?: boolean
  onSave: (next: string) => Promise<void> | void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Seeded when editing STARTS rather than synced from the prop: a background
  // refresh landing mid-keystroke must never overwrite what is being typed.
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
    <div className="group/field px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
        {overridden && (
          <span title="Edited here — the originally captured value is kept in the timeline"
            className="text-[9px] px-1 rounded bg-blue-100 text-blue-700 border border-blue-200">edited</span>
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
          aria-label={label}
          className="mt-0.5 w-full bg-gray-100 border border-blue-500 rounded-md px-1.5 py-0.5 text-sm text-gray-900 focus:outline-none"
        />
      ) : (
        <div className="flex items-start gap-1 min-w-0">
          {/* Wraps at SENSIBLE boundaries, never mid-word: soft break
              opportunities are inserted before the @ and before each domain
              dot, so "marlenebrewer@protonmail.com" breaks after the local part
              rather than as "…prot / onmail.com". The full value is on hover
              either way. */}
          {value ? (
            href ? (
              <a href={href} title={value}
                className="text-sm text-blue-700 hover:underline leading-snug min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                {withBreakPoints(value)}
              </a>
            ) : (
              <span className="text-sm text-gray-900 break-words leading-snug min-w-0" title={value}>{value}</span>
            )
          ) : (
            <button type="button" onClick={startEdit}
              className="text-sm text-gray-400 italic hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
              {placeholder}
            </button>
          )}
          <span className="flex items-center gap-0.5 ml-auto shrink-0 opacity-0 group-hover/field:opacity-100 focus-within:opacity-100 transition-opacity">
            {value && <CopyButton value={value} label={label.toLowerCase()} />}
            {value && (
              <button type="button" onClick={startEdit} title={`Edit ${label.toLowerCase()}`}
                aria-label={`Edit ${label.toLowerCase()}`}
                className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
                <Pencil size={12} strokeWidth={2} />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}

// Insert zero-width break opportunities at the points a human would break an
// address or a URL — before the "@" and before each dot in the domain. <wbr>
// only takes effect when the line actually needs to wrap, so short values are
// untouched, and unlike break-all it can never split a word arbitrarily.
function withBreakPoints(value: string): React.ReactNode {
  const parts = value.split(/(?=[@.])/)
  if (parts.length === 1) return value
  return parts.map((part, i) => (
    <span key={i}>
      {i > 0 && <wbr />}
      {part}
    </span>
  ))
}

// ── Properties list ──────────────────────────────────────────────────────────
// A real properties list rather than a form dump: quiet uppercase label in a
// fixed gutter, strong value beside it, tight rows. Values WRAP — the whole
// point of the redesign is that nothing important ends in an ellipsis.
export function Prop({ label, children, title, mono = false }: {
  label: string
  children: React.ReactNode
  title?: string
  mono?: boolean
}) {
  return (
    <div className="flex gap-2 px-3 py-1">
      {/* Wide enough that "Last contact" and "Last activity" stay on one line —
          a label wrapping under itself reads as broken, not as dense. */}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 w-[88px] shrink-0 pt-0.5 leading-tight">
        {label}
      </span>
      <span className={`text-xs text-gray-800 min-w-0 break-words leading-snug ${mono ? 'font-mono' : ''}`} title={title}>
        {children}
      </span>
    </div>
  )
}

// A labelled group inside the properties list, so it reads as sections rather
// than one undifferentiated dump.
export function PropGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1 border-t border-gray-100 first:border-t-0">
      <p className="px-3 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-widest text-gray-400">{label}</p>
      {children}
    </div>
  )
}

// ── Quick action ─────────────────────────────────────────────────────────────
export function QuickAction({ icon: Icon, label, onClick, disabled, hint }: {
  icon: LucideIcon
  label: string
  onClick?: () => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={hint ?? label}
      aria-label={hint ? `${label} — ${hint}` : label}
      className={`flex-1 flex flex-col items-center gap-1 py-1.5 rounded-lg border text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        disabled
          ? 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 hover:border-gray-400 cursor-pointer'
      }`}>
      <Icon size={15} strokeWidth={2} aria-hidden />
      {label}
    </button>
  )
}

// ── Empty states ─────────────────────────────────────────────────────────────
// One compact line, not a hero block. An action can sit beside it on the same
// row — "No open tasks   [+ Task]" — which is what keeps the page dense.
// Compact on purpose: an empty state should take a line, not a panel.
export function EmptyLine({ icon: Icon, text, action }: {
  icon: LucideIcon
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5">
      <Icon size={11} strokeWidth={2} className="text-gray-400 shrink-0" aria-hidden />
      <p className="text-[11px] text-gray-500 min-w-0">{text}</p>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  )
}

// Kept for the full-page failure states, where a centred block IS right.
export function EmptyState({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center text-center px-4 py-6">
      <div className="w-9 h-9 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center mb-2" aria-hidden>
        <Icon size={16} strokeWidth={2} className="text-gray-500" />
      </div>
      <p className="text-sm font-semibold text-gray-800">{title}</p>
      {hint && <p className="text-xs text-gray-500 mt-0.5 max-w-[260px] leading-snug">{hint}</p>}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-gray-200 rounded animate-pulse ${className}`} aria-hidden />
}
