'use client'

// ZeeDesk: the task queue. Same endpoints and the same rules as the /tasks
// page of the other dashboard, behind a different face: a column of views
// with counts on the left, and the chosen view as a dense list on the right.
//
// The server decides everything that matters. Buckets (overdue / today /
// upcoming) are computed there against Pakistan time, site access is applied
// in the query, and due dates travel as Karachi wall-clock strings that the
// server converts. This file never works out whose task it is or when "today"
// ends.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bell, Check, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import {
  dateDividerLabel, formatDateTime, formatDueLabel, pktDateTimeToUtc, pktDayKey, pktDayKeyOffset, pktPartsOf, timeAgo,
} from '@/lib/datetime'
import { MAX_TASK_TITLE, TASK_TYPES, TASK_TYPE_LABEL, DEFAULT_DUE_TIME, type TaskType } from '@/lib/tasks'
import { LEAD_TIME_CHOICES, hourLabel, leadTimeLabel, type ReminderPrefs } from '@/lib/reminders'
import type { TaskGroups, TaskWithLead } from '@/lib/taskquery'
import {
  Avatar, BTN_DANGER, BTN_PLAIN, BTN_PRIMARY, Chip, Drawer, Empty, INPUT, LABEL, Notice, postJson, short,
  type ZdScreenProps,
} from '../ui'

interface TasksResponse {
  groups: TaskGroups
  total: number
  me: string
  options: { sites: { siteId: string; name: string }[]; assignees: string[]; members: string[] }
}
interface UnreadLead { leadId: string; siteId?: string; siteName?: string; count: number; from: string; subject?: string; snippet: string; at: string }

type ViewId = 'open' | 'overdue' | 'today' | 'upcoming' | 'completed' | 'replies'
type Status = 'loading' | 'ok' | 'error' | 'unavailable'

const EMPTY_GROUPS: TaskGroups = { overdue: [], today: [], upcoming: [], completed: [] }
const VIEW_TITLE: Record<ViewId, string> = {
  open: 'All open tasks',
  overdue: 'Overdue',
  today: 'Due today',
  upcoming: 'Upcoming',
  completed: 'Done',
  replies: 'Customer replies',
}
// The same cadence the original queue refreshes at: a shared list is less
// urgent than an open record, and each tick is one small request.
const REFRESH_MS = 45_000
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const SELECT = `${INPUT} cursor-pointer`
const OFFLINE = 'Could not reach the server. Check your connection and try again.'

/** One write. Resolves to an error message, or null when it worked. */
async function send(url: string, init: RequestInit, fallback: string): Promise<string | null> {
  try {
    const res = await fetch(url, init)
    if (res.status === 401) { window.location.href = '/login'; return 'Your session has ended. Sign in again.' }
    if (res.ok) return null
    const d = await res.json().catch(() => ({}))
    return typeof d?.error === 'string' && d.error ? d.error : fallback
  } catch {
    return OFFLINE
  }
}

const taskUrl = (leadId: string) => `/api/leads/${encodeURIComponent(leadId)}/tasks`
const who = (email: string | null | undefined) => short(email) || 'Unassigned'

