// The reminder sweep — the scheduled job behind task due-date notifications.
//
// ── Why a sweep and not a queue ──────────────────────────────────────────────
// Nothing is enqueued when a task is created. Every run recomputes what each
// task owes from its CURRENT state, so the job is safe to run late, run twice,
// or miss a window entirely:
//
//   completed / deleted / unassigned → nothing is owed, so pending reminders
//                                      are cancelled simply by ceasing to exist
//   due date changed                 → the fire time moves with it; the ledger
//                                      key is unchanged, so no second reminder
//   reassigned                       → the task carries its new assignee, so the
//                                      reminder goes to them and not the old one
//
// ── How "at most once, ever" is guaranteed ───────────────────────────────────
// A crm_reminder ledger row is written BEFORE the push is sent (claim-then-send).
// A crash between the two loses that single ping rather than risking a repeat —
// the daily digest still covers anything outstanding. Two runs that overlap are
// additionally kept apart by a short lease row.

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { HARDCODED_ACCOUNTS, type Role } from './auth'
import { canSeeContacts, scrubText } from './pii'
import { workspaceSites, siteWorkspace, hasFeature, type Workspace } from './workspaces'
import { formatDueLabel, pktDayKey } from './datetime'
import { CRM_TASK_ROLE, parseCrmTask, taskBucket, type CrmTaskEntry } from './tasks'
import { isQuoteSessionId, quoteSessionId } from './quoteintake'
import { LEAD_CAPTURE_ROLE } from './leadtracking'
import { CONTACT_ROLE } from './visitor'
import { sendPushToMember } from './push'
import {
  CRM_PREFS_ROLE, CRM_REMINDER_ROLE, REMINDER_SITE, PREFS_SESSION, LEDGER_SESSION, LEASE_SESSION,
  parsePrefs, parseLedger, prefsFor, decideForTask, decideDigest,
  reminderKey, digestKey, reminderCopy, digestCopy,
  type ReminderPrefs, type LedgerEntry, type ReminderKind,
} from './reminders'

// Task rows older than this are not considered. Generous: an open task from
// months ago still matters, and the staleness cap in decideForTask() is what
// actually stops ancient reminders firing.
const TASK_WINDOW_DAYS = 400
const TASK_ROW_CAP = 8000
const LEDGER_WINDOW_DAYS = 60
const LEDGER_ROW_CAP = 20000

// ── Overlap lease ────────────────────────────────────────────────────────────
// Not a real lock (no DDL, no advisory locks available through PostgREST) — a
// short lease row that makes two runs firing at the same moment very unlikely.
// Correctness does not depend on it: the ledger is the real guarantee.
const LEASE_KEY = 'sweep:lease'
const LEASE_MS = 4 * 60 * 1000

export interface SweepResult {
  ok: boolean
  skipped?: 'leased'
  now: string
  scanned: number
  sent: { kind: ReminderKind | 'digest'; to: string; taskId?: string; title: string }[]
  held: { kind: ReminderKind | 'digest'; to: string; taskId?: string; until: string }[]
  suppressed: { kind: ReminderKind | 'digest'; to: string; taskId?: string; why: string }[]
  errors: string[]
}

interface LedgerRow { message: string; created_at: string }

// ── Access ───────────────────────────────────────────────────────────────────
// Recomputed on every run, never trusted from the task: a member removed from a
// site after a task was assigned to them must stop receiving its reminders.
interface Access { sites: Set<string>; workspace: Workspace; role: Role }

async function loadAccess(): Promise<Map<string, Access>> {
  const out = new Map<string, Access>()
  for (const acct of HARDCODED_ACCOUNTS) {
    out.set(acct.email.toLowerCase(), {
      sites: new Set(workspaceSites(acct.workspace)),
      workspace: acct.workspace,
      role: 'admin',
    })
  }
  const { data } = await supabase.from('members').select('email, role, workspace, assigned_sites')
  for (const m of data ?? []) {
    const ws = m.workspace as Workspace
    const sites = m.role === 'admin' ? workspaceSites(ws) : (m.assigned_sites ?? [])
    out.set(String(m.email).toLowerCase(), { sites: new Set(sites), workspace: ws, role: (m.role === 'admin' ? 'admin' : 'standard') })
  }
  return out
}

