import { NextRequest, NextResponse } from 'next/server'
import { getMember, HARDCODED_ACCOUNTS } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { writeControlRow } from '@/lib/leadrecord'
import { applyStageChange } from '@/lib/stagechange'
import { setAssignment } from '@/lib/assignment'
import { isCrmStage, type CrmStage } from '@/lib/crm'
import { pktDateTimeToUtc } from '@/lib/datetime'
import {
  CRM_TASK_ROLE, MAX_TASK_TITLE, isTaskType, newTaskId, parseCrmTask,
  type CrmTaskEntry, type TaskType,
} from '@/lib/tasks'
import {
  BULK_MAX_IDS, resolveSitesForIds, runBulk, describeSkipped,
  type BulkOutcome,
} from '@/lib/bulk'
import { currentStateForIds } from '@/lib/leadstate'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Bulk edits for the pipeline list: set stage, set owner, add a task.
//
// Access is re-checked per lead here (resolveSitesForIds), never trusted from
// the client — the ids arrive from the browser, so a member could otherwise
// post ids for a site they cannot see. Leads they cannot write to are SKIPPED
// and reported, not applied and not fatal.
//
// Stage changes go through lib/stagechange.ts, the same function the
// single-lead endpoint uses, so the legacy lead_status dual-write and its
// shared created_at cannot drift between the two paths.