export default function Tasks({ me, openLead }: ZdScreenProps) {
  const [data, setData] = useState<TasksResponse | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [view, setView] = useState<ViewId>('open')
  const [assignee, setAssignee] = useState('me')
  const [site, setSite] = useState('')
  const [type, setType] = useState<TaskType | 'all'>('all')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [editing, setEditing] = useState<TaskWithLead | null>(null)
  const [showReminders, setShowReminders] = useState(false)
  const [unread, setUnread] = useState<UnreadLead[]>([])

  const isAdmin = me.role === 'admin'
  const requestNo = useRef(0)
  const loaded = useRef(false)

  // State only ever moves inside a `.then`, never synchronously in an effect.
  // A slower answer to an older filter is dropped, so the list always matches
  // the filters on screen.
  const load = useCallback((): Promise<void> => {
    const mine = ++requestNo.current
    // With a list already on screen a failed reload keeps it and says so;
    // with nothing to show it becomes the error state.
    const failed = () => {
      if (loaded.current) setError('Could not refresh the list. What you see may be out of date.')
      else setStatus('error')
    }
    const qs = new URLSearchParams({ assignee, type })
    if (site) qs.set('site', site)
    return fetch(`/api/tasks?${qs.toString()}`)
      .then(async (res) => {
        if (mine !== requestNo.current) return
        if (res.status === 401) { window.location.href = '/login'; return }
        // The workspace does not carry tasks at all.
        if (res.status === 403) { setStatus('unavailable'); return }
        if (!res.ok) { failed(); return }
        const next: TasksResponse = await res.json()
        if (mine !== requestNo.current) return
        loaded.current = true
        setData(next)
        setStatus('ok')
      })
      .catch(() => { if (mine === requestNo.current) failed() })
  }, [assignee, site, type])

  // Customers who have written back and nobody has opened it yet. Rides on the
  // endpoint the rail badge already uses.
  const loadUnread = useCallback((): Promise<void> => fetch('/api/tasks/count')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d) setUnread(Array.isArray(d.unreadLeads) ? d.unreadLeads : []) })
    .catch(() => { /* the task list is this screen's real job */ }), [])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadUnread() }, [loadUnread])

  // ── Live refresh ──────────────────────────────────────────────────────────
  // Ask the cheap "has anything changed?" marker and only reload the list when
  // it moves. Never while the tab is hidden, and never underneath an open
  // drawer: that refresh waits and lands when the drawer closes.
  const paused = !!editing || showReminders
  const pausedRef = useRef(paused)
  const pendingRef = useRef(false)
  const reloadRef = useRef<() => void>(() => {})
  useEffect(() => { reloadRef.current = () => { load(); loadUnread() } }, [load, loadUnread])
  useEffect(() => {
    pausedRef.current = paused
    if (!paused && pendingRef.current) { pendingRef.current = false; reloadRef.current() }
  }, [paused])
  useEffect(() => {
    let alive = true
    let seen: string | null = null
    const check = () => {
      if (document.hidden) return
      fetch('/api/crm/version')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const v: string | null = d?.crm ?? null
          if (!alive || v === null) return
          // The first answer is the baseline, not a change.
          if (seen === null) { seen = v; return }
          if (v === seen) return
          seen = v
          if (pausedRef.current) pendingRef.current = true
          else reloadRef.current()
        })
        .catch(() => { /* a missed check is harmless; the next one catches up */ })
    }
    check()
    const timer = setInterval(check, REFRESH_MS)
    const onVisible = () => { if (!document.hidden) check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  const refreshNow = useCallback(() => {
    setError('')
    setRefreshing(true)
    Promise.all([load(), loadUnread()]).finally(() => setRefreshing(false))
  }, [load, loadUnread])

  const markBusy = useCallback((id: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id); else next.delete(id)
      return next
    })
  }, [])

  // Complete / reopen. The row moves at once and is put back if the write
  // fails. The write goes to the lead's own task endpoint, which re-checks
  // that this member may touch that lead.
  const toggle = useCallback(async (task: TaskWithLead, done: boolean) => {
    setError('')
    markBusy(task.id, true)
    const snapshot = data
    setData((d) => {
      if (!d) return d
      const strip = (list: TaskWithLead[]) => list.filter((t) => t.id !== task.id)
      const moved: TaskWithLead = { ...task, status: done ? 'done' : 'open' }
      const g = d.groups
      return {
        ...d,
        groups: done
          ? { overdue: strip(g.overdue), today: strip(g.today), upcoming: strip(g.upcoming), completed: [moved, ...g.completed] }
          : { ...g, completed: strip(g.completed), [task.bucket]: [moved, ...g[task.bucket]] },
      }
    })
    const failed = await send(taskUrl(task.leadId), postJson({ taskId: task.id, status: done ? 'done' : 'open' }, 'PATCH'), 'Could not update the task.')
    if (failed) {
      if (snapshot) setData(snapshot)
      setError(`${failed} "${task.title}" was put back.`)
    } else {
      await load()
    }
    markBusy(task.id, false)
  }, [data, load, markBusy])

  const groups = data?.groups ?? EMPTY_GROUPS
  const sites = data?.options.sites ?? []
  const members = data?.options.members ?? []
  const assignees = useMemo(() => (data?.options.assignees ?? []).filter(Boolean), [data])
  const openCount = groups.overdue.length + groups.today.length + groups.upcoming.length
  const unreadCount = unread.reduce((n, u) => n + u.count, 0)
  const filtersOn = assignee !== 'me' || !!site || type !== 'all'
  const counts: Record<ViewId, number> = {
    open: openCount,
    overdue: groups.overdue.length,
    today: groups.today.length,
    upcoming: groups.upcoming.length,
    completed: groups.completed.length,
    replies: unreadCount,
  }
  const scope = assignee === 'me' ? 'Assigned to you' : assignee === 'all' ? 'Everyone' : `Assigned to ${who(assignee)}`
  const sub = view === 'replies'
    ? 'Leads where the customer wrote back and nobody has opened it yet'
    : status === 'loading' ? 'Loading tasks' : `${scope} · due times are Pakistan time`

  const rowProps = { busy, onToggle: toggle, onEdit: setEditing, openLead }
  const emptyText = filtersOn ? 'No tasks match these filters.' : null

  let body: React.ReactNode
  if (view === 'replies') {
    body = unread.length === 0
      ? <Empty text="No unread customer replies. When a customer answers an email, the lead shows up here." />
      : (
        <ul className="rounded-lg border border-[#d8dcde] overflow-hidden divide-y divide-[#e9ebed]">
          {unread.map((u) => (
            <li key={u.leadId}>
              <button type="button" onClick={() => openLead(u.leadId)}
                className="w-full text-left px-4 py-2.5 hover:bg-[#edf7ff] outline-none focus-visible:bg-[#edf7ff]">
                <span className="flex items-center gap-2 min-w-0">
                  <Avatar label={u.from} size={24} />
                  <span className="font-medium truncate">{u.from}</span>
                  {u.siteName && <Chip>{u.siteName}</Chip>}
                  {u.count > 1 && <Chip tone="blue">{u.count} replies</Chip>}
                  <span className="ml-auto shrink-0 text-[12px] text-[#87929d] tabular-nums" title={formatDateTime(u.at)}>{timeAgo(u.at)}</span>
                </span>
                <span className="mt-0.5 flex items-baseline gap-2 min-w-0 pl-8">
                  {u.subject && <span className="shrink-0 max-w-[45%] truncate text-[#2f3941]">{u.subject}</span>}
                  <span className="truncate text-[#68737d] min-w-0">{u.snippet}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )
  } else if (status === 'loading') {
    body = <LoadingRows />
  } else if (status === 'unavailable') {
    body = <Empty text="Tasks are not available for this workspace." />
  } else if (status === 'error') {
    body = (
      <div className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] px-5 py-8 text-center">
        <p className="text-[13px] text-[#68737d] mb-3">Could not load the tasks.</p>
        <button type="button" className={BTN_PLAIN} onClick={refreshNow} disabled={refreshing}>
          <RefreshCw size={14} aria-hidden /> Try again
        </button>
      </div>
    )
  } else if (view === 'open') {
    body = openCount === 0
      ? <Empty text={emptyText ?? 'Nothing open. Tasks added on a lead show up here.'} />
      : (
        <div className="space-y-5">
          <Section title="Overdue" tone="red" tasks={groups.overdue} {...rowProps} />
          <Section title="Due today" tone="amber" tasks={groups.today} {...rowProps} />
          <Section title="Upcoming" tone="grey" tasks={groups.upcoming} byDay {...rowProps} />
        </div>
      )
  } else if (view === 'overdue') {
    body = groups.overdue.length === 0
      ? <Empty text={emptyText ?? 'Nothing is late.'} />
      : <Section title="Overdue" tone="red" tasks={groups.overdue} {...rowProps} />
  } else if (view === 'today') {
    body = groups.today.length === 0
      ? <Empty text={emptyText ?? 'Nothing else is due today.'} />
      : <Section title="Due today" tone="amber" tasks={groups.today} {...rowProps} />
  } else if (view === 'upcoming') {
    body = groups.upcoming.length === 0
      ? <Empty text={emptyText ?? 'Nothing is scheduled ahead.'} />
      : <Section title="Upcoming" tone="grey" tasks={groups.upcoming} byDay {...rowProps} />
  } else {
    body = groups.completed.length === 0
      ? <Empty text={emptyText ?? 'No finished tasks yet.'} />
      : <Section title="Done" tone="green" tasks={groups.completed} note="The 100 most recently finished" {...rowProps} />
  }

  const viewIds: ViewId[] = ['open', 'overdue', 'today', 'upcoming', 'completed', 'replies']

  return (
    <main className="flex-1 min-w-0 h-full flex bg-white text-[13px] text-[#2f3941]">
      {/* Views and filters */}
      <aside className="hidden md:flex w-[280px] shrink-0 flex-col border-r border-[#d8dcde] bg-[#f8f9f9] overflow-y-auto [scrollbar-width:thin]" aria-label="Task views and filters">
        <div className="h-[56px] shrink-0 px-5 flex items-center border-b border-[#d8dcde]">
          <h1 className="text-[15px] font-semibold">Tasks</h1>
        </div>
        <nav className="px-2 py-3" aria-label="Views">
          <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">Views</p>
          {viewIds.map((id) => {
            const active = view === id
            const n = counts[id]
            const hot = id === 'overdue' && n > 0
            return (
              <button key={id} type="button" onClick={() => setView(id)} aria-current={active ? 'page' : undefined}
                className={`w-full h-8 px-3 rounded-md flex items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${active ? 'bg-[#edf7ff] text-[#144a75] font-semibold' : 'hover:bg-[#e9ebed]'} ${id === 'replies' ? 'mt-2' : ''}`}>
                <span className="truncate">{VIEW_TITLE[id]}</span>
                <span className={`ml-auto tabular-nums text-[12px] ${hot ? 'text-[#cc3340] font-semibold' : active ? 'text-[#144a75]' : 'text-[#68737d]'}`}>
                  {status === 'loading' && id !== 'replies' ? '' : n}
                </span>
              </button>
            )
          })}
        </nav>
        <div className="px-5 py-4 border-t border-[#d8dcde] space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">Filters</p>
          <Filters assignee={assignee} setAssignee={setAssignee} site={site} setSite={setSite} type={type} setType={setType}
            assignees={assignees} sites={sites} idPrefix="zd-tasks-side" />
          {filtersOn && (
            <button type="button" className={BTN_PLAIN} onClick={() => { setAssignee('me'); setSite(''); setType('all') }}>
              Clear filters
            </button>
          )}
        </div>
      </aside>

      {/* The chosen view */}
      <section className="flex-1 min-w-0 flex flex-col" aria-label={VIEW_TITLE[view]}>
        <div className="shrink-0 px-6 py-3 border-b border-[#d8dcde] flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h2 className="text-[18px] font-semibold leading-6 flex items-center gap-2">
              {VIEW_TITLE[view]}
              {(status === 'ok' || view === 'replies') && <span className="text-[13px] font-normal text-[#68737d] tabular-nums">{counts[view]}</span>}
            </h2>
            <p className="text-[12px] text-[#68737d] truncate">{sub}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {groups.overdue.length > 0 && view !== 'overdue' && (
              <button type="button" onClick={() => setView('overdue')}
                className="h-8 px-2.5 rounded-md bg-[#fff0f1] text-[#cc3340] text-[12px] font-semibold inline-flex items-center gap-1.5 hover:bg-[#ffe0e3] outline-none focus-visible:ring-2 focus-visible:ring-[#cc3340]/40 tabular-nums">
                <AlertTriangle size={13} aria-hidden /> {groups.overdue.length} overdue
              </button>
            )}
            <button type="button" className={BTN_PLAIN} onClick={refreshNow} disabled={refreshing} aria-label="Refresh the list" title="Refresh the list">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden />
            </button>
            <button type="button" className={BTN_PLAIN} onClick={() => setShowReminders(true)} disabled={status === 'unavailable'}>
              <Bell size={14} aria-hidden /> Reminders
            </button>
          </div>
        </div>

        {/* Below the md breakpoint the side column is hidden; the same controls sit here. */}
        <div className="md:hidden shrink-0 px-6 py-3 border-b border-[#e9ebed] bg-[#f8f9f9] grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className={LABEL} htmlFor="zd-tasks-view">View</label>
            <select id="zd-tasks-view" className={SELECT} value={view} onChange={(e) => setView(e.target.value as ViewId)}>
              {viewIds.map((id) => <option key={id} value={id}>{VIEW_TITLE[id]} ({counts[id]})</option>)}
            </select>
          </div>
          <Filters assignee={assignee} setAssignee={setAssignee} site={site} setSite={setSite} type={type} setType={setType}
            assignees={assignees} sites={sites} idPrefix="zd-tasks-top" />
        </div>

        {error && (
          <div className="shrink-0 px-6 py-2 bg-[#fff0f1] border-b border-[#f5c2c7] flex items-center gap-3">
            <Notice text={error} bad />
            <button type="button" onClick={() => setError('')} className="ml-auto text-[12px] text-[#cc3340] underline outline-none focus-visible:ring-2 focus-visible:ring-[#cc3340]/40 rounded">Dismiss</button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 [scrollbar-width:thin]">{body}</div>
      </section>

      {editing && (
        <TaskEditor key={editing.id} task={editing} members={members} isAdmin={isAdmin} openLead={openLead}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }} />
      )}
      {showReminders && <ReminderDrawer onClose={() => setShowReminders(false)} />}
    </main>
  )
}

// ── Filters ──────────────────────────────────────────────────────────────────
function Filters({ assignee, setAssignee, site, setSite, type, setType, assignees, sites, idPrefix }: {
  assignee: string; setAssignee: (v: string) => void
  site: string; setSite: (v: string) => void
  type: TaskType | 'all'; setType: (v: TaskType | 'all') => void
  assignees: string[]; sites: { siteId: string; name: string }[]; idPrefix: string
}) {
  return (
    <>
      <div>
        <label className={LABEL} htmlFor={`${idPrefix}-assignee`}>Assigned to</label>
        <select id={`${idPrefix}-assignee`} className={SELECT} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="me">Me</option>
          <option value="all">Everyone</option>
          {/* A chosen colleague stays listed even when the filters leave them with nothing. */}
          {assignee !== 'me' && assignee !== 'all' && !assignees.includes(assignee) && <option value={assignee}>{who(assignee)}</option>}
          {assignees.map((a) => <option key={a} value={a}>{who(a)}</option>)}
        </select>
      </div>
      <div>
        <label className={LABEL} htmlFor={`${idPrefix}-type`}>Type</label>
        <select id={`${idPrefix}-type`} className={SELECT} value={type} onChange={(e) => setType(e.target.value as TaskType | 'all')}>
          <option value="all">All types</option>
          {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
        </select>
      </div>
      <div>
        <label className={LABEL} htmlFor={`${idPrefix}-site`}>Site</label>
        <select id={`${idPrefix}-site`} className={SELECT} value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.name}</option>)}
        </select>
      </div>
    </>
  )
}

