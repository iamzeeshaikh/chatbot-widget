'use client'

// The global task queue — /tasks.
//
// Four groups in the order an agent actually works them: what is late, what is
// due today, what is coming, and (collapsed) what is finished. Buckets are
// computed server-side against Pakistan time, so an agent travelling or a
// browser in another zone still sees the same queue as everyone else.
//
// A member only ever receives tasks for sites they can access — enforced in the
// query behind /api/tasks, not by hiding rows here.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { formatDueLabel, timeAgo } from '@/lib/datetime'
import {
  TASK_TYPES, TASK_TYPE_LABEL, TASK_TYPE_ICON, TASK_TYPE_STYLE, type TaskType,
} from '@/lib/tasks'
import type { TaskWithLead, TaskGroups } from '@/lib/taskquery'

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

  // Same theme restore the record page does — a hard load of this route has to
  // re-apply the dashboard's dark class or it opens light.
  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode — default light */ }
  }, [])

  // Written as a promise chain rather than an `async` body on purpose: state
  // only ever moves inside a `.then`, never synchronously while the effect
  // below is running. Same shape as the record page's loader.
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

  // Optimistic completion: the task leaves its group immediately and is put
  // back if the write fails. The write goes to the LEAD's task endpoint, which
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

  const sites = data?.options.sites ?? []
  const assignees = useMemo(
    () => (data?.options.assignees ?? []).filter((a) => a),
    [data],
  )

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 py-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Link href="/" title="Back to the dashboard"
              className="shrink-0 px-2 py-1 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 transition-colors">
              ←
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-gray-900">Tasks &amp; follow-ups</h1>
              <p className="text-[11px] text-gray-500">
                {status === 'loading' ? 'Loading…' : `${openCount} open · due dates in Pakistan time`}
              </p>
            </div>
            {groups.overdue.length > 0 && (
              <span className="ml-auto text-[11px] font-semibold px-2 py-1 rounded-full bg-red-100 text-red-700 border border-red-300">
                {groups.overdue.length} overdue
              </span>
            )}
          </div>

          {/* ── Filters ── */}
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <Filter label="Assignee" value={assignee} onChange={setAssignee}
              options={[
                { value: 'me', label: 'Me' },
                { value: 'all', label: 'Everyone' },
                ...assignees.map((a) => ({ value: a, label: a.split('@')[0] })),
              ]} />
            <Filter label="Site" value={site} onChange={setSite}
              options={[{ value: '', label: 'All sites' }, ...sites.map((s) => ({ value: s.siteId, label: s.name }))]} />
            <Filter label="Type" value={type} onChange={(v) => setType(v as TaskType | 'all')}
              options={[
                { value: 'all', label: 'All types' },
                ...TASK_TYPES.map((t) => ({ value: t, label: `${TASK_TYPE_ICON[t]} ${TASK_TYPE_LABEL[t]}` })),
              ]} />
          </div>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto px-4 sm:px-6 py-5 space-y-4 animate-in">
        {error && (
          <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {status === 'loading' ? (
          <LoadingSkeleton />
        ) : status === 'error' ? (
          <Panel>
            <Empty icon="⚠️" title="Could not load your tasks"
              hint="Something went wrong on our side. Try again in a moment." />
          </Panel>
        ) : openCount === 0 && groups.completed.length === 0 ? (
          <Panel>
            <Empty icon="🎉" title="Nothing on your list"
              hint={assignee === 'me'
                ? 'Tasks you add from a lead record show up here. Open a lead and add a follow-up.'
                : 'No tasks match these filters. Try widening them.'} />
          </Panel>
        ) : (
          <>
            <Group title="Overdue" tone="overdue" tasks={groups.overdue} busy={busy} onToggle={toggle}
              emptyHint="Nothing is late — good." />
            <Group title="Due today" tone="today" tasks={groups.today} busy={busy} onToggle={toggle}
              emptyHint="Nothing else due today." />
            <Group title="Upcoming" tone="upcoming" tasks={groups.upcoming} busy={busy} onToggle={toggle}
              emptyHint="Nothing scheduled ahead." />

            {groups.completed.length > 0 && (
              <Panel>
                <button onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}
                  className="w-full flex items-center gap-2 px-4 py-3 text-xs font-semibold text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors rounded-2xl">
                  <span aria-hidden>{showDone ? '▾' : '▸'}</span>
                  Completed
                  <span className="text-[10px] font-normal text-gray-500">{groups.completed.length}</span>
                </button>
                {showDone && (
                  <ul className="px-2 pb-2 space-y-1">
                    {groups.completed.map((t) => (
                      <Row key={t.id} task={t} busy={busy.has(t.id)} onToggle={toggle} />
                    ))}
                  </ul>
                )}
              </Panel>
            )}
          </>
        )}
      </main>
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Panel({ children }: { children: React.ReactNode }) {
  return <section className="bg-white border border-gray-200 rounded-2xl shadow-sm">{children}</section>
}

function Filter({ label, value, onChange, options }: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-400">
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-white text-gray-800">{o.label}</option>
        ))}
      </select>
    </label>
  )
}

