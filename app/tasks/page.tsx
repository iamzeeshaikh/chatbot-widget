'use client'

// The global task queue — /tasks.
//
// This is a WORK QUEUE, so it is built for scanning: one row per task on one
// line where the width allows, so an agent can see their whole day without
// scrolling. Four groups in the order they are worked — what is late, what is
// due today, what is coming, and (collapsed) what is finished.
//
// Buckets are computed server-side against Pakistan time, so an agent
// travelling or a browser in another zone still sees the same queue. A member
// only ever receives tasks for sites they can access — enforced in the query
// behind /api/tasks, not by hiding rows here.
//
// Built from the record page's design system: the same type scale, tabular
// numbers and lucide set at one stroke weight, in the light Tailwind utilities
// globals.css remaps for dark mode.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft, Bell, TriangleAlert, CheckCircle2, AlertTriangle, Check,
  ExternalLink, CalendarClock, UserRound, Filter as FilterIcon, X,
} from 'lucide-react'
import { formatDueLabel, formatDateTime, formatShortDate, pktPartsOf, pktDayKey, dateDividerLabel } from '@/lib/datetime'
import { TASK_TYPES, TASK_TYPE_LABEL, TASK_TYPE_STYLE, type TaskType } from '@/lib/tasks'
import { TASK_ICON } from '@/app/leads/[id]/icons'
import type { TaskWithLead, TaskGroups } from '@/lib/taskquery'
import ReminderSettings from './ReminderSettings'

interface TasksResponse {
  groups: TaskGroups
  total: number
  me: string
  options: {
    sites: { siteId: string; name: string }[]
    assignees: string[]
    members: string[]
  }
}

const EMPTY_GROUPS: TaskGroups = { overdue: [], today: [], upcoming: [], completed: [] }