// ── The list ─────────────────────────────────────────────────────────────────
interface RowHandlers {
  busy: Set<string>
  onToggle: (t: TaskWithLead, done: boolean) => void
  onEdit: (t: TaskWithLead) => void
  openLead: (recordId: string) => void
}

/** Upcoming, split into Karachi days so a week reads as a week. */
function groupByDay(tasks: TaskWithLead[]): [string, TaskWithLead[]][] {
  const map = new Map<string, { label: string; list: TaskWithLead[] }>()
  for (const t of tasks) {
    const key = pktDayKey(t.due_at) || 'none'
    let e = map.get(key)
    if (!e) { e = { label: key === 'none' ? 'No due date' : dateDividerLabel(t.due_at), list: [] }; map.set(key, e) }
    e.list.push(t)
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => [v.label, v.list])
}

function Section({ title, tone, tasks, byDay, note, ...handlers }: {
  title: string; tone: 'red' | 'amber' | 'grey' | 'green'; tasks: TaskWithLead[]; byDay?: boolean; note?: string
} & RowHandlers) {
  if (tasks.length === 0) return null
  const days = byDay ? groupByDay(tasks) : null
  return (
    <section aria-label={`${title}, ${tasks.length}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">{title}</h3>
        <Chip tone={tone}>{tasks.length}</Chip>
        {note && <span className="text-[12px] text-[#87929d]">{note}</span>}
      </div>
      <div className="rounded-lg border border-[#d8dcde] overflow-hidden">
        {days ? days.map(([label, list]) => (
          <div key={label}>
            <p className="px-4 py-1.5 bg-[#f8f9f9] border-b border-[#e9ebed] text-[12px] text-[#68737d] flex items-center">
              <span>{label}</span>
              <span className="ml-auto tabular-nums">{list.length}</span>
            </p>
            <ul className="divide-y divide-[#e9ebed] border-b border-[#e9ebed] last:border-b-0">
              {list.map((t) => <Row key={t.id} task={t} {...handlers} />)}
            </ul>
          </div>
        )) : (
          <ul className="divide-y divide-[#e9ebed]">
            {tasks.map((t) => <Row key={t.id} task={t} {...handlers} />)}
          </ul>
        )}
      </div>
    </section>
  )
}

function Row({ task, busy, onToggle, onEdit, openLead }: { task: TaskWithLead } & RowHandlers) {
  const isBusy = busy.has(task.id)
  const done = task.status === 'done'
  const dueTone = done ? 'grey' : task.bucket === 'overdue' ? 'red' : task.bucket === 'today' ? 'amber' : 'grey'
  const finished = task.completed_at ?? task.updated_at
  return (
    <li className={`group flex items-center gap-3 px-4 py-2 hover:bg-[#f8f9f9] ${isBusy ? 'opacity-50' : ''}`}>
      <button type="button" role="checkbox" aria-checked={done} disabled={isBusy}
        onClick={() => onToggle(task, !done)}
        aria-label={done ? `Reopen: ${task.title}` : `Mark done: ${task.title}`}
        title={done ? 'Reopen this task' : 'Mark as done'}
        className={`w-[18px] h-[18px] shrink-0 rounded-[4px] border flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${done ? 'bg-[#1f73b7] border-[#1f73b7] text-white' : 'bg-white border-[#87929d] text-transparent hover:border-[#1f73b7] hover:text-[#1f73b7]'}`}>
        <Check size={13} strokeWidth={3} aria-hidden />
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" onClick={() => onEdit(task)} title={task.title}
            className={`min-w-0 truncate text-left outline-none rounded focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 hover:text-[#1f73b7] ${done ? 'text-[#68737d] line-through' : 'font-medium text-[#2f3941]'}`}>
            {task.title}
          </button>
          <span className="shrink-0"><Chip>{TASK_TYPE_LABEL[task.type]}</Chip></span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0 text-[12px] text-[#68737d]">
          <button type="button" onClick={() => openLead(task.leadId)} title={`Open the lead: ${task.leadName}`}
            className="min-w-0 truncate text-[#1f73b7] hover:underline outline-none rounded focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
            {task.leadName}
          </button>
          <span aria-hidden>·</span>
          <span className="truncate shrink-0 max-w-[160px]">{task.siteName}</span>
          {done && finished && (
            <span className="hidden sm:inline truncate" title={formatDateTime(finished)}>
              <span aria-hidden>· </span>finished {timeAgo(finished)}{task.completed_by ? ` by ${who(task.completed_by)}` : ''}
            </span>
          )}
        </div>
      </div>

      <span className="shrink-0 tabular-nums" title={`Due ${formatDateTime(task.due_at)} (Pakistan time)`}>
        <Chip tone={dueTone}>
          {!done && task.bucket === 'overdue' && <AlertTriangle size={11} className="inline -mt-0.5 mr-1" aria-hidden />}
          {!done && task.bucket === 'overdue' && <span className="sr-only">Overdue: </span>}
          {formatDueLabel(task.due_at)}
        </Chip>
      </span>

      <span className="hidden lg:flex items-center gap-1.5 w-[132px] shrink-0 min-w-0" title={task.assignee || 'Nobody is assigned'}>
        {task.assignee ? <Avatar label={who(task.assignee)} tone="agent" size={22} /> : <span className="w-[22px] h-[22px] rounded-full border border-dashed border-[#87929d] shrink-0" aria-hidden />}
        <span className="truncate text-[12px] text-[#49545c]">{who(task.assignee)}</span>
      </span>

      <button type="button" onClick={() => onEdit(task)} disabled={isBusy} aria-label={`Edit: ${task.title}`} title="Edit this task"
        className="w-8 h-8 shrink-0 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed] hover:text-[#2f3941] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
        <Pencil size={14} aria-hidden />
      </button>
    </li>
  )
}

function LoadingRows() {
  return (
    <div className="rounded-lg border border-[#d8dcde] overflow-hidden divide-y divide-[#e9ebed]">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <span className="w-[18px] h-[18px] rounded-[4px] bg-[#e9ebed] animate-pulse shrink-0" />
          <span className="h-3 flex-1 rounded bg-[#e9ebed] animate-pulse" />
          <span className="h-3 w-28 rounded bg-[#e9ebed] animate-pulse shrink-0" />
        </div>
      ))}
      <span className="sr-only" role="status">Loading tasks</span>
    </div>
  )
}

