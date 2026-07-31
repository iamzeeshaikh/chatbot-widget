// Server-side loader for the global /tasks view and the navigation badge.
//
// Site scope is applied IN THE QUERY, not after it: a member only ever receives
// tasks for the sites memberSites() grants them. That is the same rule
// guardLeadAccess enforces per-record, applied to a list.
//
// Load shape (the DB has been taken down once by an unbounded poll — see
// CLAUDE.md §6): the query filters on role + site_id, selects only the five
// columns needed, is windowed, and is capped. crm_task rows are a tiny slice of
// chat_logs, but the table has no index on `role`, so this must stay bounded
// and must not be polled hard.

import { supabase, fetchAllPages } from './supabase'
import { memberSites, type Member } from './auth'
import { CONTACT_ROLE } from './visitor'
import { LEAD_CAPTURE_ROLE } from './leadtracking'
import { isQuoteSessionId, quoteSessionId } from './quoteintake'
import {
  CRM_TASK_ROLE, parseCrmTask, taskBucket, byDueAsc, byCompletedDesc,
  type CrmTaskEntry, type TaskBucket, type TaskType,
} from './tasks'

// How far back to look for task ROWS. A task revision written more than this
// long ago is not surfaced — deliberately generous, because an open task from
// six months ago must still appear, unlike a chat message.
const TASK_WINDOW_DAYS = 400
const TASK_ROW_CAP = 8000

export interface TaskWithLead extends CrmTaskEntry {
  /** The record id — /leads/<leadId> opens it. */
  leadId: string
  siteId: string
  siteName: string
  leadName: string
  bucket: TaskBucket
}

export interface TaskFilters {
  assignee?: string
  siteId?: string
  type?: TaskType | 'all'
  /** 'me' is resolved against the member on the server, never trusted from the client. */
}

interface TaskRow {
  session_id: string
  site_id: string
  message: string
  created_at: string
}

// Every live task the member is allowed to see, newest revision per task id.
export async function loadMemberTasks(member: Member): Promise<TaskWithLead[]> {
  const allowed = memberSites(member)
  if (allowed.length === 0) return []

  const since = new Date(Date.now() - TASK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const rows = await fetchAllPages<TaskRow>(
    () => supabase
      .from('chat_logs')
      .select('session_id, site_id, message, created_at')
      .eq('role', CRM_TASK_ROLE)
      .in('site_id', allowed)
      .gte('created_at', since)
      .order('created_at', { ascending: true }),
    TASK_ROW_CAP)

  // Ascending → the last revision of each id wins, same rule as everywhere else.
  const byId = new Map<string, { task: CrmTaskEntry; sessionId: string; siteId: string }>()
  for (const r of rows) {
    const t = parseCrmTask(r.message)
    if (!t) continue
    byId.set(t.id, { task: t, sessionId: r.session_id, siteId: r.site_id })
  }

  const live = Array.from(byId.values()).filter((e) => !e.task.deleted)
  if (live.length === 0) return []

  const [siteNames, leadNames] = await Promise.all([
    loadSiteNames(),
    loadLeadNames(live.map((e) => e.sessionId)),
  ])

  const now = new Date()
  return live.map(({ task, sessionId, siteId }) => ({
    ...task,
    leadId: sessionId,
    siteId,
    siteName: siteNames[siteId] ?? siteId,
    leadName: leadNames[sessionId] ?? 'Unnamed lead',
    bucket: taskBucket(task.due_at, now),
  }))
}

async function loadSiteNames(): Promise<Record<string, string>> {
  const { data } = await supabase.from('sites').select('site_id, name')
  const out: Record<string, string> = {}
  for (const s of data ?? []) out[s.site_id] = s.name
  return out
}

// A display name per lead, resolved the same way the record page does: the
// lead_capture / contact control rows for chat leads, the leads table for
// email-only ones. Only the sessions that actually carry a task are looked up.
async function loadLeadNames(sessionIds: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(sessionIds))
  if (unique.length === 0) return {}

  const chatIds = unique.filter((s) => !isQuoteSessionId(s))
  const quoteLeadIds = unique.filter(isQuoteSessionId).map((s) => s.slice('quote-'.length))

  const [captureRes, leadsRes] = await Promise.all([
    chatIds.length
      ? supabase.from('chat_logs')
          .select('session_id, role, message, created_at')
          .in('session_id', chatIds)
          .in('role', [LEAD_CAPTURE_ROLE, CONTACT_ROLE])
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [] as { session_id: string; role: string; message: string; created_at: string }[] }),
    quoteLeadIds.length
      ? supabase.from('leads').select('id, name, email, phone').in('id', quoteLeadIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; email: string | null; phone: string | null }[] }),
  ])

  const out: Record<string, string> = {}
  for (const r of captureRes.data ?? []) {
    try {
      const o = JSON.parse(r.message)
      const label = (o?.name || o?.email || o?.phone || '').toString().trim()
      if (label) out[r.session_id] = label // ascending → the latest wins
    } catch { /* not a JSON control row */ }
  }
  for (const l of leadsRes.data ?? []) {
    const label = (l.name || l.email || l.phone || '').toString().trim()
    if (label) out[quoteSessionId(l.id)] = label
  }
  return out
}

// ── Grouping for the page ────────────────────────────────────────────────────
export interface TaskGroups {
  overdue: TaskWithLead[]
  today: TaskWithLead[]
  upcoming: TaskWithLead[]
  completed: TaskWithLead[]
}

export function groupTasks(tasks: TaskWithLead[]): TaskGroups {
  const open = tasks.filter((t) => t.status === 'open')
  return {
    overdue: open.filter((t) => t.bucket === 'overdue').sort(byDueAsc),
    today: open.filter((t) => t.bucket === 'today').sort(byDueAsc),
    upcoming: open.filter((t) => t.bucket === 'upcoming').sort(byDueAsc),
    // Completed is collapsed in the UI, so a long tail here costs nothing on
    // screen — but it still gets capped so the payload stays small.
    completed: tasks.filter((t) => t.status === 'done').sort(byCompletedDesc).slice(0, 100),
  }
}

export function applyFilters(tasks: TaskWithLead[], f: TaskFilters): TaskWithLead[] {
  return tasks.filter((t) => {
    if (f.assignee && t.assignee !== f.assignee) return false
    if (f.siteId && t.siteId !== f.siteId) return false
    if (f.type && f.type !== 'all' && t.type !== f.type) return false
    return true
  })
}