export default function TasksPage() {
  const [data, setData] = useState<TasksResponse | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading')
  const [assignee, setAssignee] = useState('me')
  const [site, setSite] = useState('')
  const [type, setType] = useState<TaskType | 'all'>('all')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode — default light */ }
  }, [])

  // Promise chain rather than an async body: state only ever moves inside a
  // `.then`, never synchronously while the effect below is running.
  const load = useCallback((): Promise<void> => {
    const qs = new URLSearchParams({ assignee, type })
    if (site) qs.set('site', site)
    return fetch(`/api/tasks?${qs.toString()}`)
      .then(async (res) => {
        if (res.status === 401) { window.location.href = '/login'; return }
        if (!res.ok) { setStatus('error'); return }
        setData(await res.json())
        setStatus('ok')
      })
      .catch(() => setStatus('error'))
  }, [assignee, site, type])

  useEffect(() => { load() }, [load])

  const groups = data?.groups ?? EMPTY_GROUPS
  const openCount = groups.overdue.length + groups.today.length + groups.upcoming.length

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
  }, [])

  // Optimistic completion: the task leaves its group immediately and is put back
  // if the write fails. The write goes to the LEAD's task endpoint, which
  // re-checks site access for the member.
  const toggle = useCallback(async (task: TaskWithLead, done: boolean) => {
    setError('')
    markBusy(task.id, true)
    const snapshot = data
    setData((d) => {
      if (!d) return d
      const strip = (list: TaskWithLead[]) => list.filter((t) => t.id !== task.id)
      const moved = { ...task, status: done ? 'done' as const : 'open' as const }
      return {
        ...d,
        groups: done
          ? {
              overdue: strip(d.groups.overdue), today: strip(d.groups.today), upcoming: strip(d.groups.upcoming),
              completed: [moved, ...d.groups.completed],
            }
          : {
              ...d.groups,
              completed: strip(d.groups.completed),
              [task.bucket]: [moved, ...d.groups[task.bucket]],
            } as TaskGroups,
      }
    })
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(task.leadId)}/tasks`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, status: done ? 'done' : 'open' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not update the task')
      await load()
    } catch (err) {
      if (snapshot) setData(snapshot)
      setError(err instanceof Error ? err.message : 'Could not update the task — it was put back')
    } finally {
      markBusy(task.id, false)
    }
  }, [data, load, markBusy])

  // Reassign and reschedule reuse the same PATCH the record page uses — no new
  // endpoint and no new behaviour, just reachable from the queue.
  const patch = useCallback(async (task: TaskWithLead, body: Record<string, unknown>) => {
    setError('')
    markBusy(task.id, true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(task.leadId)}/tasks`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id, ...body }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not update the task')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the task')
    } finally {
      markBusy(task.id, false)
    }
  }, [load, markBusy])

  const sites = data?.options.sites ?? []
  const members = data?.options.members ?? []
  const assignees = useMemo(() => (data?.options.assignees ?? []).filter(Boolean), [data])
  const filtersOn = assignee !== 'me' || !!site || type !== 'all'
  const rowProps = { busy, onToggle: toggle, onPatch: patch, members }

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-2.5">
          <div className="flex items-center gap-3 flex-wrap">
            <Link href="/" title="Back to the dashboard" aria-label="Back to the dashboard"
              className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
              <ArrowLeft size={16} strokeWidth={2} aria-hidden />
            </Link>
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-gray-900 leading-tight">Tasks &amp; follow-ups</h1>
              <p className="text-[11px] text-gray-500 leading-tight tabular-nums">
                {status === 'loading' ? 'Loading…' : `${openCount} open · due dates in Pakistan time`}
              </p>
            </div>
            <span className="ml-auto flex items-center gap-1.5">
              {groups.overdue.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-300 tabular-nums">
                  <AlertTriangle size={10} strokeWidth={2.5} aria-hidden />
                  {groups.overdue.length} overdue
                </span>
              )}
              <button onClick={() => setShowSettings(true)}
                title="Reminder settings — lead time, digest and quiet hours"
                className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <Bell size={12} strokeWidth={2} aria-hidden /> Reminders
              </button>
            </span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            <FilterIcon size={11} strokeWidth={2} className="text-gray-400 shrink-0" aria-hidden />
            <Filter label="Assignee" value={assignee} active={assignee !== 'me'} onChange={setAssignee}
              options={[
                { value: 'me', label: 'Me' },
                { value: 'all', label: 'Everyone' },
                ...assignees.map((a) => ({ value: a, label: a.split('@')[0] })),
              ]} />
            <Filter label="Site" value={site} active={!!site} onChange={setSite}
              options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: s.siteId, label: s.name }))]} />
            <Filter label="Type" value={type} active={type !== 'all'} onChange={(v) => setType(v as TaskType | 'all')}
              options={[{ value: 'all', label: 'All types' }, ...TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABEL[t] }))]} />
            {filtersOn && (
              <button onClick={() => { setAssignee('me'); setSite(''); setType('all') }}
                className="inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-600 hover:text-gray-900 px-1.5 py-0.5 rounded-md border border-gray-200 bg-white hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <X size={9} strokeWidth={2.5} aria-hidden /> Clear
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1500px] mx-auto px-3 sm:px-5 py-3 space-y-2 animate-in">
        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
            <TriangleAlert size={12} strokeWidth={2} aria-hidden />{error}
          </p>
        )}

        {status === 'loading' ? (
          <LoadingSkeleton />
        ) : status === 'error' ? (
          <Panel>
            <div className="flex items-center gap-2 px-3 py-3">
              <TriangleAlert size={14} strokeWidth={2} className="text-gray-400 shrink-0" aria-hidden />
              <p className="text-xs text-gray-600">Could not load your tasks. Try again in a moment.</p>
            </div>
          </Panel>
        ) : openCount === 0 && groups.completed.length === 0 ? (
          <Panel>
            <div className="flex items-center gap-2 px-3 py-3">
              <CheckCircle2 size={14} strokeWidth={2} className="text-green-600 shrink-0" aria-hidden />
              <p className="text-xs text-gray-600">
                {filtersOn
                  ? 'No tasks match these filters.'
                  : 'Nothing on your list. Tasks you add from a lead record show up here.'}
              </p>
            </div>
          </Panel>
        ) : (
          <>
            <Group title="Overdue" tone="overdue" tasks={groups.overdue} empty="Nothing is late." {...rowProps} />
            <Group title="Due today" tone="today" tasks={groups.today} empty="Nothing else due today." {...rowProps} />
            {/* Upcoming is split by Karachi day so a week reads as a week. */}
            <Group title="Upcoming" tone="upcoming" tasks={groups.upcoming} empty="Nothing scheduled ahead." byDay {...rowProps} />

            {groups.completed.length > 0 && (
              <Panel>
                <button onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <Check size={11} strokeWidth={2.5} aria-hidden />
                  Completed
                  <span className="font-normal text-gray-500 tabular-nums">{groups.completed.length}</span>
                  <span className="ml-auto text-gray-400">{showDone ? '−' : '+'}</span>
                </button>
                {showDone && (
                  <ul className="divide-y divide-gray-100 border-t border-gray-100">
                    {groups.completed.map((t) => <Row key={t.id} task={t} {...rowProps} />)}
                  </ul>
                )}
              </Panel>
            )}
          </>
        )}
      </main>

      {showSettings && <ReminderSettings onClose={() => setShowSettings(false)} />}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Panel({ children }: { children: React.ReactNode }) {
  return <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">{children}</section>
}

