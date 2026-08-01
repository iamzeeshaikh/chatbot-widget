'use client'

// The activity timeline — the heart of the record page.
//
// Every entry is MERGED from data that already exists elsewhere (chat messages,
// lead capture, assignment, stage/status rows, attachments) plus the notes and
// tasks this page writes. Nothing is duplicated into a new store; the API builds
// the list and this renders it, newest first, grouped by Pakistan-time day.
//
// Presentation rules:
//  • the ACTOR is named once. "Visitor · Visitor message" was saying the same
//    thing twice, so for plain messages the icon carries the type and the title
//    is dropped; for everything else the title is the information.
//  • event type is carried by ICON + a subtle accent ring, not by wording.
//  • day separators are a hairline and a quiet label — a divider, not a heading.

import { useMemo, useState } from 'react'
import {
  Sparkles, MessageSquare, StickyNote, Target, UserCheck, Paperclip,
  Pencil, Banknote, CircleCheck, History, Send, ChevronDown, ChevronRight, type LucideIcon,
} from 'lucide-react'
import { dateDividerLabel, formatTime, timeAgo } from '@/lib/datetime'
import { CRM_STAGE_LABEL, CRM_STAGE_DOT, CRM_STAGE_STYLE, formatMoney, type CrmCurrency } from '@/lib/crm'
import { TASK_TYPE_LABEL, TASK_TYPE_STYLE } from '@/lib/tasks'
import { isImageMime } from '@/lib/attachment'
import type { TimelineEvent } from '@/lib/leadrecord'
import { TASK_ICON } from './icons'
import { EmptyLine } from './ui'

type FilterKey = 'all' | 'notes' | 'messages' | 'tasks' | 'stage' | 'system'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'notes', label: 'Notes' },
  { key: 'messages', label: 'Messages' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'stage', label: 'Stage' },
  { key: 'system', label: 'System' },
]

const ICON: Record<TimelineEvent['kind'], LucideIcon> = {
  created: Sparkles,
  message: MessageSquare,
  note: StickyNote,
  stage: Target,
  assign: UserCheck,
  attachment: Paperclip,
  field: Pencil,
  value: Banknote,
  task: CircleCheck,
  email: Send,
}

// Accent per event type. Saturated mid-tones, chosen to read on both themes —
// the same reasoning as CRM_STAGE_DOT in lib/crm.ts.
function accent(e: TimelineEvent): string {
  if (e.kind === 'stage' && e.stage) return CRM_STAGE_DOT[e.stage]
  switch (e.kind) {
    case 'email': return '#0284c7'
    case 'task': return e.taskDone ? '#22c55e' : '#8b5cf6'
    case 'note': return '#6366f1'
    case 'created': return '#22c55e'
    case 'attachment': return '#0ea5e9'
    case 'value': return '#10b981'
    case 'assign': return '#f59e0b'
    default: return '#94a3b8'
  }
}

