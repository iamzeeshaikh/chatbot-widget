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
import { chunks } from './bulk'
import { writeControlRow } from './leadrecord'
import {
  REMINDER_SITE, LEDGER_SESSION, CRM_PREFS_ROLE, CRM_REMINDER_ROLE, PREFS_SESSION,
  parsePrefs, prefsFor, quietHoldUntil,
} from './reminders'
import { sendPushToMember } from './push'
import { siteWorkspace, hasFeature } from './workspaces'
import { currentStateForIds } from './leadstate'
import { CRM_EMAIL_ROLE, parseCrmEmail } from './crmemail'
import {
  CRM_EMAIL_IN_ROLE, parseCrmEmailIn, splitQuoted, inboundSnippet, parseFromHeader,
  MAX_INBOUND_BODY, CRM_EMAIL_SWEEP_ROLE, type CrmEmailInEntry,
} from './emailreply'
import {
  googleConfig, fetchThread, fetchAttachment, connectionFor, GmailAuthError, GmailScopeError,
  type GoogleConfig, type InboundMessage,
} from './gmail'
import {
  EMAIL_ATTACHMENT_BUCKET, MAX_INBOUND_ATTACHMENT_BYTES, MAX_INBOUND_TOTAL_BYTES,
  MAX_EMAIL_ATTACHMENTS, isAllowedEmailAttachment, attachmentPath, humanSize,
  type EmailAttachment,
} from './emailattach'

export const SWEEP_STATUS_SESSION = 'zeeops-crm-email-sweep'

// ── TUNING ───────────────────────────────────────────────────────────────────
// Everything that decides how much work one run does lives here.

/** Threads older than this stop being polled — a dead thread is not worth a call. */
export const THREAD_ACTIVE_DAYS = 30

/**
 * Gmail thread fetches per run.
 *
 * The binding constraint is the FUNCTION TIMEOUT, not Gmail's quota and not the
 * database. threads.get costs 10 quota units against a 15,000/user/minute
 * budget, so even 300 fetches is ~2% of it; the DB side is one paginated read.
 * What actually runs out is the 60s maxDuration, and only because the fetches
 * used to be sequential. They now run THREAD_CONCURRENCY at a time, so 240
 * threads cost roughly 240/8 x ~300ms = 9s of the budget.
 */
export const MAX_THREADS_PER_RUN = 240

/** Parallel Gmail fetches. Same reasoning as BULK_CONCURRENCY in lib/bulk.ts. */
export const THREAD_CONCURRENCY = 8

/**
 * A thread with activity this recent is checked on EVERY run regardless of
 * rotation — a conversation someone is in the middle of should not wait for its
 * turn in the queue.
 */
export const FRESH_ACTIVITY_MS = 3 * 60 * 60 * 1000

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
  /** One entry per reply we tried to notify someone about. */
  notices?: ReplyNotice[]
  /** Live threads in the window, vs how many this run checked. */
  totalThreads?: number
  checkedThreads?: number
  /** Where rotation resumes next run. */
  cursor?: string | null
  /** True when there are more live threads than one run can cover. */
  rotating?: boolean
  /** Runs needed to visit every thread once, at the current cap. */
  fullCycleRuns?: number
}

export interface ThreadRef {
  threadId: string; sessionId: string; siteId: string; agent: string
  /** Newest activity on the thread, sent OR received. */
  lastAt: string
}

/**
 * Every thread we started inside the window — ALL of them, not a page.
 *
 * The previous version took the 500 newest crm_email rows and then the 60
 * newest threads out of those. Both were silent truncations: with more than 60
 * live threads the same 60 won every run forever and thread 61 was never
 * looked at again, so its replies were never captured and nothing said so.
 */
