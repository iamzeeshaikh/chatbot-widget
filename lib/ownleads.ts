// "Own leads only": a standard member who sees ONLY the leads assigned to them.
//
// Added 2026-11-10 for a new packaging sales agent on the Mark Taylor login.
// The team lead's words: give him the login, but not all customers and not all
// leads — only his own; prices, estimates and design requests too.
//
// Every other standard member sees their own leads PLUS the unassigned pool
// (lib/teamlead.ts explains why the pool matters). This member sees neither
// the pool nor anyone else's: a lead is his when its CURRENT assignment
// (lib/assignment.ts, newest `assignment` row) is his address. Somebody else
// has to hand him work by assigning it.
//
// STORAGE: a flag on the Supabase auth user's `user_metadata`
// (`own_leads_only: true`), the same place `sessions_valid_from` lives — no
// DDL, so `members` cannot grow a column, and getMember already reads that
// metadata (cached 60s) on every request, so the flag is on the Member object
// for free. Admins are never restricted, whatever the flag says.
//
// ENFORCEMENT is server-side, in three layers:
//   • guardLeadAccess refuses a lead that is not his — every /api/leads/[id]/*
//     route, so opening, emailing, calling, quoting and invoicing all follow;
//   • every list (leads, billing tiles, pipeline, search, inbox, chats, tasks,
//     jobs) filters to his leads, and the screens that are about everybody
//     (visitors, analytics, opportunities, costing) refuse him with a 403;
//   • getMember() treats him as signed out on any API that has not been
//     decided for this rule (OWN_LEADS_API below), so a route added tomorrow
//     is closed to him until somebody decides what he may see in it.

import { supabase } from './supabase'
import { ASSIGNMENT_ROLE, getAssignment } from './assignment'
import { workspaceSites } from './workspaces'
import type { Member } from './auth'

export const OWN_LEADS_KEY = 'own_leads_only'

/** Is this member limited to the leads assigned to them? */
export function isOwnLeadsOnly(m: Pick<Member, 'role'> & { ownLeadsOnly?: boolean } | null | undefined): boolean {
  return !!m && m.role !== 'admin' && m.ownLeadsOnly === true
}

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase()

/** Is `owner` (an assignee address, or null) this member? */
export function isOwnedBy(m: Pick<Member, 'email'>, owner: string | null | undefined): boolean {
  const o = norm(owner)
  return !!o && o === norm(m.email)
}

/**
 * May this member touch this lead / chat session? Always true for a member
 * without the flag (their existing rules apply elsewhere); for a flagged member
 * true only when the session's current assignment is theirs.
 */
export async function ownsSession(m: Member, sessionId: string): Promise<boolean> {
  if (!isOwnLeadsOnly(m)) return true
  if (!sessionId) return false
  return isOwnedBy(m, await getAssignment(sessionId))
}

const OWNED_TTL_MS = 20_000
/** Re-read this much before the watermark on every refresh, so a row whose
 *  created_at lands a little behind one already seen is not missed. */
const OVERLAP_MS = 10 * 60_000

/** Per member, per server instance: the newest assignee of every session that
 *  was ever assigned to them, plus the newest assignment row folded in. */
interface OwnedState { owner: Map<string, string>; watermark: string; at: number; sites: string }
const ownedState = new Map<string, OwnedState>()
const ownedInFlight = new Map<string, Promise<Set<string>>>()

/** Every page of a query, in its stable order — and a THROW, not a partial
 *  answer, if any page fails. A partial history here is not "fewer leads": a
 *  missing hand-over row would make a lead look his after it had moved on. */
async function allPages<T>(make: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < 200_000; from += 1000) {
    const { data, error } = await make().range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
  throw new Error('ownedSessions: row cap reached')
}

/**
 * Every lead / session currently assigned to this member.
 *
 * First call on an instance: the sessions EVER assigned to them (an ILIKE on
 * their address, bounded by site scope), then the full assignment history of
 * just those sessions via the session index, folded newest-wins — so a lead
 * that has since been handed to somebody else drops out. That costs a few
 * seconds for a login with thousands of past assignments.
 *
 * After that it is INCREMENTAL: every refresh reads only assignment rows newer
 * than the watermark (the created_at index) and applies them — a row naming
 * him adds the session, any other row on one of his sessions moves it on.
 * Every assignment is written by setAssignment() at server time, so nothing
 * lands behind the watermark by more than the overlap re-read.
 *
 * Shared in flight and memoised 20s. Assignment changes therefore take up to
 * that long to show in his LISTS; a record is still decided fresh by
 * ownsSession(). On any database error the answer is the empty set: he sees
 * nothing rather than too much.
 */
