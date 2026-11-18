// The watchman. Every ten minutes it looks for the signs that something of
// ours has gone wrong quietly, and tells the admins once.
//
// Why it exists: between 2026-11-13 and 2026-11-17 the email sweep wrote the
// same emails again and again (a silent 1000-row cap), one mailbox ended up
// refused by Gmail for most of a day, and the first anyone knew was an agent
// asking on WhatsApp at 11 pm. Every one of those signs was sitting in the
// database for days. Nothing was reading them.
//
// What it checks, all from rows that already exist (no Gmail calls):
//   • duplicates   the same Gmail message recorded twice on one lead
//   • runaway      far more email rows written in an hour than a team can send
//   • mailbox      Gmail has kept one mailbox paused for 45 minutes or more
//   • sweep        the reply check has not finished a run for 20 minutes
//
// An alert is claimed in the ledger before it is sent, and not repeated for the
// same problem for six hours.

import { supabase, fetchAllPages } from './supabase'
import { REMINDER_SITE } from './reminders'
import { CRM_EMAIL_ROLE } from './crmemail'
import { CRM_EMAIL_IN_ROLE, CRM_EMAIL_SWEEP_ROLE } from './emailreply'
import { GMAIL_COOLDOWN_ROLE, GMAIL_COOLDOWN_SESSION, connectionFor, googleConfig, sendEmail } from './gmail'
import { sendPushToMember } from './push'
import { formatDateTime } from './datetime'

export const CRM_HEALTH_ALERT_ROLE = 'crm_health_alert'
export const HEALTH_ALERT_SESSION = 'zeeops-crm-health'

const HOUR = 60 * 60_000
const REPEAT_AFTER_MS = 6 * HOUR
const DUP_WINDOW_MS = 3 * HOUR
const RUNAWAY_PER_HOUR = 400
const PAUSED_FOR_MS = 45 * 60_000
const SWEEP_STALE_MS = 20 * 60_000
/** Who hears about it: the mailbox the owner reads, and where it is sent from. */
const ALERT_FROM = 'dev@zeecustomboxes.com'
const ALERT_TO = ['dev@zeecustomboxes.com', 'shanimazhar82@gmail.com']
const PUSH_TO = ['dev@zeecustomboxes.com', 'shanimazhar82@gmail.com', 'uzairzia19@gmail.com']
const PUBLIC_BASE = 'https://chat.zeeops.dev'

export interface Problem { key: string; title: string; body: string }
export interface EmailRow { role: string; session_id: string; message: string; created_at: string }
export interface PauseRow { message: string; created_at: string }

/** The database returns times without a zone; they are UTC, whatever the machine thinks. */
function utcMs(ts: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`)
}

function gmailIdOf(message: string): string | null {
  try { return String((JSON.parse(message) as { gmailId?: string }).gmailId ?? '') || null } catch { return null }
}

/** Pure. The same Gmail message on the same lead more than once. */
export function findDuplicates(rows: EmailRow[]): { count: number; leads: number } {
  const seen = new Set<string>()
  const leads = new Set<string>()
  let count = 0
  for (const r of rows) {
    const id = gmailIdOf(r.message)
    if (!id) continue
    const k = `${r.role}|${r.session_id}|${id}`
    if (seen.has(k)) { count++; leads.add(r.session_id) } else seen.add(k)
  }
  return { count, leads: leads.size }
}

/** Pure. Mailboxes Gmail has kept paused, back to back, for PAUSED_FOR_MS or more. */
export function longPauses(rows: PauseRow[], now: number): { email: string; since: number; until: number }[] {
  const by = new Map<string, { at: number; until: number }[]>()
  for (const r of rows) {
    try {
      const o = JSON.parse(r.message) as { email?: string; until?: number }
      if (!o.email || !Number(o.until)) continue
      const list = by.get(o.email) ?? []
      list.push({ at: utcMs(r.created_at), until: Number(o.until) })
      by.set(o.email, list)
    } catch { /* skip */ }
  }
  const out: { email: string; since: number; until: number }[] = []
  for (const [email, list] of by) {
    list.sort((a, b) => b.at - a.at)
    // Still current: nothing has shown the mailbox working since. Background
    // work stays away for up to two hours after a pause, so silence that long
    // is not recovery.
    if (now - list[0].until > 2.25 * HOUR) continue
    let since = list[0].at
    for (const p of list.slice(1)) {
      // The older pause ran into the newer one, give or take the time we stay away afterwards.
      if (since - p.until > 2.25 * HOUR) break
      since = p.at
    }
    if (now - since >= PAUSED_FOR_MS) out.push({ email, since, until: list[0].until })
  }
  return out
}

async function inspect(now: number): Promise<Problem[]> {
  const problems: Problem[] = []

  // Emails written lately, both directions, read to the end in pages.
  const since = new Date(now - DUP_WINDOW_MS).toISOString()
  const rows = await fetchAllPages<EmailRow>(() => supabase
    .from('chat_logs')
    .select('role, session_id, message, created_at')
    .in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE])
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true }), 30_000)
  const dup = findDuplicates(rows)
  if (dup.count >= 3) {
    problems.push({
      key: 'duplicates',
      title: 'Emails are being recorded twice',
      body: `${dup.count} emails were written a second time in the last 3 hours, on ${dup.leads} leads. Nothing is sent to customers twice, but this is how the Gmail lockout of 17 November started. It needs looking at now.`,
    })
  }
  const lastHour = rows.filter((r) => utcMs(r.created_at) > now - HOUR).length
  if (lastHour > RUNAWAY_PER_HOUR) {
    problems.push({
      key: 'runaway',
      title: 'Far too many email rows in one hour',
      body: `${lastHour} email rows were written in the last hour. A normal busy hour is under 100. Something is writing in a loop.`,
    })
  }

  const { data: pauses } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', GMAIL_COOLDOWN_ROLE)
    .eq('session_id', GMAIL_COOLDOWN_SESSION)
    .gte('created_at', new Date(now - 12 * HOUR).toISOString())
    .order('created_at', { ascending: false })
    .limit(900)
  for (const p of longPauses(pauses ?? [], now)) {
    const mins = Math.round((now - p.since) / 60_000)
    const length = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`
    problems.push({
      key: `mailbox:${p.email}`,
      title: `Gmail is refusing ${p.email}`,
      body: `Gmail has kept ${p.email} paused for ${length} (since ${formatDateTime(new Date(p.since).toISOString())}). That agent cannot send from ZeeOps and their customers' replies are not arriving on the record. They should work from another connected mailbox until it clears.`,
    })
  }

  const { data: sweeps } = await supabase
    .from('chat_logs')
    .select('created_at')
    .eq('role', CRM_EMAIL_SWEEP_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
  const last = sweeps?.[0]?.created_at ? utcMs(sweeps[0].created_at) : 0
  if (last && now - last > SWEEP_STALE_MS) {
    problems.push({
      key: 'sweep',
      title: 'The reply check has stopped',
      body: `ZeeOps last finished checking Gmail for customer replies ${Math.round((now - last) / 60_000)} minutes ago; it should run every 5. Replies are not reaching the records.`,
    })
  }
  return problems
}

