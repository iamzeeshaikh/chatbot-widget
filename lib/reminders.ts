// Task due-date reminders — preferences, quiet hours and "what should have
// fired by now" logic.
//
// Everything here is PURE and client-safe (no supabase, no web-push) so the
// settings panel, the sweep and the tests all share one definition. The DB and
// push side lives in lib/reminderssweep.ts.
//
// Two new control roles, both registered in CRM_ROLES (lib/crm.ts):
//
//   crm_prefs    — one row per revision of a member's reminder preferences.
//   crm_reminder — the SENT LEDGER: one row per reminder that has been claimed.
//                  This is what makes "at most once, ever" survive a restart, a
//                  redeploy or an overlapping run.
//
// Both live on a RESERVED site/session (never a real lead conversation), the
// same trick lib/push.ts uses for push_sub — so they cannot appear in any
// conversation list, which only ever queries real site ids. They are registered
// in CRM_ROLES anyway, belt and braces, so that even a row written to a lead
// session by mistake would still be filtered out of previews and message counts.

import { pktDayKey, pktDayKeyOffset, pktDateTimeToUtc, pktPartsOf } from './datetime'
import type { CrmTaskEntry } from './tasks'

export const CRM_PREFS_ROLE = 'crm_prefs'
export const CRM_REMINDER_ROLE = 'crm_reminder'

// Reserved home for member-scoped CRM rows. Not a real site, so no member's
// site scope ever includes it and no conversation query can reach it.
export const REMINDER_SITE = 'zeeops-crm'
export const PREFS_SESSION = 'zeeops-crm-prefs'
export const LEDGER_SESSION = 'zeeops-crm-reminders'

// ── Preferences ──────────────────────────────────────────────────────────────
export interface ReminderPrefs {
  email: string
  /** Per-task reminders (lead time + at due time). */
  enabled: boolean
  /** Minutes before the due time for the early nudge. 0 disables just that one. */
  leadMinutes: number
  digestEnabled: boolean
  /** Karachi hour, 0–23. */
  digestHour: number
  /** Quiet window in Karachi hours; may wrap midnight. start === end disables it. */
  quietStart: number
  quietEnd: number
  updated_at?: string
}

// A member who never opens settings still gets useful behaviour.
export const DEFAULT_PREFS: Omit<ReminderPrefs, 'email'> = {
  enabled: true,
  leadMinutes: 30,
  digestEnabled: true,
  digestHour: 9,     // 9:00 AM PKT
  quietStart: 21,    // 9:00 PM PKT
  quietEnd: 8,       // 8:00 AM PKT
}

export const LEAD_TIME_CHOICES = [0, 5, 10, 15, 30, 60, 120, 240, 1440] as const

export function leadTimeLabel(min: number): string {
  if (min === 0) return 'No early reminder'
  if (min < 60) return `${min} minutes before`
  if (min === 60) return '1 hour before'
  if (min < 1440) return `${min / 60} hours before`
  return min === 1440 ? '1 day before' : `${min / 1440} days before`
}

export function hourLabel(h: number): string {
  const hh = ((h % 24) + 24) % 24
  const ampm = hh < 12 ? 'AM' : 'PM'
  const base = hh % 12 === 0 ? 12 : hh % 12
  return `${base}:00 ${ampm}`
}

const clampHour = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? Math.floor(v) : NaN
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback
}

export function parsePrefs(message: string | null | undefined): ReminderPrefs | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.email !== 'string' || !o.email) return null
    const lead = typeof o.leadMinutes === 'number' && o.leadMinutes >= 0 && o.leadMinutes <= 10080
      ? Math.floor(o.leadMinutes)
      : DEFAULT_PREFS.leadMinutes
    return {
      email: o.email,
      enabled: o.enabled !== false,
      leadMinutes: lead,
      digestEnabled: o.digestEnabled !== false,
      digestHour: clampHour(o.digestHour, DEFAULT_PREFS.digestHour),
      quietStart: clampHour(o.quietStart, DEFAULT_PREFS.quietStart),
      quietEnd: clampHour(o.quietEnd, DEFAULT_PREFS.quietEnd),
      updated_at: typeof o.updated_at === 'string' ? o.updated_at : undefined,
    }
  } catch {
    return null
  }
}

