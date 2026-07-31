'use client'

// Tasks & follow-ups on a lead record.
//
// Creating one has to take seconds, so the composer opens already valid:
// assigned to whoever is logged in, due tomorrow at 10am Karachi time, type
// Follow-up. Everything is overridable, nothing is required except the title.
//
// Completing is optimistic — the row strikes through the instant it is clicked
// and rolls back if the write fails, so the list never shows a state the
// database does not have.

import { useState } from 'react'
import { formatDueLabel, pktPartsOf, timeAgo } from '@/lib/datetime'
import {
  TASK_TYPES, TASK_TYPE_LABEL, TASK_TYPE_ICON, TASK_TYPE_STYLE,
  DEFAULT_DUE_TIME, defaultDueDate, taskBucket, MAX_TASK_TITLE,
  type CrmTaskEntry, type TaskType,
} from '@/lib/tasks'
import { Card, EmptyState } from './ui'

export interface TaskDraft {
  title: string
  type: TaskType
  dueDate: string
  dueTime: string
  assignee: string
}

export function emptyDraft(me: string): TaskDraft {
  return {
    title: '',
    type: 'follow_up',
    dueDate: defaultDueDate(),
    dueTime: DEFAULT_DUE_TIME,
    assignee: me,
  }
}

export default function Tasks({
  openTasks, doneTasks, members, me, busyIds, error,
  onCreate, onToggle, onDelete, onReassign,
}: {
  openTasks: CrmTaskEntry[]
  doneTasks: CrmTaskEntry[]
  members: string[]
  me: string
  busyIds: Set<string>
  error: string
  onCreate: (draft: TaskDraft) => Promise<void>
  onToggle: (task: CrmTaskEntry, done: boolean) => Promise<void>
  onDelete: (task: CrmTaskEntry) => Promise<void>
  onReassign: (task: CrmTaskEntry, assignee: string) => Promise<void>
}) {
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(() => emptyDraft(me))
  const [saving, setSaving] = useState(false)
  const [showDone, setShowDone] = useState(false)

  const overdueCount = openTasks.filter((t) => taskBucket(t.due_at) === 'overdue').length

  function open() {
    setDraft(emptyDraft(me))
    setComposing(true)
  }

  async function submit() {
    if (!draft.title.trim() || saving) return
    setSaving(true)
    try {
      await onCreate(draft)
      setComposing(false)
      setDraft(emptyDraft(me))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="Tasks & follow-ups"
      action={
        <span className="flex items-center gap-2">
          {overdueCount > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-red-100 text-red-700 border border-red-300">
              {overdueCount} overdue
            </span>
          )}
          <span className="text-[10px] text-gray-500">{openTasks.length} open</span>
          {!composing && (
            <button onClick={open} id="task-composer-open"
              className="text-[11px] font-semibold px-2 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
              + Task
            </button>
          )}
        </span>
      }>

      {composing && (
        <div className="px-4 pt-3 pb-3 border-b border-gray-100 space-y-2">
          <input
            autoFocus
            value={draft.title}
            maxLength={MAX_TASK_TITLE}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit() }
              if (e.key === 'Escape') { e.preventDefault(); setComposing(false) }
            }}
            placeholder="What needs doing? e.g. Call about the 5,000 unit quote"
            aria-label="Task title"
            className="w-full bg-gray-100 border border-gray-200 rounded-xl px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-400 transition-colors"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as TaskType })}
              aria-label="Task type"
              className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400">
              {TASK_TYPES.map((t) => (
                <option key={t} value={t} className="bg-white text-gray-800">
                  {TASK_TYPE_ICON[t]} {TASK_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <input type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
              aria-label="Due date"
              className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-800 focus:outline-none focus:border-blue-400" />
            <input type="time" value={draft.dueTime} onChange={(e) => setDraft({ ...draft, dueTime: e.target.value })}
              aria-label="Due time (Pakistan time)"
              className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-800 focus:outline-none focus:border-blue-400" />
            <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
              aria-label="Assignee"
              className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400">
              {members.length === 0 && <option value={me}>{me.split('@')[0]}</option>}
              {members.map((m) => (
                <option key={m} value={m} className="bg-white text-gray-800">{m.split('@')[0]}</option>
              ))}
            </select>
            <span className="text-[10px] text-gray-400">PKT</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={submit} disabled={!draft.title.trim() || saving}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
              {saving ? 'Adding…' : 'Add task'}
            </button>
            <button onClick={() => setComposing(false)} className="text-[11px] text-gray-500 hover:text-gray-800">
              Cancel
            </button>
            <span className="text-[10px] text-gray-400">Due tomorrow 10:00 AM unless you change it</span>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mx-4 mt-3 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
          {error}
        </p>
      )}

      {openTasks.length === 0 && !composing ? (
        <EmptyState icon="✅" title="No open tasks"
          hint="Add a follow-up so this lead doesn’t go quiet. Due dates are in Pakistan time." />
      ) : (
        <ul className="p-2 space-y-1">
          {openTasks.map((t) => (
            <TaskRow key={t.id} task={t} members={members} busy={busyIds.has(t.id)}
              onToggle={onToggle} onDelete={onDelete} onReassign={onReassign} />
          ))}
        </ul>
      )}

      {doneTasks.length > 0 && (
        <div className="border-t border-gray-100">
          <button onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            className="w-full flex items-center gap-2 px-4 py-2 text-[11px] text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors">
            <span aria-hidden>{showDone ? '▾' : '▸'}</span>
            {doneTasks.length} completed
          </button>
          {showDone && (
            <ul className="p-2 pt-0 space-y-1">
              {doneTasks.map((t) => (
                <TaskRow key={t.id} task={t} members={members} busy={busyIds.has(t.id)}
                  onToggle={onToggle} onDelete={onDelete} onReassign={onReassign} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

// One task. Overdue is carried by a red left rail + red due text rather than by
// colour alone on the text, so it still reads when the theme is flipped.
function TaskRow({ task, members, busy, onToggle, onDelete, onReassign }: {
  task: CrmTaskEntry
  members: string[]
  busy: boolean
  onToggle: (task: CrmTaskEntry, done: boolean) => Promise<void>
  onDelete: (task: CrmTaskEntry) => Promise<void>
  onReassign: (task: CrmTaskEntry, assignee: string) => Promise<void>
}) {
  const done = task.status === 'done'
  const bucket = taskBucket(task.due_at)
  const overdue = !done && bucket === 'overdue'
  const dueToday = !done && bucket === 'today'

  return (
    <li className={`group/task flex items-start gap-2.5 rounded-xl px-2.5 py-2 border transition-colors ${
      overdue ? 'border-red-200 bg-red-50' : done ? 'border-transparent bg-gray-100' : 'border-gray-200 bg-white hover:bg-gray-100'
    } ${busy ? 'opacity-60' : ''}`}>
      <button
        onClick={() => onToggle(task, !done)}
        disabled={busy}
        title={done ? 'Mark as not done' : 'Mark as done'}
        aria-label={done ? `Reopen: ${task.title}` : `Complete: ${task.title}`}
        className={`mt-0.5 w-4 h-4 shrink-0 rounded-full border flex items-center justify-center text-[9px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
          done ? 'bg-green-100 border-green-300 text-green-700' : 'bg-white border-gray-300 text-transparent hover:border-green-400 hover:text-green-400 cursor-pointer'
        }`}>
        ✓
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-xs ${done ? 'text-gray-500 line-through' : 'text-gray-900 font-medium'} break-words`}>
            {task.title}
          </span>
          <span className={`text-[9px] px-1 py-px rounded border shrink-0 ${TASK_TYPE_STYLE[task.type]}`}>
            {TASK_TYPE_ICON[task.type]} {TASK_TYPE_LABEL[task.type]}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className={`text-[10px] ${overdue ? 'text-red-700 font-semibold' : dueToday ? 'text-amber-700 font-semibold' : 'text-gray-500'}`}>
            {overdue ? '⚠ Overdue — ' : ''}{formatDueLabel(task.due_at)}
          </span>
          <span className="text-[10px] text-gray-400">·</span>
          <span className="text-[10px] text-gray-500">{task.assignee ? task.assignee.split('@')[0] : 'Unassigned'}</span>
          {done && task.completed_at && (
            <span className="text-[10px] text-green-700">· done {timeAgo(task.completed_at)}</span>
          )}
        </div>
      </div>

      <span className="flex items-center gap-1 shrink-0 opacity-0 group-hover/task:opacity-100 focus-within:opacity-100 transition-opacity">
        <select value={task.assignee} onChange={(e) => onReassign(task, e.target.value)} disabled={busy}
          aria-label={`Reassign: ${task.title}`} title="Reassign"
          className="bg-white border border-gray-200 rounded-md px-1 py-0.5 text-[10px] text-gray-700 cursor-pointer focus:outline-none focus:border-gray-400 max-w-[90px]">
          {!members.includes(task.assignee) && <option value={task.assignee}>{task.assignee.split('@')[0] || '—'}</option>}
          {members.map((m) => (
            <option key={m} value={m} className="bg-white text-gray-800">{m.split('@')[0]}</option>
          ))}
        </select>
        <button onClick={() => onDelete(task)} disabled={busy} title="Delete task" aria-label={`Delete: ${task.title}`}
          className="p-1 rounded-md text-gray-400 hover:text-red-600 hover:bg-gray-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
          <span className="text-[10px] leading-none">🗑</span>
        </button>
      </span>
    </li>
  )
}

// Prefill helper for editing an existing task's due date/time in the composer.
export function draftFromTask(t: CrmTaskEntry): TaskDraft {
  const parts = pktPartsOf(t.due_at)
  return {
    title: t.title,
    type: t.type,
    dueDate: parts?.date ?? defaultDueDate(),
    dueTime: parts?.time ?? DEFAULT_DUE_TIME,
    assignee: t.assignee,
  }
}