interface RowHandlers {
  busy: Set<string>
  onToggle: (t: TaskWithLead, done: boolean) => Promise<void>
  onPatch: (t: TaskWithLead, body: Record<string, unknown>) => Promise<void>
  members: string[]
}

// One container, not cards inside cards: the group IS the panel and the tasks
// are rows separated by hairlines.
function Group({ title, tone, tasks, empty, byDay, ...handlers }: {
  title: string
  tone: 'overdue' | 'today' | 'upcoming'
  tasks: TaskWithLead[]
  empty: string
  byDay?: boolean
} & RowHandlers) {
  const badge = tone === 'overdue'
    ? 'bg-red-100 text-red-700 border-red-300'
    : tone === 'today'
      ? 'bg-amber-100 text-amber-700 border-amber-300'
      : 'bg-gray-200 text-gray-700 border-gray-300'

  // An empty section is one quiet line, not a block the size of two real tasks.
  if (tasks.length === 0) {
    return (
      <p className="flex items-center gap-1.5 px-1 text-[11px] text-gray-400">
        <span className="font-semibold uppercase tracking-wider">{title}</span>
        <span className="text-gray-300" aria-hidden>·</span>
        {empty}
      </p>
    )
  }

  const days = byDay ? groupByDay(tasks) : null

  return (
    <Panel>
      <header className="flex items-center gap-1.5 px-3 py-1.5 border-b border-gray-100">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
        <span className={`text-[10px] font-semibold px-1.5 rounded-full border tabular-nums ${badge}`}>{tasks.length}</span>
      </header>
      {days ? (
        days.map(([label, list]) => (
          <div key={label}>
            <p className="flex items-center gap-2 px-3 py-1 bg-gray-100/60">
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 shrink-0">{label}</span>
              <span className="flex-1 h-px bg-gray-200" />
              <span className="text-[10px] text-gray-400 tabular-nums shrink-0">{list.length}</span>
            </p>
            <ul className="divide-y divide-gray-100">
              {list.map((t) => <Row key={t.id} task={t} {...handlers} />)}
            </ul>
          </div>
        ))
      ) : (
        <ul className="divide-y divide-gray-100">
          {tasks.map((t) => <Row key={t.id} task={t} {...handlers} />)}
        </ul>
      )}
    </Panel>
  )
}

