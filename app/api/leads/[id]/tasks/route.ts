import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { supabase } from '@/lib/supabase'
import { pktDateTimeToUtc } from '@/lib/datetime'
import {
  CRM_TASK_ROLE, MAX_TASK_TITLE, isTaskType, newTaskId, parseCrmTask,
  type CrmTaskEntry, type TaskType,
} from '@/lib/tasks'

export const dynamic = 'force-dynamic'

// Tasks on a lead. Stored as crm_task control rows — append-only, newest
// revision of a task id wins on read, older revisions are the audit trail the
// timeline is built from. Nothing is ever updated or deleted in place.
//
// Every handler goes through guardLeadAccess first: a member who cannot see the
// lead's site gets 403 on read AND on write, whether they clicked a link or
// typed the id.

// The newest revision of one task, straight from the DB. Written state is never
// trusted from the client — a reassign must not be able to smuggle in a new
// title, and completing must not be able to rewrite who created it.
async function latestRevision(sessionId: string, taskId: string): Promise<CrmTaskEntry | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('session_id', sessionId)
    .eq('role', CRM_TASK_ROLE)
    .order('created_at', { ascending: false })
    .limit(400)
  for (const row of data ?? []) {
    const t = parseCrmTask(row.message)
    if (t?.id === taskId) return t
  }
  return null
}

// A task may only be assigned to someone who can actually see the lead's site,
// otherwise it would sit in a queue they are not allowed to open.
function assigneeAllowed(email: string, siteId: string, membersRows: { email: string; role: string; assigned_sites: string[] | null }[]): boolean {
  const m = membersRows.find((r) => r.email === email)
  if (!m) return false
  return m.role === 'admin' || (m.assigned_sites ?? []).includes(siteId)
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TASK_TITLE) : ''
  if (!title) return NextResponse.json({ error: 'A task needs a title' }, { status: 400 })

  const type: TaskType = isTaskType(body.type) ? body.type : 'follow_up'

  // Due date/time arrive as Karachi wall-clock strings and are converted here,
  // server-side — the browser's own timezone never enters into it.
  const dueAt = pktDateTimeToUtc(String(body.dueDate ?? ''), String(body.dueTime ?? ''))
  if (!dueAt) return NextResponse.json({ error: 'A valid due date and time are required' }, { status: 400 })

  let assignee = typeof body.assignee === 'string' ? body.assignee.trim() : ''
  if (!assignee) assignee = access.member.email
  if (assignee !== access.member.email) {
    const { data: rows } = await supabase
      .from('members').select('email, role, assigned_sites').eq('workspace', access.member.workspace)
    if (!assigneeAllowed(assignee, access.siteId, rows ?? [])) {
      return NextResponse.json({ error: 'That member cannot access this lead’s site' }, { status: 400 })
    }
  }

  const now = new Date().toISOString()
  const task: CrmTaskEntry = {
    id: newTaskId(),
    title,
    type,
    due_at: dueAt,
    assignee,
    status: 'open',
    created_by: access.member.email,
    created_at: now,
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, task })
}

// Complete / reopen / reassign / edit — one endpoint, because all of them are
// the same operation underneath: append a new revision.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const taskId = typeof body.taskId === 'string' ? body.taskId : ''
  if (!taskId) return NextResponse.json({ error: 'taskId is required' }, { status: 400 })

  const existing = await latestRevision(id, taskId)
  if (!existing || existing.deleted) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const now = new Date().toISOString()
  const next: CrmTaskEntry = { ...existing, updated_by: access.member.email, updated_at: now }

  if (body.status === 'done' || body.status === 'open') {
    next.status = body.status
    if (body.status === 'done') {
      next.completed_by = access.member.email
      next.completed_at = now
    } else {
      // Reopening clears the completion stamp so "completed by" can never
      // describe a task that is currently open.
      delete next.completed_by
      delete next.completed_at
    }
  }

  if (typeof body.title === 'string' && body.title.trim()) {
    next.title = body.title.trim().slice(0, MAX_TASK_TITLE)
  }
  if (isTaskType(body.type)) next.type = body.type

  if (body.dueDate !== undefined || body.dueTime !== undefined) {
    const dueAt = pktDateTimeToUtc(String(body.dueDate ?? ''), String(body.dueTime ?? ''))
    if (!dueAt) return NextResponse.json({ error: 'A valid due date and time are required' }, { status: 400 })
    next.due_at = dueAt
  }

  if (typeof body.assignee === 'string' && body.assignee.trim() !== existing.assignee) {
    const assignee = body.assignee.trim()
    if (assignee && assignee !== access.member.email) {
      const { data: rows } = await supabase
        .from('members').select('email, role, assigned_sites').eq('workspace', access.member.workspace)
      if (!assigneeAllowed(assignee, access.siteId, rows ?? [])) {
        return NextResponse.json({ error: 'That member cannot access this lead’s site' }, { status: 400 })
      }
    }
    next.assignee = assignee
  }

  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_TASK_ROLE, message: JSON.stringify(next),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, task: next })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { taskId } = await req.json().catch(() => ({}))
  if (typeof taskId !== 'string' || !taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 })
  }
  const existing = await latestRevision(id, taskId)
  if (!existing) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const task: CrmTaskEntry = {
    ...existing, deleted: true, updated_by: access.member.email, updated_at: new Date().toISOString(),
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true })
}