async function allThreads(now: Date): Promise<ThreadRef[]> {
  const since = new Date(now.getTime() - THREAD_ACTIVE_DAYS * 86_400_000).toISOString()

  const seen = new Map<string, ThreadRef>()
  // Outbound rows define which threads exist and who owns them.
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('chat_logs')
      .select('session_id, site_id, message, created_at')
      .eq('role', CRM_EMAIL_ROLE)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    for (const r of data ?? []) {
      const e = parseCrmEmail(r.message)
      if (!e?.threadId || !e.sentBy) continue
      const prev = seen.get(e.threadId)
      if (prev) {
        if (r.created_at > prev.lastAt) prev.lastAt = r.created_at
        continue
      }
      seen.set(e.threadId, {
        threadId: e.threadId, sessionId: r.session_id, siteId: r.site_id,
        agent: e.sentBy, lastAt: r.created_at,
      })
    }
    if (!data || data.length < 1000) break
  }

  // A captured reply also counts as activity, so an active back-and-forth stays
  // in the fresh tier rather than ageing out because we happened not to send.
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('chat_logs')
      .select('message, created_at')
      .eq('role', CRM_EMAIL_IN_ROLE)
      .gte('created_at', since)
      .range(from, from + 999)
    for (const r of data ?? []) {
      const e = parseCrmEmailIn(r.message)
      if (!e?.threadId) continue
      const t = seen.get(e.threadId)
      if (t && r.created_at > t.lastAt) t.lastAt = r.created_at
    }
    if (!data || data.length < 1000) break
  }

  return [...seen.values()]
}

export interface Selection { picked: ThreadRef[]; nextCursor: string | null; total: number; starved: boolean }

/**
 * Choose which threads this run checks. Pure, so it can be tested without Gmail.
 *
 * Two tiers:
 *  1. FRESH — anything active within FRESH_ACTIVITY_MS is always included. A
 *     live conversation should not wait its turn.
 *  2. ROTATION — everything else is walked in a stable threadId order from a
 *     persisted cursor, wrapping at the end. That is what makes coverage a
 *     guarantee rather than a hope: every thread is reached within
 *     ceil(total / cap) runs no matter how many there are.
 *
 * threadId is used for the ordering rather than a timestamp because it never
 * changes. Ordering by "last sent" would let a thread move under the cursor
 * whenever someone emailed it, and a thread that keeps moving can be stepped
 * over forever — the same starvation in a subtler form.
 */
export function selectThreads(
  all: ThreadRef[],
  opts: { cursor?: string | null; now?: Date; cap?: number; freshMs?: number } = {},
): Selection {
  const now = opts.now ?? new Date()
  const cap = opts.cap ?? MAX_THREADS_PER_RUN
  const freshMs = opts.freshMs ?? FRESH_ACTIVITY_MS
  const cursor = opts.cursor ?? null

  const cutoff = now.getTime() - freshMs
  const fresh: ThreadRef[] = []
  const rest: ThreadRef[] = []
  for (const t of all) {
    const at = new Date(t.lastAt.endsWith('Z') ? t.lastAt : `${t.lastAt}Z`).getTime()
    if (Number.isFinite(at) && at >= cutoff) fresh.push(t)
    else rest.push(t)
  }
  fresh.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
  rest.sort((a, b) => a.threadId.localeCompare(b.threadId))

  const picked = fresh.slice(0, cap)
  let nextCursor = cursor
  const room = cap - picked.length

  if (room > 0 && rest.length > 0) {
    // Start just after the cursor, then wrap — so a run that reaches the end
    // continues from the beginning instead of stopping short.
    let start = rest.findIndex((t) => t.threadId > (cursor ?? ''))
    if (start < 0) start = 0
    const take = Math.min(room, rest.length)
    for (let i = 0; i < take; i++) picked.push(rest[(start + i) % rest.length])
    nextCursor = picked[picked.length - 1]?.threadId ?? cursor
  }

  return {
    picked,
    nextCursor,
    total: all.length,
    // True when one run cannot cover everything, i.e. rotation is doing work.
    starved: all.length > cap,
  }
}

