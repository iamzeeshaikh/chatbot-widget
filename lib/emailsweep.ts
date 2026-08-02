// Pull customer replies into the lead timeline.
//
// ── Why polling, not Gmail push ──────────────────────────────────────────────
// Gmail push (users.watch + Cloud Pub/Sub) is real-time, but it watches the
// WHOLE mailbox: every message an agent receives would hit our endpoint and we
// would filter afterwards, which is exactly the "read the agent's wider inbox"
// this phase is supposed to avoid. It also needs a Pub/Sub topic, a public
// subscriber endpoint, and a watch that must be renewed every 7 days — and when
// that renewal lapses, replies stop arriving with nothing to notice it by.
//
// Polling threads we started is the opposite trade: a few minutes of latency in
// exchange for reading only what we already have a thread id for, no new
// infrastructure, and a job that is safe to run late, twice, or after a missed
// window because it is keyed on Gmail's immutable message ids. It reuses the
// cron pattern lib/reminderssweep.ts already established.
//
// ── Nothing fails silently ───────────────────────────────────────────────────
// Every per-agent failure is recorded on the reserved zeeops-crm site as a
// sweep-status row, surfaced by /api/crm/email/status and shown on the record.
// A token that expired, a connection missing the read scope, or a Gmail outage
// are all visible rather than swallowed.

import { supabase } from './supabase'
import { writeControlRow } from './leadrecord'
import { REMINDER_SITE } from './reminders'
import { CRM_EMAIL_ROLE, parseCrmEmail } from './crmemail'
import {
  CRM_EMAIL_IN_ROLE, parseCrmEmailIn, splitQuoted, inboundSnippet, parseFromHeader,
  MAX_INBOUND_BODY, CRM_EMAIL_SWEEP_ROLE, type CrmEmailInEntry,
} from './emailreply'
import {
  googleConfig, fetchThread, connectionFor, GmailAuthError, GmailScopeError,
  type GoogleConfig,
} from './gmail'

export const SWEEP_STATUS_SESSION = 'zeeops-crm-email-sweep'

/** Threads older than this stop being polled — a dead thread is not worth a call. */
export const THREAD_ACTIVE_DAYS = 30
/** Ceiling on Gmail calls per run, so one sweep can never stampede the API. */
export const MAX_THREADS_PER_RUN = 60

export interface SweepAgentResult {
  agent: string
  threads: number
  captured: number
  error?: string
  needsReconnect?: boolean
}

export interface SweepResult {
  ranAt: string
  agents: SweepAgentResult[]
  /** On a dry run this is what WOULD have been captured. */
  captured: number
  errors: number
  dryRun?: boolean
}

interface ThreadRef { threadId: string; sessionId: string; siteId: string; agent: string; lastAt: string }

/**
 * Every thread we started that is still worth polling: one entry per
 * (thread, lead), newest activity first, capped.
 */
export async function activeThreads(now = new Date()): Promise<ThreadRef[]> {
  const since = new Date(now.getTime() - THREAD_ACTIVE_DAYS * 86_400_000).toISOString()
  const { data } = await supabase
    .from('chat_logs')
    .select('session_id, site_id, message, created_at')
    .eq('role', CRM_EMAIL_ROLE)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(500)

  const seen = new Map<string, ThreadRef>()
  for (const r of data ?? []) {
    const e = parseCrmEmail(r.message)
    if (!e?.threadId || !e.sentBy) continue
    // One poll per thread, attributed to whoever sent it — that is whose
    // mailbox the reply lands in.
    if (seen.has(e.threadId)) continue
    seen.set(e.threadId, {
      threadId: e.threadId, sessionId: r.session_id, siteId: r.site_id,
      agent: e.sentBy, lastAt: r.created_at,
    })
  }
  return [...seen.values()].slice(0, MAX_THREADS_PER_RUN)
}

/** Gmail ids already captured for these leads, so the sweep never duplicates. */
async function alreadyCaptured(sessionIds: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  if (sessionIds.length === 0) return out
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('role', CRM_EMAIL_IN_ROLE)
    .in('session_id', sessionIds)
    .limit(2000)
  for (const r of data ?? []) {
    const e = parseCrmEmailIn(r.message)
    if (e) out.add(e.gmailId)
  }
  return out
}

/**
 * One pass. `origin` is needed only to build the Google redirect URI, which the
 * token refresh requires; nothing here depends on the request.
 */