/** Upcoming, split into Karachi days with a friendly label per day. */
function groupByDay(tasks: TaskWithLead[]): [string, TaskWithLead[]][] {
  const map = new Map<string, { label: string; list: TaskWithLead[] }>()
  for (const t of tasks) {
    const key = pktDayKey(t.due_at)
    let e = map.get(key)
    if (!e) { e = { label: dateDividerLabel(t.due_at), list: [] }; map.set(key, e) }
    e.list.push(t)
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => [v.label, v.list] as [string, TaskWithLead[]])
}

// ── One task ─────────────────────────────────────────────────────────────────
// Scanning order: what to do (title) → when (due) → who for (lead) → where
// (site) → who owns it. The title is the only thing at full weight; everything
// else is metadata, so the eye lands on the work rather than the chrome.
//
// Overdue is carried by a red left rule, a red due time and an icon — not by
// painting the whole row red, which drowns out the title it is meant to flag.
function Row({ task, busy, onToggle, onPatch, members }: { task: TaskWithLead } & RowHandlers) {
  const [editingDue, setEditingDue] = useState(false)
  const isBusy = busy.has(task.id)
  const done = task.status === 'done'
  const overdue = !done && task.bucket === 'overdue'
  const TypeIcon = TASK_ICON[task.type]
  const parts = pktPartsOf(task.due_at)

  return (
    <li
      style={overdue ? { boxShadow: 'inset 3px 0 0 #ef4444' } : undefined}
      className={`group/row flex items-center gap-2 px-3 py-1.5 transition-colors hover:bg-gray-100 ${isBusy ? 'opacity-50' : ''}`}>

      <button onClick={() => onToggle(task, !done)} disabled={isBusy}
        title={done ? 'Mark as not done' : 'Mark as done'}
        aria-label={done ? `Reopen: ${task.title}` : `Complete: ${task.title}`}
        className={`w-4 h-4 shrink-0 rounded-full border flex items-center justify-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          done
            ? 'bg-green-100 border-green-300 text-green-700'
            : 'bg-white border-gray-300 text-transparent hover:border-green-500 hover:text-green-500 cursor-pointer'
        }`}>
        <Check size={10} strokeWidth={3} aria-hidden />
      </button>

      {/* what — the thing being scanned for */}
      <span className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className={`text-xs truncate ${done ? 'text-gray-500 line-through' : 'text-gray-900 font-medium'}`}
          title={task.title}>
          {task.title}
        </span>
        <span className={`shrink-0 inline-flex items-center gap-0.5 text-[9px] font-medium px-1 rounded border ${TASK_TYPE_STYLE[task.type]}`}>
          <TypeIcon size={8} strokeWidth={2.5} aria-hidden />
          <span className="hidden sm:inline">{TASK_TYPE_LABEL[task.type]}</span>
        </span>
      </span>

      {/* who for / where / when created — this is what tells two identical
          titles apart, so a duplicate is never ambiguous. */}
      <span className="hidden md:flex items-center gap-1.5 min-w-0 w-[300px] shrink-0">
        <Link href={`/leads/${encodeURIComponent(task.leadId)}`}
          className="text-[11px] text-gray-700 hover:text-blue-700 hover:underline truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          title={`${task.leadName} · ${task.siteName}`}>
          {task.leadName}
        </Link>
        <span className="text-[10px] text-gray-400 truncate shrink-0 max-w-[104px]">{task.siteName}</span>
        <span className="ml-auto text-[10px] text-gray-400 tabular-nums shrink-0"
          title={`Task created ${formatDateTime(task.created_at)}`}>
          {formatShortDate(task.created_at)}
        </span>
      </span>

      {/* when */}
      {editingDue ? (
        <span className="flex items-center gap-1 shrink-0">
          <input type="date" defaultValue={parts?.date} aria-label="New due date" autoFocus
            onKeyDown={(e) => { if (e.key === 'Escape') setEditingDue(false) }}
            onChange={(e) => {
              if (!e.target.value) return
              setEditingDue(false)
              onPatch(task, { dueDate: e.target.value, dueTime: parts?.time ?? '10:00' })
            }}
            className="bg-gray-100 border border-blue-500 rounded px-1 py-0.5 text-[10px] text-gray-900 tabular-nums focus:outline-none" />
          <button onClick={() => setEditingDue(false)} aria-label="Cancel"
            className="p-0.5 rounded text-gray-400 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            <X size={11} strokeWidth={2.5} aria-hidden />
          </button>
        </span>
      ) : (
        // Narrower on a phone so the title keeps the width it needs.
        <span className={`shrink-0 inline-flex items-center justify-end gap-1 text-[10px] tabular-nums w-[96px] sm:w-[124px] ${
          overdue ? 'text-red-700 font-semibold' : done ? 'text-gray-400' : 'text-gray-500'
        }`} title={formatDateTime(task.due_at)}>
          {overdue && <AlertTriangle size={9} strokeWidth={2.5} aria-hidden />}
          {formatDueLabel(task.due_at)}
        </span>
      )}

      {/* who owns it */}
      <span className="hidden lg:block text-[10px] text-gray-400 truncate w-[72px] shrink-0 text-right">
        {task.assignee ? task.assignee.split('@')[0] : 'Unassigned'}
      </span>

      {/* Actions. Always in the DOM so they are Tab-reachable; only opacity
          changes, so the row never shifts when they appear. */}
      <span className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
        <Link href={`/leads/${encodeURIComponent(task.leadId)}`} title="Open the lead"
          aria-label={`Open the lead for ${task.title}`}
          className="p-1 rounded text-gray-400 hover:text-blue-700 hover:bg-gray-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          <ExternalLink size={11} strokeWidth={2} aria-hidden />
        </Link>
        <button onClick={() => setEditingDue(true)} disabled={isBusy} title="Change the due date"
          aria-label={`Change the due date for ${task.title}`}
          className="p-1 rounded text-gray-400 hover:text-blue-700 hover:bg-gray-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          <CalendarClock size={11} strokeWidth={2} aria-hidden />
        </button>
        {/* A transparent native select over the icon: real keyboard behaviour,
            no custom menu to get wrong. */}
        <span className="relative inline-flex items-center p-1 rounded hover:bg-gray-200 transition-colors">
          <UserRound size={11} strokeWidth={2} className="text-gray-400 pointer-events-none" aria-hidden />
          <select value={task.assignee} disabled={isBusy} aria-label={`Reassign ${task.title}`}
            title="Reassign"
            onChange={(e) => { if (e.target.value !== task.assignee) onPatch(task, { assignee: e.target.value }) }}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            {!members.includes(task.assignee) && <option value={task.assignee}>{task.assignee.split('@')[0] || '—'}</option>}
            {members.map((m) => <option key={m} value={m}>{m.split('@')[0]}</option>)}
          </select>
        </span>
      </span>
    </li>
  )
}

function Filter({ label, value, onChange, options, active }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  active?: boolean
}) {
  return (
    <label className="flex items-center gap-1" title={label}>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className={`rounded-md px-1.5 py-0.5 text-[10px] cursor-pointer border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 max-w-[140px] ${
          active ? 'bg-blue-100 border-blue-500 text-blue-700 font-semibold' : 'bg-gray-100 border-gray-300 text-gray-600'
        }`}>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-white text-gray-800 font-normal">{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1].map((g) => (
        <section key={g} className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="px-3 py-1.5 border-b border-gray-100"><div className="h-2.5 w-20 bg-gray-200 rounded animate-pulse" /></div>
          <div className="divide-y divide-gray-100">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                <div className="w-4 h-4 rounded-full bg-gray-200 animate-pulse shrink-0" />
                <div className="h-2.5 flex-1 bg-gray-200 rounded animate-pulse" />
                <div className="h-2.5 w-24 bg-gray-200 rounded animate-pulse shrink-0" />
              </div>
            ))}
          </div>
        </section>
      ))}
      <span className="sr-only" role="status">Loading tasks…</span>
    </div>
  )
}
