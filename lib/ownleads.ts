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
import { ASSIGNMENT_ROLE, deriveAssignments, getAssignment } from './assignment'
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

/**
 * Every lead / session currently assigned to this member.
 *
 * Two small queries instead of a fold over every assignment row in the
 * workspace (~21k): first the sessions that were EVER assigned to them (an
 * ILIKE on their address, bounded by site scope), then the full assignment
 * history of just those sessions, folded newest-wins, so a lead that has since
 * been handed to somebody else drops out.
 */
export async function ownedSessions(m: Member): Promise<Set<string>> {
  const me = norm(m.email)
  if (!me) return new Set()
  const sites = workspaceSites(m.workspace)
  const { data: hits } = await supabase.from('chat_logs')
    .select('session_id')
    .eq('role', ASSIGNMENT_ROLE)
    .in('site_id', m.assigned_sites.length > 0 ? m.assigned_sites : sites)
    .ilike('message', me)
    .limit(5000)
  const candidates = [...new Set((hits ?? []).map((r) => String(r.session_id)))]
  const out = new Set<string>()
  for (let i = 0; i < candidates.length; i += 150) {
    const chunk = candidates.slice(i, i + 150)
    const { data } = await supabase.from('chat_logs')
      .select('session_id, role, message, created_at')
      .in('session_id', chunk).eq('role', ASSIGNMENT_ROLE)
      .order('created_at', { ascending: true }).limit(5000)
    const folded = deriveAssignments((data ?? []) as { session_id: string; role: string; message: string }[])
    for (const [sid, email] of Object.entries(folded)) if (norm(email) === me) out.add(sid)
  }
  return out
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
  '/api/calls/target', '/api/twilio/voice/dial',
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