/** Back-compat helper used by diagnostics: what this run would check. */
export async function activeThreads(now = new Date(), cursor: string | null = null): Promise<ThreadRef[]> {
  return selectThreads(await allThreads(now), { now, cursor }).picked
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

  // Rotation state rides on the previous run's status row, so no new storage
  // and nothing to keep in sync.
  const prev = await lastSweepStatus()
  const all = await allThreads(now)
  const sel = selectThreads(all, { now, cursor: prev?.cursor ?? null })
  const threads = sel.picked
  const captured = await alreadyCaptured([...new Set(threads.map((t) => t.sessionId))])

  // Group by agent: one connection check and one token refresh per agent
  // rather than per thread.
  const byAgent = new Map<string, ThreadRef[]>()
  for (const t of threads) {
    if (!byAgent.has(t.agent)) byAgent.set(t.agent, [])
    byAgent.get(t.agent)!.push(t)
  }

  const results: SweepAgentResult[] = []
  // Replies captured THIS run — the only ones worth notifying about. Anything
  // already on the record was notified when it arrived.
  const fresh: { entry: CrmEmailInEntry; sessionId: string; siteId: string; agent: string }[] = []
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

    // Fetches run in waves rather than one after another: sequentially, 240
    // threads at ~300ms each would blow the 60s function budget, which is the
    // real ceiling on the cap (not Gmail quota, not the database).
    let stop = false
    for (const wave of chunks(refs, THREAD_CONCURRENCY)) {
      if (stop) break
      const settled = await Promise.allSettled(wave.map(async (ref: ThreadRef) => {
        const messages = await fetchThread(agent, cfg, ref.threadId)
        return { ref, messages }
      }))
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          const e = outcome.reason
          const scopey = e instanceof GmailScopeError
          const authy = e instanceof GmailAuthError
          res.error = e instanceof Error ? e.message : 'Could not read Gmail.'
          res.needsReconnect = scopey || authy
          // A dead token or missing scope will fail identically for every other
          // thread, so stop this agent rather than hammering the API.
          if (scopey || authy) stop = true
          continue
        }
        const { ref, messages } = outcome.value
        for (const m of messages) {
          if (captured.has(m.gmailId)) continue
          // Our own copy of the outbound message lives in the same thread.
          if (m.labelIds.includes('SENT')) continue
          if (!m.from) continue

          const from = parseFromHeader(m.from)
          // Belt and braces: never record something we sent as an inbound reply.
          if (from.email === agent.toLowerCase()) continue

          const grabbed = await grabAttachments(agent, cfg, m, ref.siteId, ref.sessionId)
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
            attachments: grabbed.saved,
            skippedAttachments: grabbed.skipped.length ? grabbed.skipped : undefined,
          }
          // dryRun reports exactly what WOULD be captured and writes nothing —
          // the same escape hatch the reminder sweep offers, so this can be
          // inspected against a live mailbox without touching a lead.
          if (!dryRun) {
            // created_at is left to default to NOW — the moment we learned of
            // the reply — and deliberately NOT backdated to the email's send
            // time. The timeline orders inbound by `entry.at` (the JSON field),
            // so display is unaffected, while the row's created_at stays a
            // truthful "when was this written".
            //
            // Backdating broke live updates: /api/crm/version reports
            // max(created_at) for the lead, so a reply captured after any later
            // row (a read-mark, a note) landed BELOW the marker, the marker
            // never moved, and an open record never refetched. The reply only
            // appeared on a manual refresh.
            const { error } = await writeControlRow({
              sessionId: ref.sessionId, siteId: ref.siteId,
              role: CRM_EMAIL_IN_ROLE, message: JSON.stringify(entry),
            })
            if (error) throw new Error(error)
          }
          captured.add(m.gmailId)
          res.captured++
          if (!dryRun) fresh.push({ entry, sessionId: ref.sessionId, siteId: ref.siteId, agent })
        }
      }
    }
    results.push(res)
  }

  const notices = dryRun ? [] : await notifyReplies(fresh, now)

  const out: SweepResult = {
    ranAt,
    agents: results,
    notices,
    captured: results.reduce((n, r) => n + r.captured, 0),
    errors: results.filter((r) => r.error).length,
    dryRun,
    totalThreads: sel.total,
    checkedThreads: threads.length,
    // A dry run must not advance rotation, or it would skip threads for the
    // real run that follows it.
    cursor: dryRun ? (prev?.cursor ?? null) : sel.nextCursor,
    rotating: sel.starved,
    fullCycleRuns: Math.max(1, Math.ceil(sel.total / MAX_THREADS_PER_RUN)),
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

// ── replying into an existing thread (Phase 6) ───────────────────────────────
export interface ThreadContext {
  threadId: string
  /** Message-ID of the message being replied to. */
  inReplyTo: string
  /** Every Message-ID in the conversation, oldest first. */
  references: string[]
}

/**
 * Rebuild the threading headers for a reply, from OUR OWN rows on this lead.
 *
 * The browser only says which message it is replying to; everything else is
 * derived here. That is deliberate — a client-supplied threadId would let a
 * request drop a message into a Gmail conversation belonging to a different
 * lead, or one this member cannot see. Nothing is used unless it is on the lead
 * the caller already passed guardLeadAccess for.
 *
 * Returns null when the id is not one of this lead's messages, in which case
 * the caller sends a fresh (unthreaded) email rather than guessing.
 */
export async function threadContextFor(sessionId: string, replyToGmailId: string): Promise<ThreadContext | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('role, message, created_at')
    .eq('session_id', sessionId)
    .in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE])
    .order('created_at', { ascending: true })
    .limit(500)

  interface Msg { gmailId: string; threadId: string; messageId: string }
  const all: Msg[] = []
  for (const r of data ?? []) {
    if (r.role === CRM_EMAIL_ROLE) {
      const e = parseCrmEmail(r.message)
      if (e?.gmailId) all.push({ gmailId: e.gmailId, threadId: e.threadId, messageId: e.messageId })
    } else {
      const e = parseCrmEmailIn(r.message)
      if (e?.gmailId) all.push({ gmailId: e.gmailId, threadId: e.threadId, messageId: e.messageId })
    }
  }

  const target = all.find((m) => m.gmailId === replyToGmailId)
  if (!target?.threadId) return null

  // References is the ancestry of THIS thread only, oldest first.
  const references = all
    .filter((m) => m.threadId === target.threadId && m.messageId)
    .map((m) => m.messageId)

  return {
    threadId: target.threadId,
    inReplyTo: target.messageId,
    references,
  }
}

