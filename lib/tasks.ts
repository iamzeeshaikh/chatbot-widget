// Tasks & follow-ups — CRM state persisted WITHOUT any schema change (no DDL),
// as `crm_task` chat_logs control rows, exactly like crm_stage / crm_note.
//
//   crm_task — one row per REVISION of a task. The newest row carrying a given
//              task id is the task's current state; every older row is the
//              audit trail the activity timeline is built from. Completing,
//              reassigning, editing and deleting all append a new revision —
//              nothing is ever updated or removed in place.
//
// `crm_task` is registered in lib/crm.ts CRM_ROLES, which lib/controlroles.ts
// spreads into CONTROL_ROLES. That registration is what keeps its JSON out of
// the chat transcript, the conversation previews and the visitor widget — see
// the denylist note in lib/controlroles.ts, and do not skip it for a new role.
//
// Client-safe module (no supabase import) so the record page, the /tasks page
// and the API routes all share one definition of a task.

import { pktDayKey, pktDayKeyOffset, pktDateTimeToUtc } from './datetime'

export const CRM_TASK_ROLE = 'crm_task'

// ── Types ────────────────────────────────────────────────────────────────────
export const TASK_TYPES = ['call', 'email', 'follow_up', 'design', 'other'] as const
export type TaskType = (typeof TASK_TYPES)[number]

export function isTaskType(v: unknown): v is TaskType {
  return typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v)
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  call: 'Call',
  email: 'Email',
  follow_up: 'Follow-up',
  design: 'Design',
  other: 'Other',
}

// Same reasoning as CRM_STAGE_STYLE: these are the -100/-300/-700 Tailwind
// shades globals.css remaps for dark mode. A hand-picked hex would be the one
// thing that goes dark-on-dark when the theme is flipped.
export const TASK_TYPE_STYLE: Record<TaskType, string> = {
  call: 'bg-green-100 text-green-700 border-green-300',
  email: 'bg-blue-100 text-blue-700 border-blue-300',
  follow_up: 'bg-amber-100 text-amber-700 border-amber-300',
  design: 'bg-purple-100 text-purple-700 border-purple-300',
  other: 'bg-gray-200 text-gray-700 border-gray-300',
}

export type TaskStatus = 'open' | 'done'

export const MAX_TASK_TITLE = 200

// ── The row shape ────────────────────────────────────────────────────────────
export interface CrmTaskEntry {
  id: string
  title: string
  type: TaskType
  /** Due instant, ISO/UTC. Always built from Karachi wall-clock input. */
  due_at: string
  assignee: string
  status: TaskStatus
  created_by: string
  created_at: string
  updated_by?: string
  updated_at?: string
  completed_by?: string
  completed_at?: string
  /** Deletion is a new revision carrying this flag — the trail must survive. */
  deleted?: boolean
}

export function parseCrmTask(message: string | null | undefined): CrmTaskEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.id !== 'string' || !o.id) return null
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return {
      id: o.id,
      title: str(o.title),
      type: isTaskType(o.type) ? o.type : 'other',
      due_at: str(o.due_at),
      assignee: str(o.assignee),
      status: o.status === 'done' ? 'done' : 'open',
      created_by: str(o.created_by),
      created_at: str(o.created_at),
      updated_by: typeof o.updated_by === 'string' ? o.updated_by : undefined,
      updated_at: typeof o.updated_at === 'string' ? o.updated_at : undefined,
      completed_by: typeof o.completed_by === 'string' ? o.completed_by : undefined,
      completed_at: typeof o.completed_at === 'string' ? o.completed_at : undefined,
      deleted: o.deleted === true,
    }
  } catch {
    return null
  }
}

export function newTaskId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── Bucketing — the whole point of this feature ──────────────────────────────
// Computed against the current time in Asia/Karachi, never UTC and never the
// browser's zone. Two rules, in this order:
//
//   1. Anything whose due INSTANT has already passed is overdue. A task due at
//      9am is overdue by 3pm the same afternoon — that is what an agent means
//      by overdue, not "due on an earlier date".
//   2. Otherwise it is due today when its due instant falls on the same
//      KARACHI calendar day as now, and upcoming after that.
//
// Rule 2 is where UTC gets it wrong: a task due 2am PKT tomorrow is still
// "today" in UTC terms for five hours, and a task due 11pm PKT tonight would
// read as tomorrow in a browser sitting west of Karachi.
export type TaskBucket = 'overdue' | 'today' | 'upcoming'

export function taskBucket(dueAt: string | null | undefined, now: Date = new Date()): TaskBucket {
  if (!dueAt) return 'upcoming' // a task with no due date can never be late
  const due = new Date(dueAt)
  if (isNaN(due.getTime())) return 'upcoming'
  if (due.getTime() < now.getTime()) return 'overdue'
  return pktDayKey(due) === pktDayKey(now) ? 'today' : 'upcoming'
}

export function isOverdue(task: Pick<CrmTaskEntry, 'due_at' | 'status'>, now: Date = new Date()): boolean {
  return task.status === 'open' && taskBucket(task.due_at, now) === 'overdue'
}

/** Overdue + due-today, the number the navigation badge shows. */
export function needsAttentionCount(
  tasks: Pick<CrmTaskEntry, 'due_at' | 'status'>[],
  now: Date = new Date(),
): number {
  return tasks.filter((t) => {
    if (t.status !== 'open') return false
    const b = taskBucket(t.due_at, now)
    return b === 'overdue' || b === 'today'
  }).length
}

// ── Defaults ─────────────────────────────────────────────────────────────────
// Creating a task has to take seconds, so the form opens already valid:
// tomorrow at 10am Karachi time, assigned to whoever is logged in.
export const DEFAULT_DUE_TIME = '10:00'

export function defaultDueDate(now: Date = new Date()): string {
  return pktDayKeyOffset(1, now)
}

export function defaultDueAt(now: Date = new Date()): string {
  return pktDateTimeToUtc(defaultDueDate(now), DEFAULT_DUE_TIME) ?? new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
}

// ── Sorting ──────────────────────────────────────────────────────────────────
// Soonest first for anything still open — the next thing to do belongs at the
// top. Completed tasks read better most-recently-finished first.
export function byDueAsc(a: CrmTaskEntry, b: CrmTaskEntry): number {
  return new Date(a.due_at).getTime() - new Date(b.due_at).getTime()
}

export function byCompletedDesc(a: CrmTaskEntry, b: CrmTaskEntry): number {
  return new Date(b.completed_at ?? b.updated_at ?? b.created_at).getTime()
    - new Date(a.completed_at ?? a.updated_at ?? a.created_at).getTime()
}

// Reduce a stream of revisions (ascending by created_at) to current state.
// Shared by the record page and the global /tasks list so "newest row wins"
// is implemented exactly once.
export function collapseRevisions(
  rows: { message: string }[],
): Map<string, CrmTaskEntry> {
  const byId = new Map<string, CrmTaskEntry>()
  for (const r of rows) {
    const t = parseCrmTask(r.message)
    if (t) byId.set(t.id, t)
  }
  return byId
}