export function prefsFor(email: string, found: ReminderPrefs | undefined | null): ReminderPrefs {
  return found ?? { email, ...DEFAULT_PREFS }
}

// ── Quiet hours ──────────────────────────────────────────────────────────────
// The window is expressed in Karachi hours and may wrap midnight (21 → 8).
export function inQuietHours(pktHour: number, start: number, end: number): boolean {
  if (start === end) return false // disabled
  return start < end ? pktHour >= start && pktHour < end : pktHour >= start || pktHour < end
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** The Karachi hour at an instant. */
export function pktHourAt(at: Date): number {
  const parts = pktPartsOf(at)
  return parts ? Number(parts.time.slice(0, 2)) : 0
}

// When the quiet window next opens, or null if we are not in it. Anything
// caught by quiet hours is HELD until this moment — never dropped, because an
// overdue task silently vanishing is the failure mode that matters most.
export function quietHoldUntil(now: Date, prefs: Pick<ReminderPrefs, 'quietStart' | 'quietEnd'>): Date | null {
  const parts = pktPartsOf(now)
  if (!parts) return null
  const hour = Number(parts.time.slice(0, 2))
  if (!inQuietHours(hour, prefs.quietStart, prefs.quietEnd)) return null

  const openTodayIso = pktDateTimeToUtc(parts.date, `${pad2(prefs.quietEnd)}:00`)
  if (openTodayIso && new Date(openTodayIso).getTime() > now.getTime()) return new Date(openTodayIso)
  const openTomorrowIso = pktDateTimeToUtc(pktDayKeyOffset(1, now), `${pad2(prefs.quietEnd)}:00`)
  return openTomorrowIso ? new Date(openTomorrowIso) : null
}

// ── What should fire ─────────────────────────────────────────────────────────
export type ReminderKind = 'lead' | 'due'

/** Ledger key. One per task per kind — this is the "at most once, ever" identity. */
export function reminderKey(taskId: string, kind: ReminderKind): string {
  return `${taskId}:${kind}`
}

export function digestKey(email: string, dayKey: string): string {
  return `digest:${email.toLowerCase()}:${dayKey}`
}

export function fireAtFor(kind: ReminderKind, dueAt: string, leadMinutes: number): Date {
  const due = new Date(dueAt).getTime()
  return new Date(kind === 'lead' ? due - leadMinutes * 60_000 : due)
}

// How late a per-task reminder may be and still be worth sending. Past this the
// moment has gone — pinging "due now" about something two days old is noise, and
// the daily digest is what carries overdue work. Suppressed (not dropped): the
// ledger records it so it can never fire later either.
export const MAX_LATE_MS = 24 * 60 * 60 * 1000

export type Decision =
  | { kind: ReminderKind; action: 'send'; fireAt: Date }
  | { kind: ReminderKind; action: 'hold'; fireAt: Date; until: Date }
  | { kind: ReminderKind; action: 'suppress'; fireAt: Date; why: 'stale' }

// Everything a single task owes right now, derived purely from its CURRENT
// state — never from a queue. That is what makes the sweep safe to run late,
// twice, or after missing a window entirely:
//
//   • completed / deleted / unassigned  → nothing (cancellation is implicit)
//   • rescheduled                       → fireAt just moves; the ledger key is
//                                         unchanged, so it cannot double-fire
//   • reassigned                        → the task carries its new assignee, so
//                                         the reminder simply goes to them
export function decideForTask(
  task: Pick<CrmTaskEntry, 'id' | 'due_at' | 'status' | 'assignee' | 'deleted'>,
  prefs: ReminderPrefs,
  now: Date,
  alreadySent: ReadonlySet<string>,
): Decision[] {
  if (!prefs.enabled) return []
  if (task.deleted || task.status !== 'open' || !task.assignee) return []
  const dueMs = new Date(task.due_at).getTime()
  if (!Number.isFinite(dueMs)) return []

  const out: Decision[] = []
  const kinds: ReminderKind[] = prefs.leadMinutes > 0 ? ['lead', 'due'] : ['due']

  for (const kind of kinds) {
    if (alreadySent.has(reminderKey(task.id, kind))) continue
    const fireAt = fireAtFor(kind, task.due_at, prefs.leadMinutes)
    if (fireAt.getTime() > now.getTime()) continue // not yet — a later run takes it

    if (now.getTime() - fireAt.getTime() > MAX_LATE_MS) {
      out.push({ kind, action: 'suppress', fireAt, why: 'stale' })
      continue
    }
    const until = quietHoldUntil(now, prefs)
    if (until) out.push({ kind, action: 'hold', fireAt, until })
    else out.push({ kind, action: 'send', fireAt })
  }
  return out
}

// ── Digest ───────────────────────────────────────────────────────────────────
export type DigestDecision =
  | { action: 'send'; dayKey: string }
  | { action: 'hold'; dayKey: string; until: Date }
  | { action: 'skip'; why: 'disabled' | 'too-early' | 'already-sent' | 'nothing-to-say' }

// Once per Karachi day, at or after the member's digest hour. Keyed on the
// Karachi day so a run at 09:01 and another at 09:06 produce one digest.
export function decideDigest(
  prefs: ReminderPrefs,
  now: Date,
  alreadySent: ReadonlySet<string>,
  itemCount: number,
): DigestDecision {
  if (!prefs.digestEnabled) return { action: 'skip', why: 'disabled' }
  const dayKey = pktDayKey(now)
  if (alreadySent.has(digestKey(prefs.email, dayKey))) return { action: 'skip', why: 'already-sent' }
  if (pktHourAt(now) < prefs.digestHour) return { action: 'skip', why: 'too-early' }
  if (itemCount === 0) return { action: 'skip', why: 'nothing-to-say' }

  const until = quietHoldUntil(now, prefs)
  return until ? { action: 'hold', dayKey, until } : { action: 'send', dayKey }
}

// ── Ledger rows ──────────────────────────────────────────────────────────────
export interface LedgerEntry {
  /** Dedupe identity — reminderKey() or digestKey(). */
  k: string
  kind: ReminderKind | 'digest'
  to: string
  at: string
  state: 'sent' | 'suppressed'
  why?: string
  taskId?: string
}

export function parseLedger(message: string | null | undefined): LedgerEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.k !== 'string' || !o.k) return null
    return {
      k: o.k,
      kind: o.kind,
      to: typeof o.to === 'string' ? o.to : '',
      at: typeof o.at === 'string' ? o.at : '',
      state: o.state === 'suppressed' ? 'suppressed' : 'sent',
      why: typeof o.why === 'string' ? o.why : undefined,
      taskId: typeof o.taskId === 'string' ? o.taskId : undefined,
    }
  } catch {
    return null
  }
}

// ── Notification copy ────────────────────────────────────────────────────────
export function reminderCopy(
  kind: ReminderKind,
  opts: { title: string; leadName: string; leadMinutes: number; dueLabel: string },
): { title: string; body: string } {
  if (kind === 'lead') {
    return {
      title: `Due ${leadTimeLabel(opts.leadMinutes).replace(' before', '')} — ${opts.title}`.slice(0, 120),
      body: `${opts.leadName} · ${opts.dueLabel}`,
    }
  }
  return { title: `Due now — ${opts.title}`.slice(0, 120), body: `${opts.leadName} · ${opts.dueLabel}` }
}

export function digestCopy(overdue: number, dueToday: number): { title: string; body: string } {
  const total = overdue + dueToday
  const parts: string[] = []
  if (overdue) parts.push(`${overdue} overdue`)
  if (dueToday) parts.push(`${dueToday} due today`)
  return {
    title: `${total} task${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} attention`,
    body: parts.join(' · ') || 'Nothing outstanding',
  }
}