// ── notifying the owner of a reply (Phase 6) ─────────────────────────────────
// Reuses the Phase 3 push stack wholesale — same subscriptions, same
// preferences, same quiet-hours rule, same claim-before-send ledger — rather
// than inventing a second notification channel with its own bugs.
//
// WHO IS TOLD
//   1. the lead's owner, when it has one
//   2. otherwise the agent whose mailbox the reply actually landed in, i.e.
//      whoever sent the message being answered
// An unassigned lead is not nobody's problem: the reply is sitting in a real
// person's inbox, and that person is the one who can act on it. Broadcasting to
// the whole workspace would make every reply everyone's notification, which is
// how a team learns to ignore them.
//
// EXACTLY ONCE, EVER
// Claimed on `reply:<gmailId>:<recipient>` before the push is attempted, so a
// re-run, a double cron fire or a retry cannot notify twice. Quiet hours HOLD
// (no ledger row, retried later) rather than dropping.

export interface ReplyNotice { to: string; gmailId: string; leadId: string; state: 'sent' | 'held' | 'skipped'; why?: string }

export function replyNotifyKey(gmailId: string, to: string): string {
  return `reply:${gmailId}:${to.trim().toLowerCase()}`
}

async function notifiedAlready(): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('chat_logs')
      .select('message')
      .eq('session_id', LEDGER_SESSION)
      .eq('role', CRM_REMINDER_ROLE)
      .range(from, from + 999)
    for (const r of data ?? []) {
      try {
        const o = JSON.parse(r.message)
        if (typeof o?.k === 'string' && o.k.startsWith('reply:')) out.add(o.k)
      } catch { /* not ours */ }
    }
    if (!data || data.length < 1000) break
  }
  return out
}

/** Push one notification per newly captured reply, to exactly one person. */
async function notifyReplies(
  fresh: { entry: CrmEmailInEntry; sessionId: string; siteId: string; agent: string }[],
  now: Date,
): Promise<ReplyNotice[]> {
  const out: ReplyNotice[] = []
  if (fresh.length === 0) return out

  const [owners, already, prefsRows] = await Promise.all([
    currentStateForIds([...new Set(fresh.map((f) => f.sessionId))]),
    notifiedAlready(),
    supabase.from('chat_logs').select('message')
      .eq('session_id', PREFS_SESSION).eq('role', CRM_PREFS_ROLE)
      .order('created_at', { ascending: true }).limit(500),
  ])

  // Newest prefs row per member wins, the same fold the reminder sweep uses.
  const prefsByEmail = new Map<string, ReturnType<typeof parsePrefs>>()
  for (const r of prefsRows.data ?? []) {
    const p = parsePrefs(r.message)
    if (p?.email) prefsByEmail.set(p.email.toLowerCase(), p)
  }

  for (const f of fresh) {
    // Owner first; otherwise whoever's mailbox it landed in.
    const to = (owners.get(f.sessionId)?.owner || f.agent || '').trim().toLowerCase()
    if (!to) { out.push({ to: '', gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: 'nobody-to-notify' }); continue }

    const k = replyNotifyKey(f.entry.gmailId, to)
    if (already.has(k)) { out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: 'already-notified' }); continue }

    const prefs = prefsFor(to, prefsByEmail.get(to) ?? undefined)
    // `enabled` is the member's master switch for push; respected here so one
    // toggle silences task reminders and reply alerts alike.
    if (!prefs.enabled) { out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: 'notifications-off' }); continue }

    // Quiet hours HOLD rather than drop: no ledger row is written, so the next
    // run after the window opens picks it up and it is still delivered once.
    const hold = quietHoldUntil(now, prefs)
    if (hold) { out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'held', why: `quiet until ${hold.toISOString()}` }); continue }

    const ws = siteWorkspace(f.siteId)
    if (!ws) { out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: 'unknown-workspace' }); continue }
    if (!hasFeature(ws, 'email')) { out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: 'workspace-has-no-email' }); continue }

    // Claim BEFORE sending — a push that succeeds after a crash must not be
    // repeatable, and a duplicate notification is worse than a missed retry.
    const { error } = await supabase.from('chat_logs').insert({
      site_id: REMINDER_SITE, session_id: LEDGER_SESSION, role: CRM_REMINDER_ROLE,
      message: JSON.stringify({ k, kind: 'reply', to, at: now.toISOString(), state: 'sent', gmailId: f.entry.gmailId }),
    })
    if (error) { out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: 'ledger-write-failed' }); continue }
    already.add(k)

    try {
      const who = f.entry.fromName || f.entry.from
      await sendPushToMember(to, ws, {
        title: `${who} replied`,
        body: f.entry.snippet || f.entry.subject || 'New email reply',
        url: `/leads/${encodeURIComponent(f.sessionId)}`,
        tag: `reply-${f.entry.gmailId}`,
      })
      out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'sent' })
    } catch (e) {
      // The claim stands: retrying would risk a double notification, and the
      // reply is on the record either way.
      out.push({ to, gmailId: f.entry.gmailId, leadId: f.sessionId, state: 'skipped', why: `push failed: ${e instanceof Error ? e.message : 'error'}` })
    }
  }
  return out
}