export default function Timeline({ events, currency, onEditNote, onDeleteNote, canManageNote }: {
  events: TimelineEvent[]
  currency: CrmCurrency
  onEditNote: (noteId: string, body: string) => Promise<void>
  onDeleteNote: (noteId: string) => Promise<void>
  canManageNote: (e: TimelineEvent) => boolean
}) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: events.length, notes: 0, messages: 0, tasks: 0, stage: 0, system: 0 }
    for (const e of events) c[e.group as FilterKey]++
    return c
  }, [events])

  const shown = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.group === filter)),
    [events, filter],
  )

  // Day separators, computed in Pakistan time so the divider flips at Karachi
  // midnight rather than the agent's own.
  const withDays = useMemo(() => {
    const out: { event: TimelineEvent; dayLabel: string | null }[] = []
    let lastLabel = ''
    for (const e of shown) {
      const label = dateDividerLabel(e.at)
      out.push({ event: e, dayLabel: label === lastLabel ? null : label })
      lastLabel = label
    }
    return out
  }, [shown])

  return (
    <div>
      <div className="flex items-center gap-1 flex-wrap px-3 py-2 border-b border-gray-100" role="tablist" aria-label="Filter activity">
        {FILTERS.map((f) => {
          const active = filter === f.key
          return (
            <button key={f.key} role="tab" aria-selected={active} onClick={() => setFilter(f.key)}
              className={`text-[11px] font-medium px-2 py-0.5 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                active ? 'bg-blue-100 text-blue-700 border-blue-300' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-100'
              }`}>
              {f.label}
              <span className={`ml-1 tabular-nums ${active ? 'text-blue-700' : 'text-gray-400'}`}>{counts[f.key]}</span>
            </button>
          )
        })}
      </div>

      {shown.length === 0 ? (
        <EmptyLine icon={History}
          text={filter === 'all'
            ? 'No activity yet — it appears here as the lead progresses.'
            : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} yet.`} />
      ) : (
        <ol className="px-3 py-2">
          {withDays.map(({ event: e, dayLabel }) => {
            const Icon = ICON[e.kind]
            const color = accent(e)
            // The actor already names who acted; for a plain message the icon
            // carries the type, so repeating "Visitor message" adds nothing.
            const showTitle = e.kind !== 'message'
            return (
              <li key={e.id}>
                {dayLabel && (
                  <div className="flex items-center gap-2 py-2 first:pt-0">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 shrink-0">{dayLabel}</span>
                    <div className="flex-1 h-px bg-gray-100" />
                  </div>
                )}
                <div className="flex gap-2.5">
                  {/* rail */}
                  <div className="flex flex-col items-center shrink-0">
                    <span className="w-5 h-5 rounded-full border flex items-center justify-center shrink-0"
                      style={{ borderColor: `${color}55`, backgroundColor: `${color}14`, color }} aria-hidden>
                      <Icon size={11} strokeWidth={2.25} />
                    </span>
                    <span className="flex-1 w-px bg-gray-100 my-1 min-h-[8px]" />
                  </div>

                  <div className="flex-1 min-w-0 pb-3">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-gray-900">{e.actor}</span>
                      {showTitle && <span className="text-xs text-gray-600">{e.title}</span>}
                      {e.kind === 'stage' && e.stage && (
                        <span className={`text-[10px] font-semibold px-1.5 rounded-full border ${CRM_STAGE_STYLE[e.stage]}`}>
                          {CRM_STAGE_LABEL[e.stage]}
                        </span>
                      )}
                      {e.kind === 'task' && e.taskType && (() => {
                        const TaskIcon = TASK_ICON[e.taskType]
                        return (
                          <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 rounded-full border ${TASK_TYPE_STYLE[e.taskType]}`}>
                            <TaskIcon size={9} strokeWidth={2.5} aria-hidden />
                            {TASK_TYPE_LABEL[e.taskType]}
                          </span>
                        )
                      })()}
                      <span className="text-[10px] text-gray-400 ml-auto whitespace-nowrap tabular-nums"
                        title={`${formatTime(e.at)} · ${timeAgo(e.at)}`}>
                        {formatTime(e.at)}
                      </span>
                    </div>

                    {e.kind === 'note' && e.body && editingNote === e.noteId ? (
                      <div className="mt-1">
                        <textarea value={draft} onChange={(ev) => setDraft(ev.target.value)} rows={3}
                          aria-label="Edit note"
                          className="w-full bg-gray-100 border border-blue-500 rounded-lg px-2 py-1.5 text-xs text-gray-900 focus:outline-none resize-y" />
                        <div className="flex items-center gap-2 mt-1">
                          <button disabled={busy || !draft.trim()}
                            onClick={async () => {
                              if (!e.noteId) return
                              setBusy(true)
                              try { await onEditNote(e.noteId, draft.trim()); setEditingNote(null) } finally { setBusy(false) }
                            }}
                            className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                            {busy ? 'Saving…' : 'Save'}
                          </button>
                          <button onClick={() => setEditingNote(null)}
                            className="text-[11px] text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">Cancel</button>
                        </div>
                      </div>
                    ) : e.kind === 'note' && e.body ? (
                      <div className="mt-1 group/note rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5">
                        <p className="text-xs text-gray-800 whitespace-pre-wrap break-words leading-snug">{e.body}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {e.editedAt && <span className="text-[10px] text-gray-500">edited {timeAgo(e.editedAt)}</span>}
                          {canManageNote(e) && (
                            <span className="ml-auto flex items-center gap-2 opacity-0 group-hover/note:opacity-100 focus-within:opacity-100 transition-opacity">
                              <button onClick={() => { setEditingNote(e.noteId ?? null); setDraft(e.body ?? '') }}
                                className="text-[10px] text-gray-500 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">Edit</button>
                              <button onClick={() => { if (e.noteId) onDeleteNote(e.noteId) }}
                                className="text-[10px] text-gray-500 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">Delete</button>
                            </span>
                          )}
                        </div>
                      </div>
                    ) : e.kind === 'attachment' && e.attachment ? (
                      <a href={e.attachment.url} target="_blank" rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-100 px-2 py-1 hover:border-gray-300 transition-colors max-w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                        {isImageMime(e.attachment.mime)
                          /* eslint-disable-next-line @next/next/no-img-element */
                          ? <img src={e.attachment.url} alt="" className="w-7 h-7 rounded object-cover shrink-0" />
                          : <Paperclip size={13} className="text-gray-500 shrink-0" aria-hidden />}
                        <span className="text-xs text-blue-700 truncate">{e.attachment.name}</span>
                      </a>
                    ) : e.kind === 'value' && e.body ? (
                      <p className="mt-0.5 text-xs text-gray-600 tabular-nums">{describeValue(e.body, currency)}</p>
                    ) : e.kind === 'email' && e.email ? (
                      <EmailEntry entry={e.email} />
                    ) : e.kind === 'task' && e.body ? (
                      <p className={`mt-0.5 text-xs break-words leading-snug ${e.taskDone ? 'text-gray-500 line-through' : 'text-gray-700'}`}>
                        {e.body}
                      </p>
                    ) : e.body ? (
                      <p className={`mt-0.5 text-xs text-gray-700 whitespace-pre-wrap break-words leading-snug ${e.kind === 'message' ? 'line-clamp-6' : ''}`}>
                        {e.kind === 'stage' ? `from ${CRM_STAGE_LABEL[e.body as keyof typeof CRM_STAGE_LABEL] ?? e.body}` : e.body}
                      </p>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

// A sent email: subject and snippet by default, the whole message one click
// away. The full body is already on the record, so opening it costs no request.
function EmailEntry({ entry }: { entry: NonNullable<TimelineEvent['email']> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5">
      <p className="text-xs font-semibold text-gray-900 break-words">{entry.subject}</p>
      <p className="text-[10px] text-gray-500 mt-0.5 break-words">
        from {entry.from}{entry.cc ? ` · cc ${entry.cc}` : ''}
      </p>
      {open ? (
        <p className="mt-1.5 text-xs text-gray-800 whitespace-pre-wrap break-words leading-snug">{entry.body}</p>
      ) : (
        <p className="mt-1 text-xs text-gray-700 break-words leading-snug">{entry.snippet}</p>
      )}
      {entry.body.trim() !== entry.snippet && (
        <button onClick={() => setOpen((v) => !v)}
          className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-sky-700 hover:text-sky-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
          {open ? <ChevronDown size={9} strokeWidth={2.5} aria-hidden /> : <ChevronRight size={9} strokeWidth={2.5} aria-hidden />}
          {open ? 'Hide full email' : 'Show full email'}
        </button>
      )}
    </div>
  )
}

function describeValue(body: string, fallbackCurrency: CrmCurrency): string {
  try {
    const o = JSON.parse(body)
    const cur = (o.currency ?? fallbackCurrency) as CrmCurrency
    const parts: string[] = []
    if (o.estimated !== null && o.estimated !== undefined) parts.push(`estimated ${formatMoney(o.estimated, cur)}`)
    if (o.won !== null && o.won !== undefined) parts.push(`won ${formatMoney(o.won, cur)}`)
    return parts.length ? parts.join(' · ') : 'cleared'
  } catch {
    return body
  }
}