export async function ownedSessions(m: Member): Promise<Set<string>> {
  const me = norm(m.email)
  if (!me) return new Set()
  const sites = m.assigned_sites.length > 0 ? m.assigned_sites : workspaceSites(m.workspace)
  const prev = ownedState.get(me)
  const fresh = prev && prev.sites === sites.join(',') && Date.now() - prev.at < OWNED_TTL_MS
  if (fresh) return mineOf(prev, me)
  const running = ownedInFlight.get(me)
  if (running) return running
  const job = (prev && prev.sites === sites.join(',') ? refreshOwned(prev, sites, me) : foldOwned(sites, me))
    .then((state) => { ownedState.set(me, state); return mineOf(state, me) })
    .catch((e) => {
      ownedState.delete(me)
      console.error('[ownedSessions] failed — showing nothing:', e instanceof Error ? e.message : e)
      return new Set<string>()
    })
    .finally(() => ownedInFlight.delete(me))
  ownedInFlight.set(me, job)
  return job
}

function mineOf(state: OwnedState, me: string): Set<string> {
  const out = new Set<string>()
  for (const [sid, owner] of state.owner) if (owner === me) out.add(sid)
  return out
}

type AssignRow = { session_id: string; message: string; created_at: string }

async function foldOwned(sites: string[], me: string): Promise<OwnedState> {
  const startedAt = new Date().toISOString()
  const hits = await allPages<{ session_id: string }>(() => supabase.from('chat_logs')
    .select('session_id')
    .eq('role', ASSIGNMENT_ROLE)
    .in('site_id', sites)
    .ilike('message', me)
    .order('created_at', { ascending: true }).order('id', { ascending: true }))
  const candidates = [...new Set(hits.map((r) => String(r.session_id)))]
  const chunks: string[][] = []
  for (let i = 0; i < candidates.length; i += 250) chunks.push(candidates.slice(i, i + 250))
  const owner = new Map<string, string>()
  for (let i = 0; i < chunks.length; i += 6) {
    const pages = await Promise.all(chunks.slice(i, i + 6).map((chunk) => allPages<AssignRow>(() => supabase.from('chat_logs')
      .select('session_id, message, created_at')
      .in('session_id', chunk).eq('role', ASSIGNMENT_ROLE)
      .order('created_at', { ascending: true }).order('id', { ascending: true }))))
    for (const rows of pages) for (const r of rows) owner.set(String(r.session_id), norm(r.message))
  }
  // The watermark is when this fold STARTED: anything written while it ran is
  // re-read by the next refresh rather than assumed seen.
  return { owner, watermark: startedAt, at: Date.now(), sites: sites.join(',') }
}

async function refreshOwned(prev: OwnedState, sites: string[], me: string): Promise<OwnedState> {
  const startedAt = new Date().toISOString()
  const since = new Date(Date.parse(prev.watermark) - OVERLAP_MS).toISOString()
  const rows = await allPages<AssignRow>(() => supabase.from('chat_logs')
    .select('session_id, message, created_at')
    .eq('role', ASSIGNMENT_ROLE)
    .in('site_id', sites)
    .gte('created_at', since)
    .order('created_at', { ascending: true }).order('id', { ascending: true }))
  const owner = new Map(prev.owner)
  // Ascending, so the newest row per session is applied last. Re-applying the
  // overlap is harmless: the same rows in the same order give the same answer.
  for (const r of rows) {
    const sid = String(r.session_id)
    const who = norm(r.message)
    if (who === me || owner.has(sid)) owner.set(sid, who)
  }
  return { owner, watermark: startedAt, at: Date.now(), sites: prev.sites }
}

/** The 403 a flagged member gets from a screen that is about everybody's
 *  leads. `extra` keeps a polled endpoint's empty shape, so a page that reads
 *  `d.visitors ?? []` without checking `ok` renders empty instead of breaking. */