function canAccess(access: Map<string, Access>, email: string, siteId: string): boolean {
  return access.get(email.trim().toLowerCase())?.sites.has(siteId) ?? false
}

// ── Loaders ──────────────────────────────────────────────────────────────────
interface LiveTask { task: CrmTaskEntry; leadId: string; siteId: string }

async function loadLiveTasks(): Promise<LiveTask[]> {
  const since = new Date(Date.now() - TASK_WINDOW_DAYS * 86_400_000).toISOString()
  const rows = await fetchAllPages<{ session_id: string; site_id: string; message: string }>(
    () => supabase
      .from('chat_logs')
      .select('session_id, site_id, message, created_at')
      .eq('role', CRM_TASK_ROLE)
      .gte('created_at', since)
      .order('created_at', { ascending: true }),
    TASK_ROW_CAP)

  const byId = new Map<string, LiveTask>()
  for (const r of rows) {
    const t = parseCrmTask(r.message)
    if (t) byId.set(t.id, { task: t, leadId: r.session_id, siteId: r.site_id })
  }
  return Array.from(byId.values()).filter((e) => !e.task.deleted && e.task.status === 'open')
}

async function loadPrefs(): Promise<Map<string, ReminderPrefs>> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', CRM_PREFS_ROLE)
    .eq('session_id', PREFS_SESSION)
    .order('created_at', { ascending: true })
    .limit(4000)
  const out = new Map<string, ReminderPrefs>()
  for (const r of data ?? []) {
    const p = parsePrefs(r.message)
    if (p) out.set(p.email.toLowerCase(), p) // ascending → newest revision wins
  }
  return out
}

async function loadLedger(): Promise<Set<string>> {
  const since = new Date(Date.now() - LEDGER_WINDOW_DAYS * 86_400_000).toISOString()
  const rows = await fetchAllPages<LedgerRow>(
    () => supabase
      .from('chat_logs')
      .select('message, created_at')
      .eq('role', CRM_REMINDER_ROLE)
      .eq('session_id', LEDGER_SESSION)
      .gte('created_at', since)
      .order('created_at', { ascending: true }),
    LEDGER_ROW_CAP)
  // Hitting this cap would drop the NEWEST claims (the fetch is oldest-first),
  // and a claim we cannot see reads as "never sent" — i.e. a duplicate reminder.
  warnIfCapped('reminders: ledger', rows.length, LEDGER_ROW_CAP)
  const out = new Set<string>()
  for (const r of rows) {
    const e = parseLedger(r.message)
    // Leases live on their own session now; this still skips the ones written
    // before that split, which are append-only and cannot be migrated away.
    if (e && e.k !== LEASE_KEY) out.add(e.k)
  }
  return out
}

// Display name per lead, so a notification says who it is about.
async function loadLeadNames(ids: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids))
  if (unique.length === 0) return {}
  const chatIds = unique.filter((s) => !isQuoteSessionId(s))
  const quoteIds = unique.filter(isQuoteSessionId).map((s) => s.slice('quote-'.length))

  const [caps, leads] = await Promise.all([
    chatIds.length
      ? supabase.from('chat_logs').select('session_id, message, created_at')
          .in('session_id', chatIds).in('role', [LEAD_CAPTURE_ROLE, CONTACT_ROLE])
          .order('created_at', { ascending: true })
      : Promise.resolve({ data: [] as { session_id: string; message: string }[] }),
    quoteIds.length
      ? supabase.from('leads').select('id, name, email, phone').in('id', quoteIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; email: string | null; phone: string | null }[] }),
  ])

  const out: Record<string, string> = {}
  for (const r of caps.data ?? []) {
    try {
      const o = JSON.parse(r.message)
      const label = String(o?.name || o?.email || o?.phone || '').trim()
      if (label) out[r.session_id] = label
    } catch { /* not JSON */ }
  }
  for (const l of leads.data ?? []) {
    const label = String(l.name || l.email || l.phone || '').trim()
    if (label) out[quoteSessionId(l.id)] = label
  }
  return out
}