/**
 * Copy a customer's attachments into the private bucket.
 *
 * Three guards, because this runs unattended against files a stranger chose:
 *  • an ALLOWLIST of types, plus an extension check, so an .exe announced as a
 *    PDF is still refused — nothing executable is ever fetched, let alone stored
 *  • a per-file and a per-message byte ceiling, checked against Gmail's declared
 *    size BEFORE downloading, so one 200MB attachment cannot eat the sweep's
 *    60-second budget
 *  • a count cap
 *
 * Anything refused is RECORDED rather than dropped silently: the timeline says
 * "2 attachments were not saved" and why, so nobody assumes a file arrived.
 */
async function grabAttachments(
  agent: string, cfg: GoogleConfig, m: InboundMessage, siteId: string, sessionId: string,
): Promise<{ saved: EmailAttachment[]; skipped: { name: string; why: string }[] }> {
  const saved: EmailAttachment[] = []
  const skipped: { name: string; why: string }[] = []
  let total = 0

  for (const a of m.attachments ?? []) {
    if (saved.length >= MAX_EMAIL_ATTACHMENTS) {
      skipped.push({ name: a.name, why: 'too many attachments on one message' })
      continue
    }
    if (!isAllowedEmailAttachment(a.mime, a.name)) {
      skipped.push({ name: a.name, why: 'file type not allowed' })
      continue
    }
    // Checked from the declared size first — refusing before the download is
    // the whole point of the budget.
    if (a.size > MAX_INBOUND_ATTACHMENT_BYTES) {
      skipped.push({ name: a.name, why: `too large (${humanSize(a.size)})` })
      continue
    }
    if (total + a.size > MAX_INBOUND_TOTAL_BYTES) {
      skipped.push({ name: a.name, why: 'message attachment total too large' })
      continue
    }

    try {
      const bytes = await fetchAttachment(agent, cfg, m.gmailId, a.attachmentId)
      if (!bytes) { skipped.push({ name: a.name, why: 'could not be downloaded' }); continue }
      // Gmail's declared size can differ from what arrives; re-check the truth.
      if (bytes.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
        skipped.push({ name: a.name, why: `too large (${humanSize(bytes.byteLength)})` })
        continue
      }
      const path = attachmentPath(siteId, sessionId, 'in', a.name)
      const { error } = await supabase.storage
        .from(EMAIL_ATTACHMENT_BUCKET)
        .upload(path, bytes, { contentType: a.mime, upsert: false })
      if (error) { skipped.push({ name: a.name, why: 'could not be stored' }); continue }
      total += bytes.byteLength
      saved.push({ path, name: a.name, mime: a.mime, size: bytes.byteLength })
    } catch {
      skipped.push({ name: a.name, why: 'could not be downloaded' })
    }
  }
  return { saved, skipped }
}