// A plain Response, not NextResponse: this module is imported by lib/auth.ts,
// which the scratch tests load under Node's type stripping, where the bare
// `next/server` specifier does not resolve.
export function ownLeadsRefusal(extra: Record<string, unknown> = {}): Response {
  return Response.json(
    { ...extra, error: 'Not available on this account — it shows only the leads assigned to you.', ownLeadsOnly: true },
    { status: 403 },
  )
}

// ── Which APIs have been decided for this rule ───────────────────────────────
// Each entry is either filtered to the member's own leads, refuses them with a
// 403, or never returned lead data in the first place (auth, presence, own
// signature, push, Gmail connection, cron/admin-only routes). `*` matches one
// path segment. Anything NOT listed is refused in getMember().
const OWN_LEADS_API = [
  // identity / account / plumbing
  '/api/auth/*', '/api/version', '/api/admin/push-subscribe', '/api/admin/presence', '/api/admin/sites',
  '/api/signature', '/api/signature/site', '/api/google/gmail/*', '/api/tasks/prefs', '/api/twilio/voice/token',
  '/api/admin/block',
  // filtered to his own leads
  '/api/admin/leads-list', '/api/admin/leads-billing', '/api/admin/conversations', '/api/admin/messages',
  '/api/admin/visitor', '/api/admin/assign', '/api/admin/reply', '/api/admin/mode', '/api/admin/typing',
  '/api/admin/translate', '/api/admin/lead-status', '/api/upload', '/api/pipeline', '/api/pipeline/bulk',
  '/api/search', '/api/search/state', '/api/inbox', '/api/inbox/whatsapp', '/api/tasks', '/api/tasks/count',
  '/api/jobs', '/api/jobs/*', '/api/jobs/*/messages', '/api/jobs/*/production', '/api/crm/version',
  '/api/calls/target', '/api/twilio/voice/dial', '/api/lost', '/api/lost/recover', '/api/lost/reason',
  '/api/leads/*', '/api/leads/*/*', '/api/leads/*/*/*', '/api/leads/*/*/*/*',
  // refused (403) for him — by this rule, or already admin/owner-only
  '/api/admin/analytics', '/api/admin/analytics/breakdown', '/api/admin/visitors-history', '/api/visitor/active',
  '/api/opportunities', '/api/opportunities/followups', '/api/costing', '/api/costing/shipping', '/api/growth',
  '/api/sales', '/api/sales/*', '/api/admin/performance', '/api/admin/report', '/api/admin/attendance',
  '/api/admin/backup', '/api/admin/chat-download', '/api/admin/delete-lead', '/api/admin/delete-session',
  '/api/admin/edit-lead', '/api/admin/mark-lead', '/api/admin/members', '/api/admin/team-lead',
  '/api/admin/intake-drops', '/api/admin/groq-models', '/api/admin/model', '/api/admin/mail-check',
  '/api/admin/twilio-status', '/api/costing/sweep', '/api/crm/*', '/api/crm/email/sweep', '/api/intake/*',
  '/api/tasks/reminders/sweep',
]

export function ownLeadsMayCall(pathname: string): boolean {
  const parts = pathname.replace(/\/+$/, '').split('/')
  return OWN_LEADS_API.some((p) => {
    const pp = p.split('/')
    return pp.length === parts.length && pp.every((seg, i) => seg === '*' ? parts[i] !== '' : seg === parts[i])
  })
}

/**
 * Jobs (estimates, designs, production) for a flagged member: a job on one of
 * his leads, or one he opened himself. `mine` is ownedSessions(m); pass null
 * for anyone without the flag and every job passes.
 */
export function jobVisibleTo(
  m: Pick<Member, 'email'>, job: { leadId?: string; createdBy?: string }, mine: Set<string> | null,
): boolean {
  if (!mine) return true
  return (!!job.leadId && mine.has(job.leadId)) || isOwnedBy(m, job.createdBy)
}

/** ownedSessions(m) for a flagged member, null for everyone else. */
export async function ownedSessionsIfLimited(m: Member): Promise<Set<string> | null> {
  return isOwnLeadsOnly(m) ? ownedSessions(m) : null
}