// ── Ledger writes ────────────────────────────────────────────────────────────
// `session` defaults to the ledger; the lease passes its own so the two never
// share a row set — see LEASE_SESSION in lib/reminders.ts for why.
async function claim(entry: LedgerEntry, session: string = LEDGER_SESSION): Promise<boolean> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE,
    session_id: session,
    role: CRM_REMINDER_ROLE,
    message: JSON.stringify(entry),
  })
  if (error) console.error('[reminders] ledger write failed:', error.message)
  return !error
}

async function takeLease(now: Date): Promise<boolean> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', CRM_REMINDER_ROLE)
    .eq('session_id', LEASE_SESSION)
    .gte('created_at', new Date(now.getTime() - LEASE_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(50)
  for (const r of data ?? []) {
    const e = parseLedger(r.message)
    if (e?.k === LEASE_KEY) return false // someone else is mid-run
  }
  await claim({ k: LEASE_KEY, kind: 'digest', to: '', at: now.toISOString(), state: 'sent', why: 'lease' }, LEASE_SESSION)
  return true
}

// ── The sweep ────────────────────────────────────────────────────────────────
export async function runReminderSweep(
  now: Date = new Date(),
  opts: { dryRun?: boolean; ignoreLease?: boolean } = {},
): Promise<SweepResult> {
  const result: SweepResult = {
    ok: true, now: now.toISOString(), scanned: 0, sent: [], held: [], suppressed: [], errors: [],
  }

  if (!opts.dryRun && !opts.ignoreLease && !(await takeLease(now))) {
    return { ...result, skipped: 'leased' }
  }

  const [tasks, prefsByEmail, sent, access] = await Promise.all([
    loadLiveTasks(), loadPrefs(), loadLedger(), loadAccess(),
  ])
  result.scanned = tasks.length

  const names = await loadLeadNames(tasks.map((t) => t.leadId))

  // ── per-task reminders ─────────────────────────────────────────────────────
  for (const { task, leadId, siteId } of tasks) {
    const email = task.assignee.trim()
    if (!email) continue
    const prefs = prefsFor(email, prefsByEmail.get(email.toLowerCase()))

    // Access is re-checked here, every run. A member who lost the site stops
    // being reminded about it — the reminder is skipped WITHOUT a ledger row so
    // it resumes correctly if access is restored (the staleness cap stops it
    // being resurrected indefinitely).
    if (!canAccess(access, email, siteId)) {
      result.suppressed.push({ kind: 'due', to: email, taskId: task.id, why: 'no-site-access' })
      continue
    }
    const ws = access.get(email.toLowerCase())?.workspace ?? siteWorkspace(siteId)
    if (!ws) continue
    // A workspace that does not carry reminders is never notified, even if a
    // task somehow exists on one of its sites.
    if (!hasFeature(ws, 'reminders')) {
      result.suppressed.push({ kind: 'due', to: email, taskId: task.id, why: 'workspace-has-no-reminders' })
      continue
    }

    for (const d of decideForTask(task, prefs, now, sent)) {
      const k = reminderKey(task.id, d.kind)
      if (d.action === 'hold') {
        result.held.push({ kind: d.kind, to: email, taskId: task.id, until: d.until.toISOString() })
        continue
      }
      if (d.action === 'suppress') {
        // Recorded so it can never fire later either.
        if (!opts.dryRun) {
          await claim({ k, kind: d.kind, to: email, at: now.toISOString(), state: 'suppressed', why: d.why, taskId: task.id })
          sent.add(k)
        }
        result.suppressed.push({ kind: d.kind, to: email, taskId: task.id, why: d.why })
        continue
      }

      // Same read-edge rule as /api/tasks: this recipient may be barred from
      // customer contacts, and both the lead label (which falls back to an
      // email/phone) and a hand-typed title can carry one straight into an OS
      // notification banner.
      const seesContacts = canSeeContacts(access.get(email.toLowerCase()) ?? { role: 'standard', workspace: ws })
      const copy = reminderCopy(d.kind, {
        title: (seesContacts ? task.title : scrubText(task.title)) ?? '',
        leadName: (seesContacts ? names[leadId] : scrubText(names[leadId] ?? 'Lead')) ?? 'Lead',
        leadMinutes: prefs.leadMinutes,
        dueLabel: formatDueLabel(task.due_at, now),
      })
      if (opts.dryRun) {
        result.sent.push({ kind: d.kind, to: email, taskId: task.id, title: copy.title })
        continue
      }
      // Claim BEFORE sending — a duplicate notification is worse than a missed
      // one, and the digest still covers anything that slips.
      if (!(await claim({ k, kind: d.kind, to: email, at: now.toISOString(), state: 'sent', taskId: task.id }))) {
        result.errors.push(`ledger write failed for ${k}`)
        continue
      }
      sent.add(k)
      try {
        await sendPushToMember(email, ws, {
          title: copy.title,
          body: copy.body,
          url: `/leads/${encodeURIComponent(leadId)}`,
          tag: `task-${d.kind}-${task.id}`,
        })
        result.sent.push({ kind: d.kind, to: email, taskId: task.id, title: copy.title })
      } catch (err) {
        result.errors.push(`push failed for ${k}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // ── daily digest ───────────────────────────────────────────────────────────
  // The ONLY recurring signal. Overdue tasks are never re-pinged individually.
  const byAssignee = new Map<string, LiveTask[]>()
  for (const t of tasks) {
    const email = t.task.assignee.trim().toLowerCase()
    if (!email) continue
    if (!canAccess(access, email, t.siteId)) continue
    const list = byAssignee.get(email) ?? []
    list.push(t)
    byAssignee.set(email, list)
  }

  for (const [email, list] of byAssignee) {
    // Resolved BEFORE the claim below — skipping after a ledger write would
    // burn the day's digest key without sending anything.
    const ws = access.get(email)?.workspace
    if (!ws || !hasFeature(ws, 'reminders')) continue
    const prefs = prefsFor(email, prefsByEmail.get(email))
    const overdue = list.filter((t) => taskBucket(t.task.due_at, now) === 'overdue').length
    const dueToday = list.filter((t) => taskBucket(t.task.due_at, now) === 'today').length
    const decision = decideDigest(prefs, now, sent, overdue + dueToday)

    if (decision.action === 'hold') {
      result.held.push({ kind: 'digest', to: email, until: decision.until.toISOString() })
      continue
    }
    if (decision.action !== 'send') continue

    const k = digestKey(email, decision.dayKey)
    const copy = digestCopy(overdue, dueToday)
    if (opts.dryRun) {
      result.sent.push({ kind: 'digest', to: email, title: copy.title })
      continue
    }
    if (!(await claim({ k, kind: 'digest', to: email, at: now.toISOString(), state: 'sent' }))) {
      result.errors.push(`ledger write failed for ${k}`)
      continue
    }
    sent.add(k)
    try {
      await sendPushToMember(email, ws, { title: copy.title, body: copy.body, url: '/tasks', tag: `digest-${decision.dayKey}` })
      result.sent.push({ kind: 'digest', to: email, title: copy.title })
    } catch (err) {
      result.errors.push(`digest push failed for ${email}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

// Exposed for the settings panel: today's Karachi day key, so the UI can show
// when the next digest is due without duplicating the date logic.
export const todayPktKey = () => pktDayKey(new Date())