function Group({ title, tone, tasks, busy, onToggle, emptyHint }: {
  title: string
  tone: 'overdue' | 'today' | 'upcoming'
  tasks: TaskWithLead[]
  busy: Set<string>
  onToggle: (t: TaskWithLead, done: boolean) => Promise<void>
  emptyHint: string
}) {
  const badge = tone === 'overdue'
    ? 'bg-red-100 text-red-700 border-red-300'
    : tone === 'today'
      ? 'bg-amber-100 text-amber-700 border-amber-300'
      : 'bg-gray-200 text-gray-700 border-gray-300'

  return (
    <Panel>
      <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{title}</h2>
        <span className={`text-[10px] font-semibold px-1.5 py-px rounded-full border ${badge}`}>{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <p className="px-4 py-4 text-xs text-gray-500">{emptyHint}</p>
      ) : (
        <ul className="p-2 space-y-1">
          {tasks.map((t) => <Row key={t.id} task={t} busy={busy.has(t.id)} onToggle={onToggle} />)}
        </ul>
      )}
    </Panel>
  )
}

function Row({ task, busy, onToggle }: {
  task: TaskWithLead
  busy: boolean
  onToggle: (t: TaskWithLead, done: boolean) => Promise<void>
}) {
  const done = task.status === 'done'
  const overdue = !done && task.bucket === 'overdue'

  return (
    <li className={`flex items-start gap-2.5 rounded-xl px-2.5 py-2 border transition-colors ${
      overdue ? 'border-red-200 bg-red-50' : done ? 'border-transparent bg-gray-100' : 'border-gray-200 bg-white hover:bg-gray-100'
    } ${busy ? 'opacity-60' : ''}`}>
      <button onClick={() => onToggle(task, !done)} disabled={busy}
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
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <Link href={`/leads/${encodeURIComponent(task.leadId)}`}
            className="text-[11px] text-blue-700 hover:underline truncate max-w-[220px]">
            {task.leadName}
          </Link>
          <span className="text-[10px] px-1 py-px rounded bg-gray-200 border border-gray-300 text-gray-600 shrink-0">
            {task.siteName}
          </span>
          <span className="text-[10px] text-gray-400">·</span>
          <span className={`text-[10px] ${overdue ? 'text-red-700 font-semibold' : 'text-gray-500'}`}>
            {overdue ? '⚠ Overdue — ' : ''}{formatDueLabel(task.due_at)}
          </span>
          <span className="text-[10px] text-gray-400">·</span>
          <span className="text-[10px] text-gray-500">{task.assignee ? task.assignee.split('@')[0] : 'Unassigned'}</span>
          {done && task.completed_at && (
            <span className="text-[10px] text-green-700">· done {timeAgo(task.completed_at)}</span>
          )}
        </div>
      </div>
    </li>
  )
}

function Empty({ icon, title, hint }: { icon: string; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center text-center px-4 py-10">
      <div className="w-10 h-10 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-lg mb-2" aria-hidden>{icon}</div>
      <p className="text-sm font-medium text-gray-700">{title}</p>
      <p className="text-xs text-gray-500 mt-0.5 max-w-[300px]">{hint}</p>
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1, 2].map((g) => (
        <section key={g} className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 space-y-3">
          <div className="h-3 w-24 bg-gray-200 rounded animate-pulse" />
          {[0, 1].map((i) => (
            <div key={i} className="flex gap-3 items-start">
              <div className="w-4 h-4 rounded-full bg-gray-200 animate-pulse shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-2/3 bg-gray-200 rounded animate-pulse" />
                <div className="h-2.5 w-1/3 bg-gray-200 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </section>
      ))}
      <span className="sr-only" role="status">Loading tasks…</span>
    </div>
  )
}