function respond(outcome: BulkOutcome, extra: Record<string, unknown> = {}) {
  return NextResponse.json({
    ok: true,
    applied: outcome.applied.length,
    appliedIds: outcome.applied,
    skipped: outcome.skipped,
    failed: outcome.failed,
    note: describeSkipped(outcome.skipped),
    ...extra,
  })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  // `entries` (undo) carries a per-lead target; `ids` carries one target for all.
  const entries: { id: string; stage?: string; email?: string | null; taskId?: string }[] =
    Array.isArray(body.entries) ? body.entries.filter((e: unknown) => e && typeof (e as { id: unknown }).id === 'string') : []
  const rawIds: string[] = entries.length
    ? entries.map((e) => e.id)
    : (Array.isArray(body.ids) ? body.ids.filter((i: unknown) => typeof i === 'string' && i) : [])

  const ids = Array.from(new Set(rawIds))
  if (ids.length === 0) return NextResponse.json({ error: 'Nothing selected' }, { status: 400 })
  if (ids.length > BULK_MAX_IDS) {
    return NextResponse.json({ error: `Too many leads at once — the limit is ${BULK_MAX_IDS}.` }, { status: 400 })
  }

  const { allowed, skipped } = await resolveSitesForIds(member, ids)
  const targets = ids.filter((id) => allowed.has(id))

  // Everything the member selected was out of scope: say so rather than
  // reporting a cheerful "0 updated".
  if (targets.length === 0) {
    return NextResponse.json({
      ok: true, applied: 0, appliedIds: [], skipped, failed: [],
      note: describeSkipped(skipped) || 'Nothing could be updated.',
    })
  }

  // ── set stage ──────────────────────────────────────────────────────────────
  if (action === 'stage' || action === 'stage-restore') {
    const perLead = new Map<string, CrmStage>()
    if (action === 'stage-restore') {
      for (const e of entries) if (isCrmStage(e.stage)) perLead.set(e.id, e.stage)
    } else {
      if (!isCrmStage(body.stage)) return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })
      for (const id of targets) perLead.set(id, body.stage)
    }

    const before = await currentStateForIds(targets)
    // One timestamp for the whole action: the leads moved together, and the
    // per-lead rows still carry their own previous stage.
    const at = new Date().toISOString()

    const work = targets
      .filter((id) => perLead.has(id))
      .map((id) => ({ id, stage: perLead.get(id)!, previous: before.get(id)?.stage ?? null }))

    const { applied, failed } = await runBulk(work, (w) => w.id, async (w) => {
      const res = await applyStageChange({
        leadId: w.id, siteId: allowed.get(w.id)!, stage: w.stage,
        previous: w.previous, actorEmail: member.email, at,
      })
      return { ok: res.ok, error: res.error }
    })

    const appliedSet = new Set(applied)
    return respond({ applied, skipped, failed }, {
      at,
      // Undo restores each lead to what it actually was, one row per lead.
      undo: {
        action: 'stage-restore',
        entries: work.filter((w) => appliedSet.has(w.id)).map((w) => ({ id: w.id, stage: w.previous ?? 'new' })),
      },
    })
  }

  // ── set owner ──────────────────────────────────────────────────────────────
  if (action === 'owner' || action === 'owner-restore') {
    const perLead = new Map<string, string | null>()
    if (action === 'owner-restore') {
      for (const e of entries) perLead.set(e.id, typeof e.email === 'string' && e.email ? e.email.toLowerCase() : null)
    } else {
      const target = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (target) {
        // The new owner must be a real member of this workspace. Per-site
        // eligibility is checked below, per lead — a selection can span sites.
        const builtin = HARDCODED_ACCOUNTS.some((a) => a.email === target && a.workspace === member.workspace)
        if (!builtin) {
          const { data } = await supabase.from('members')
            .select('email, role, assigned_sites').eq('workspace', member.workspace)
            .ilike('email', target).maybeSingle()
          if (!data) return NextResponse.json({ error: 'That member is not in this workspace' }, { status: 400 })
          const sites: string[] = data.assigned_sites ?? []
          for (const id of targets) {
            const site = allowed.get(id)!
            if (data.role === 'admin' || sites.includes(site)) perLead.set(id, target)
          }
        } else {
          for (const id of targets) perLead.set(id, target)
        }
      } else {
        for (const id of targets) perLead.set(id, null) // unassign
      }
    }

    // A lead whose site the new owner cannot reach is skipped, not silently
    // parked on someone who could never open it.
    const unassignable = targets.filter((id) => !perLead.has(id))
    const before = await currentStateForIds(targets)

    const work = targets.filter((id) => perLead.has(id)).map((id) => ({ id, email: perLead.get(id)! }))
    const { applied, failed } = await runBulk(work, (w) => w.id, async (w) => {
      try {
        await setAssignment(w.id, allowed.get(w.id)!, w.email)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Could not set the owner' }
      }
    })

    const appliedSet = new Set(applied)
    const allSkipped = [...skipped, ...unassignable.map((id) => ({ id, reason: 'no-access' as const }))]
    return respond({ applied, skipped: allSkipped, failed }, {
      note: describeSkipped(skipped) + (unassignable.length
        ? ` ${unassignable.length} skipped: that member cannot access their site${unassignable.length === 1 ? '' : 's'}.`
        : ''),
      undo: {
        action: 'owner-restore',
        entries: work.filter((w) => appliedSet.has(w.id)).map((w) => ({ id: w.id, email: before.get(w.id)?.owner ?? null })),
      },
    })
  }

  // ── add a task to each ─────────────────────────────────────────────────────
  if (action === 'task') {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TASK_TITLE) : ''
    if (!title) return NextResponse.json({ error: 'A task needs a title' }, { status: 400 })
    const type: TaskType = isTaskType(body.type) ? body.type : 'follow_up'
    const dueAt = pktDateTimeToUtc(String(body.dueDate ?? ''), String(body.dueTime ?? ''))
    if (!dueAt) return NextResponse.json({ error: 'A valid due date and time are required' }, { status: 400 })

    let assignee = typeof body.assignee === 'string' ? body.assignee.trim() : ''
    if (!assignee) assignee = member.email
    let assigneeSites: string[] | null = null
    let assigneeIsAdmin = false
    if (assignee !== member.email) {
      const { data } = await supabase.from('members')
        .select('email, role, assigned_sites').eq('workspace', member.workspace)
        .ilike('email', assignee).maybeSingle()
      if (!data) return NextResponse.json({ error: 'That member is not in this workspace' }, { status: 400 })
      assigneeIsAdmin = data.role === 'admin'
      assigneeSites = data.assigned_sites ?? []
    }

    const eligible = targets.filter((id) => {
      if (assignee === member.email || assigneeIsAdmin) return true
      return (assigneeSites ?? []).includes(allowed.get(id)!)
    })
    const notEligible = targets.filter((id) => !eligible.includes(id))

    const now = new Date().toISOString()
    const work = eligible.map((id) => ({
      id,
      task: {
        id: newTaskId(), title, type, due_at: dueAt, assignee,
        status: 'open', created_by: member.email, created_at: now,
      } as CrmTaskEntry,
    }))

    const { applied, failed } = await runBulk(work, (w) => w.id, async (w) => {
      const { error } = await writeControlRow({
        sessionId: w.id, siteId: allowed.get(w.id)!, role: CRM_TASK_ROLE, message: JSON.stringify(w.task),
      })
      return { ok: !error, error: error ?? undefined }
    })

    const appliedSet = new Set(applied)
    const allSkipped = [...skipped, ...notEligible.map((id) => ({ id, reason: 'no-access' as const }))]
    return respond({ applied, skipped: allSkipped, failed }, {
      note: describeSkipped(skipped) + (notEligible.length
        ? ` ${notEligible.length} skipped: the assignee cannot access their site${notEligible.length === 1 ? '' : 's'}.`
        : ''),
      undo: {
        action: 'task-undo',
        entries: work.filter((w) => appliedSet.has(w.id)).map((w) => ({ id: w.id, taskId: w.task.id })),
      },
    })
  }

  // ── undo a bulk task: append a deleted revision, the same shape the record
  //    page's delete writes, so the timeline reads correctly. ────────────────
  if (action === 'task-undo') {
    const wanted = new Map(entries.filter((e) => e.taskId).map((e) => [e.id, e.taskId!]))
    const work = targets.filter((id) => wanted.has(id)).map((id) => ({ id, taskId: wanted.get(id)! }))
    const now = new Date().toISOString()

    const { applied, failed } = await runBulk(work, (w) => w.id, async (w) => {
      const { data } = await supabase.from('chat_logs')
        .select('message').eq('session_id', w.id).eq('role', CRM_TASK_ROLE)
        .order('created_at', { ascending: false }).limit(200)
      let existing: CrmTaskEntry | null = null
      for (const row of data ?? []) {
        const t = parseCrmTask(row.message)
        if (t?.id === w.taskId) { existing = t; break }
      }
      if (!existing) return { ok: true } // already gone — undo is idempotent
      const { error } = await writeControlRow({
        sessionId: w.id, siteId: allowed.get(w.id)!, role: CRM_TASK_ROLE,
        message: JSON.stringify({ ...existing, deleted: true, updated_by: member.email, updated_at: now }),
      })
      return { ok: !error, error: error ?? undefined }
    })
    return respond({ applied, skipped, failed })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