export async function runEmailSweep(
  origin: string,
  now = new Date(),
  opts: { dryRun?: boolean } = {},
): Promise<SweepResult> {
  const dryRun = opts.dryRun === true
  const ranAt = now.toISOString()
  const cfg = googleConfig(origin)
  if (!cfg) {
    return { ranAt, agents: [], captured: 0, errors: 0, dryRun }
  }

  const threads = await activeThreads(now)
  const captured = await alreadyCaptured([...new Set(threads.map((t) => t.sessionId))])

  // Group by agent: one connection check and one token refresh per agent
  // rather than per thread.
  const byAgent = new Map<string, ThreadRef[]>()
  for (const t of threads) {
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, [])
    byAgent.get(t.agent)!.push(t)
  }

  const results: SweepAgentResult[] = []
  for (const [agent, refs] of byAgent) {
    const res: SweepAgentResult = { agent, threads: refs.length, captured: 0 }
    const conn = await connectionFor(agent)
    if (!conn || conn.revoked) {
      res.error = conn?.revokedReason ?? 'Gmail is not connected for this agent.'
      res.needsReconnect = true
      results.push(res)
      continue
    }
    if (!conn.canRead) {
      res.error = 'This Gmail connection predates reply capture. Reconnect Gmail to let replies appear here.'
      res.needsReconnect = true
      results.push(res)
      continue
    }

    for (const ref of refs) {
      try {
        const messages = await fetchThread(agent, cfg, ref.threadId)
        for (const m of messages) {
          if (captured.has(m.gmailId)) continue
          // Our own copy of the outbound message lives in the same thread.
          if (m.labelIds.includes('SENT')) continue
          if (!m.from) continue

          const from = parseFromHeader(m.from)
          // Belt and braces: never record something we sent as an inbound reply.
          if (from.email === agent.toLowerCase()) continue

          const split = splitQuoted(m.bodyText)
          const entry: CrmEmailInEntry = {
            gmailId: m.gmailId,
            threadId: m.threadId,
            messageId: m.messageId,
            inReplyTo: m.inReplyTo,
            from: from.email,
            fromName: from.name,
            to: m.to,
            subject: m.subject,
            body: split.visible.slice(0, MAX_INBOUND_BODY),
            quoted: split.quoted ? split.quoted.slice(0, MAX_INBOUND_BODY) : null,
            snippet: inboundSnippet(split.visible),
            at: m.at || ranAt,
            direction: 'inbound',
          }
          // dryRun reports exactly what WOULD be captured and writes nothing —
          // the same escape hatch the reminder sweep offers, so this can be
          // inspected against a live mailbox without touching a lead.
          if (!dryRun) {
            const { error } = await writeControlRow({
              sessionId: ref.sessionId, siteId: ref.siteId,
              role: CRM_EMAIL_IN_ROLE, at: entry.at, message: JSON.stringify(entry),
            })
            if (error) throw new Error(error)
          }
          captured.add(m.gmailId)
          res.captured++
        }
      } catch (e) {
        // One bad thread must not stop the others, and the reason is kept.
        const scopey = e instanceof GmailScopeError
        const authy = e instanceof GmailAuthError
        res.error = e instanceof Error ? e.message : 'Could not read Gmail.'
        res.needsReconnect = scopey || authy
        if (scopey || authy) break // no point trying this agent's other threads
      }
    }
    results.push(res)
  }

  const out: SweepResult = {
    ranAt,
    agents: results,
    captured: results.reduce((n, r) => n + r.captured, 0),
    errors: results.filter((r) => r.error).length,
    dryRun,
  }
  // A dry run must not overwrite the real last-run status either.
  if (!dryRun) await recordSweepStatus(out)
  return out
}

/** Last run, on the reserved site so it can never reach a lead or a preview. */
async function recordSweepStatus(result: SweepResult): Promise<void> {
  await writeControlRow({
    sessionId: SWEEP_STATUS_SESSION, siteId: REMINDER_SITE,
    role: CRM_EMAIL_SWEEP_ROLE, message: JSON.stringify(result),
  })
}

export async function lastSweepStatus(): Promise<SweepResult | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('session_id', SWEEP_STATUS_SESSION)
    .eq('role', CRM_EMAIL_SWEEP_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
  if (!data?.length) return null
  try { return JSON.parse(data[0].message) as SweepResult } catch { return null }
}

export function describeSweep(s: SweepResult | null): string {
  if (!s) return 'Reply checking has not run yet.'
  const bad = s.agents.filter((a) => a.error)
  if (bad.length === 0) return `Replies checked — ${s.captured} new.`
  return `${bad.length} mailbox${bad.length === 1 ? '' : 'es'} could not be checked: ${bad[0].error}`
}