async function recentlyAlerted(now: number): Promise<Set<string>> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('role', CRM_HEALTH_ALERT_ROLE)
    .eq('session_id', HEALTH_ALERT_SESSION)
    .gte('created_at', new Date(now - REPEAT_AFTER_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(200)
  const out = new Set<string>()
  for (const r of data ?? []) {
    try { out.add(String((JSON.parse(r.message) as { key?: string }).key ?? '')) } catch { /* skip */ }
  }
  return out
}

async function tell(p: Problem): Promise<string[]> {
  const how: string[] = []
  for (const to of PUSH_TO) {
    try {
      const n = await sendPushToMember(to, 'packaging', { title: `ZeeOps problem: ${p.title}`, body: p.body, url: '/', tag: `health-${p.key}`, sticky: true })
      if (n > 0) how.push(`push:${to}`)
    } catch { /* the email below still goes */ }
  }
  try {
    const cfg = googleConfig(PUBLIC_BASE)
    const conn = cfg ? await connectionFor(ALERT_FROM) : null
    if (cfg && conn && !conn.revoked) {
      await sendEmail(ALERT_FROM, cfg, {
        from: ALERT_FROM, to: ALERT_TO.join(', '),
        subject: `ZeeOps problem: ${p.title}`,
        body: `${p.body}\n\nThis is an automatic check that runs every 10 minutes. The same problem is not reported again for 6 hours.`,
      })
      how.push('email')
    }
  } catch (e) {
    how.push(`email failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return how
}

export interface HealthRun { ok: boolean; problems: Problem[]; alerted: { key: string; how: string[] }[]; dry: boolean }

export async function runHealthWatch(opts: { dry?: boolean; now?: Date } = {}): Promise<HealthRun> {
  const now = (opts.now ?? new Date()).getTime()
  const problems = await inspect(now)
  const alerted: { key: string; how: string[] }[] = []
  if (opts.dry || problems.length === 0) return { ok: problems.length === 0, problems, alerted, dry: !!opts.dry }
  const done = await recentlyAlerted(now)
  for (const p of problems) {
    if (done.has(p.key)) continue
    // Claim first: a crash after this loses one alert rather than repeating it every run.
    const { error } = await supabase.from('chat_logs').insert({
      site_id: REMINDER_SITE, session_id: HEALTH_ALERT_SESSION, role: CRM_HEALTH_ALERT_ROLE,
      message: JSON.stringify({ key: p.key, title: p.title, body: p.body, at: new Date(now).toISOString() }),
    })
    if (error) continue
    alerted.push({ key: p.key, how: await tell(p) })
  }
  return { ok: false, problems, alerted, dry: false }
}