// ── Edit one task ────────────────────────────────────────────────────────────
// Only what actually changed is sent. That matters for a member who may not
// see customer contacts: their copy of a title can arrive with an address
// masked, and posting it back untouched would overwrite the real one.
function TaskEditor({ task, members, isAdmin, openLead, onClose, onSaved }: {
  task: TaskWithLead; members: string[]; isAdmin: boolean
  openLead: (recordId: string) => void; onClose: () => void; onSaved: () => void
}) {
  const parts = pktPartsOf(task.due_at)
  const [title, setTitle] = useState(task.title)
  const [type, setType] = useState<TaskType>(task.type)
  const [date, setDate] = useState(parts?.date ?? '')
  const [time, setTime] = useState(parts?.time ?? DEFAULT_DUE_TIME)
  const [assignee, setAssignee] = useState(task.assignee)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')

  const dueAt = pktDateTimeToUtc(date, time)
  const dueChanged = date !== (parts?.date ?? '') || time !== (parts?.time ?? DEFAULT_DUE_TIME)
  const changes: Record<string, unknown> = {}
  if (title.trim() !== task.title.trim()) changes.title = title.trim()
  if (type !== task.type) changes.type = type
  if (dueChanged) { changes.dueDate = date; changes.dueTime = time }
  if (assignee !== task.assignee) changes.assignee = assignee
  const dirty = Object.keys(changes).length > 0
  const done = task.status === 'done'

  const save = async () => {
    if (!title.trim()) { setError('Give the task a title.'); return }
    if (dueChanged && !dueAt) { setError('Pick a due date and a time.'); return }
    if (!dirty) { onClose(); return }
    setError('')
    setSaving(true)
    const failed = await send(taskUrl(task.leadId), postJson({ taskId: task.id, ...changes }, 'PATCH'), 'Could not save the task.')
    setSaving(false)
    if (failed) setError(failed); else onSaved()
  }

  const setStatus = async (status: 'done' | 'open') => {
    setError('')
    setSaving(true)
    const failed = await send(taskUrl(task.leadId), postJson({ taskId: task.id, status }, 'PATCH'), 'Could not update the task.')
    setSaving(false)
    if (failed) setError(failed); else onSaved()
  }

  const remove = async () => {
    setError('')
    setSaving(true)
    const failed = await send(taskUrl(task.leadId), postJson({ taskId: task.id }, 'DELETE'), 'Could not delete the task.')
    setSaving(false)
    if (failed) { setError(failed); setConfirmDelete(false) } else onSaved()
  }

  const shortcut = (days: number) => { setDate(pktDayKeyOffset(days)); if (!time) setTime(DEFAULT_DUE_TIME) }

  const footer = confirmDelete ? (
    <>
      <p className="mr-auto text-[13px] text-[#2f3941]" role="alert">Delete this task for everyone?</p>
      <button type="button" className={BTN_PLAIN} onClick={() => setConfirmDelete(false)} disabled={saving}>Keep it</button>
      <button type="button" className={BTN_DANGER} onClick={remove} disabled={saving}><Trash2 size={14} aria-hidden /> {saving ? 'Deleting' : 'Delete task'}</button>
    </>
  ) : (
    <>
      {isAdmin && (
        <button type="button" className={`${BTN_DANGER} mr-auto`} onClick={() => setConfirmDelete(true)} disabled={saving}>
          <Trash2 size={14} aria-hidden /> Delete
        </button>
      )}
      <button type="button" className={BTN_PLAIN} onClick={onClose} disabled={saving}>Cancel</button>
      <button type="button" className={BTN_PRIMARY} onClick={save} disabled={saving || !dirty}>{saving ? 'Saving' : 'Save changes'}</button>
    </>
  )

  return (
    <Drawer title="Edit task" onClose={onClose} footer={footer}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save() }}>
        <div className="rounded-lg border border-[#d8dcde] bg-[#f8f9f9] px-3 py-2.5 flex items-center gap-2.5">
          <Avatar label={task.leadName} size={28} />
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{task.leadName}</p>
            <p className="text-[12px] text-[#68737d] truncate">{task.siteName}</p>
          </div>
          <button type="button" className={BTN_PLAIN} onClick={() => openLead(task.leadId)}>Open lead</button>
        </div>

        <div>
          <label className={LABEL} htmlFor="zd-task-title">Title</label>
          <input id="zd-task-title" className={INPUT} value={title} maxLength={MAX_TASK_TITLE} autoFocus
            onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL} htmlFor="zd-task-type">Type</label>
            <select id="zd-task-type" className={SELECT} value={type} onChange={(e) => setType(e.target.value as TaskType)}>
              {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="zd-task-assignee">Assigned to</label>
            <select id="zd-task-assignee" className={SELECT} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {!members.includes(task.assignee) && <option value={task.assignee}>{who(task.assignee)}</option>}
              {members.map((m) => <option key={m} value={m}>{who(m)}</option>)}
            </select>
          </div>
        </div>

        <fieldset>
          <legend className={LABEL}>Due (Pakistan time)</legend>
          <div className="grid grid-cols-2 gap-3">
            <input type="date" aria-label="Due date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} />
            <input type="time" aria-label="Due time" className={INPUT} value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Move the due date">
            {([['Today', 0], ['Tomorrow', 1], ['In 3 days', 3], ['In a week', 7]] as const).map(([label, days]) => (
              <button key={label} type="button" onClick={() => shortcut(days)}
                className="h-7 px-2.5 rounded-md border border-[#d8dcde] bg-white text-[12px] hover:bg-[#f8f9f9] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
                {label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-[#68737d]">
            {dueAt ? `Due ${formatDueLabel(dueAt)}` : 'Pick a date and a time.'}
          </p>
        </fieldset>

        <Notice text={error} bad />

        <div className="pt-3 border-t border-[#e9ebed] space-y-2">
          <div className="flex items-center gap-2">
            <Chip tone={done ? 'green' : task.bucket === 'overdue' ? 'red' : task.bucket === 'today' ? 'amber' : 'grey'}>
              {done ? 'Done' : task.bucket === 'overdue' ? 'Overdue' : task.bucket === 'today' ? 'Due today' : 'Upcoming'}
            </Chip>
            <button type="button" className={`${BTN_PLAIN} ml-auto`} disabled={saving} onClick={() => setStatus(done ? 'open' : 'done')}>
              <Check size={14} aria-hidden /> {done ? 'Reopen task' : 'Mark as done'}
            </button>
          </div>
          <dl className="text-[12px] text-[#68737d] space-y-0.5">
            <div><dt className="inline">Created </dt><dd className="inline">{formatDateTime(task.created_at)}{task.created_by ? ` by ${who(task.created_by)}` : ''}</dd></div>
            {task.updated_at && <div><dt className="inline">Last changed </dt><dd className="inline">{formatDateTime(task.updated_at)}{task.updated_by ? ` by ${who(task.updated_by)}` : ''}</dd></div>}
            {done && task.completed_at && <div><dt className="inline">Finished </dt><dd className="inline">{formatDateTime(task.completed_at)}{task.completed_by ? ` by ${who(task.completed_by)}` : ''}</dd></div>}
          </dl>
        </div>
      </form>
    </Drawer>
  )
}

// ── Reminder settings ────────────────────────────────────────────────────────
// A member's own preferences, saved on change. Each control moves at once and
// goes back if the server refuses it. Hours are Karachi hours.
function ReminderDrawer({ onClose }: { onClose: () => void }) {
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

  const save = async (patch: Partial<ReminderPrefs>) => {
    if (!prefs) return
    const previous = prefs
    setPrefs({ ...prefs, ...patch })
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/tasks/prefs', postJson(patch))
      if (res.status === 401) { window.location.href = '/login'; return }
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d?.error === 'string' && d.error ? d.error : 'Could not save that setting.')
      if (d?.prefs) setPrefs(d.prefs)
    } catch (err) {
      setPrefs(previous)
      setError(`${err instanceof TypeError ? OFFLINE : err instanceof Error ? err.message : 'Could not save that setting.'} It was put back.`)
    } finally {
      setSaving(false)
    }
  }

  const quietOff = !!prefs && prefs.quietStart === prefs.quietEnd
  const hourSelect = (id: string, label: string, value: number, key: 'digestHour' | 'quietStart' | 'quietEnd', disabled?: boolean) => (
    <select id={id} aria-label={label} className={`${SELECT} max-w-[140px]`} value={value} disabled={disabled}
      onChange={(e) => save({ [key]: Number(e.target.value) })}>
      {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
    </select>
  )

  return (
    <Drawer title="Reminder settings" onClose={onClose}
      footer={<><span className="mr-auto"><Notice text={saving ? 'Saving' : status === 'ok' ? 'Changes save as you make them.' : ''} /></span><button type="button" className={BTN_PLAIN} onClick={onClose}>Close</button></>}>
      {status === 'loading' ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 rounded-md bg-[#e9ebed] animate-pulse" />)}
          <span className="sr-only" role="status">Loading your reminder settings</span>
        </div>
      ) : status === 'error' || !prefs ? (
        <Empty text="Could not load your reminder settings. Close this panel and try again in a moment." />
      ) : (
        <div className="space-y-5">
          <Notice text={error} bad />

          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0 accent-[#1f73b7] cursor-pointer" checked={prefs.enabled}
              onChange={(e) => save({ enabled: e.target.checked })} />
            <span>
              <span className="block font-medium">Task reminders</span>
              <span className="block text-[12px] text-[#68737d]">A notification at the due time, and one before it.</span>
            </span>
          </label>
          <div className={prefs.enabled ? '' : 'opacity-50'}>
            <label className={LABEL} htmlFor="zd-rem-lead">Early reminder</label>
            <select id="zd-rem-lead" className={`${SELECT} max-w-[220px]`} value={prefs.leadMinutes} disabled={!prefs.enabled}
              onChange={(e) => save({ leadMinutes: Number(e.target.value) })}>
              {LEAD_TIME_CHOICES.map((m) => <option key={m} value={m}>{leadTimeLabel(m)}</option>)}
            </select>
          </div>

          <hr className="border-[#e9ebed]" />

          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-0.5 w-4 h-4 shrink-0 accent-[#1f73b7] cursor-pointer" checked={prefs.digestEnabled}
              onChange={(e) => save({ digestEnabled: e.target.checked })} />
            <span>
              <span className="block font-medium">Daily digest</span>
              <span className="block text-[12px] text-[#68737d]">One summary of what is overdue and due today.</span>
            </span>
          </label>
          <div className={prefs.digestEnabled ? '' : 'opacity-50'}>
            <label className={LABEL} htmlFor="zd-rem-digest">Send the digest at (Pakistan time)</label>
            {hourSelect('zd-rem-digest', 'Digest hour', prefs.digestHour, 'digestHour', !prefs.digestEnabled)}
          </div>

          <hr className="border-[#e9ebed]" />

          <fieldset>
            <legend className="font-medium">Quiet hours (Pakistan time)</legend>
            <p className="text-[12px] text-[#68737d] mb-2">Nothing arrives in this window. Anything that comes due is held and delivered when the window ends.</p>
            <div className="flex items-center gap-2">
              {hourSelect('zd-rem-qs', 'Quiet hours start', prefs.quietStart, 'quietStart')}
              <span className="text-[12px] text-[#68737d]">to</span>
              {hourSelect('zd-rem-qe', 'Quiet hours end', prefs.quietEnd, 'quietEnd')}
            </div>
            {quietOff && <p className="mt-2 text-[12px] text-[#ad5918]">Start and end are the same, so quiet hours are off and reminders can arrive at any time.</p>}
          </fieldset>

          <p className="text-[12px] text-[#68737d] pt-1">{summarize(prefs)}</p>
        </div>
      )}
    </Drawer>
  )
}

function summarize(p: ReminderPrefs): string {
  if (!p.enabled && !p.digestEnabled) return 'All reminders are off. You will not be notified about tasks.'
  const bits: string[] = []
  if (p.enabled) {
    bits.push(p.leadMinutes > 0
      ? `Reminders at the due time and ${leadTimeLabel(p.leadMinutes).replace(' before', '')} before`
      : 'Reminders at the due time')
  }
  if (p.digestEnabled) bits.push(`${bits.length ? 'a' : 'A'} digest at ${hourLabel(p.digestHour)}`)
  const quiet = p.quietStart === p.quietEnd ? 'no quiet hours' : `held from ${hourLabel(p.quietStart)} to ${hourLabel(p.quietEnd)}`
  return `${bits.join(', ')}; ${quiet}.`
}
