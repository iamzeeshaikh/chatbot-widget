// `type` here for the same reason as Workspace below — it is only ever a type,
// and erasing the import keeps this module loadable under Node's type stripping.
import type { NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { supabase } from './supabase'
// `type` on Workspace so the import erases cleanly — it is a type, and marking
// it lets these modules load under Node's native TypeScript stripping (which is
// how the scratch tests exercise the real code).
import { type Workspace, workspaceSites, workspaceForHost } from './workspaces'

// ── Cookie names ─────────────────────────────────────────────────────────────
// zee-session : httpOnly, HMAC-signed — the source of truth for authz (server)
// zee-auth    : readable by JS — UI hints only (email/role/workspace/sites)
export const SESSION_COOKIE = 'zee-session'
export const UI_COOKIE = 'zee-auth'

export type Role = 'admin' | 'standard'

export interface Member {
  id: string
  email: string
  workspace: Workspace
  role: Role
  assigned_sites: string[]
}

// Built-in workspace admins. These keep working without any DB row so the
// dashboards never lock out, and they are the bootstrap admins that create
// other members within their own workspace.
// The password is provided via the BUILTIN_ADMIN_PASSWORD env var — never
// hardcode credentials in source.
const BUILTIN_ADMIN_PASSWORD = process.env.BUILTIN_ADMIN_PASSWORD || ''
export const HARDCODED_ACCOUNTS: { email: string; password: string; workspace: Workspace }[] = [
  { email: 'packaging@zeeops.dev', password: BUILTIN_ADMIN_PASSWORD, workspace: 'packaging' },
  { email: 'sports@zeeops.dev', password: BUILTIN_ADMIN_PASSWORD, workspace: 'sports' },
]

// ── Signed session token: `<payload>.<hmac>` ─────────────────────────────────
// Two shapes: built-in account (by email) or a Supabase-auth member (by uid).
// `iat` (issued-at, unix seconds) is stamped on every token by signSession and
// is what makes a password change able to kill sessions that already exist.
type SessionPayload = ({ t: 'h'; e: string } | { t: 'm'; uid: string }) & { iat?: number }

function secret(): string {
  return process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signSession(payload: SessionPayload): string {
  const data = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) }))
  const sig = createHmac('sha256', secret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null
  const [data, sig] = token.split('.')
  if (!data || !sig) return null
  const expected = createHmac('sha256', secret()).update(data).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString())
  } catch {
    return null
  }
}

// ── Session revocation ───────────────────────────────────────────────────────
// Changing a member's password must log that member out everywhere: our own
// `zee-session` cookie is signed by us and lives a week, so it keeps working
// long after the Supabase password behind it has changed.
//
// The cutoff is stored per user in the Supabase auth user's `user_metadata` —
// there is no DDL here, so `members` cannot grow a column for it. Any token
// issued before the cutoff (including every token from before this existed,
// which carries no `iat` at all) is dead.
//
// The lookup is an extra admin round trip, so it is cached per process for a
// minute; a revocation therefore takes at most that long to bite on an already
// warm serverless instance.
const REVOKE_KEY = 'sessions_valid_from'
const REVOKE_TTL_MS = 60_000
const revokeCache = new Map<string, { readAt: number; validFrom: number }>()

async function sessionsValidFrom(uid: string): Promise<number> {
  const hit = revokeCache.get(uid)
  if (hit && Date.now() - hit.readAt < REVOKE_TTL_MS) return hit.validFrom
  const { data } = await supabase.auth.admin.getUserById(uid)
  const raw = (data?.user?.user_metadata as Record<string, unknown> | undefined)?.[REVOKE_KEY]
  const validFrom = typeof raw === 'number' ? raw : 0
  revokeCache.set(uid, { readAt: Date.now(), validFrom })
  return validFrom
}

/** Kill every session this member currently holds. Call after a password change. */
export async function revokeSessions(uid: string): Promise<void> {
  const { data } = await supabase.auth.admin.getUserById(uid)
  const existing = (data?.user?.user_metadata as Record<string, unknown> | undefined) ?? {}
  const validFrom = Math.floor(Date.now() / 1000)
  await supabase.auth.admin.updateUserById(uid, { user_metadata: { ...existing, [REVOKE_KEY]: validFrom } })
  revokeCache.set(uid, { readAt: Date.now(), validFrom })
}

// The dashboard this request was addressed to, when the hostname binds one
// (HOST_WORKSPACES in lib/workspaces.ts). Vercel puts the real hostname in
// x-forwarded-host; `host` is the fallback for local runs.
export function requestWorkspace(req: NextRequest): Workspace | null {
  return workspaceForHost(req.headers.get('x-forwarded-host') || req.headers.get('host'))
}

// Resolve the authenticated member. Built-in accounts are synthesised; real
// members are read fresh from the DB so role/site changes (and deletion) take
// effect immediately.
export async function getMember(req: NextRequest): Promise<Member | null> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value)
  if (!session) return null

  // The account must belong to the dashboard whose domain was asked for — a
  // session minted elsewhere (or before this rule) is nothing here.
  const bound = requestWorkspace(req)

  if (session.t === 'h') {
    const acct = HARDCODED_ACCOUNTS.find((a) => a.email === session.e)
    if (!acct) return null
    if (bound && acct.workspace !== bound) return null
    return { id: `builtin:${acct.email}`, email: acct.email, workspace: acct.workspace, role: 'admin', assigned_sites: [] }
  }

  const [{ data }, validFrom] = await Promise.all([
    supabase
      .from('members')
      .select('id, email, workspace, role, assigned_sites')
      .eq('id', session.uid)
      .maybeSingle(),
    sessionsValidFrom(session.uid),
  ])
  if (!data) return null
  if (bound && data.workspace !== bound) return null
  if ((session.iat ?? 0) < validFrom) return null
  return {
    id: data.id,
    email: data.email,
    workspace: data.workspace as Workspace,
    role: data.role as Role,
    assigned_sites: data.assigned_sites ?? [],
  }
}

/**
 * Look a member up by address — for the paths where there is no cookie to read.
 *
 * Twilio's webhooks are the case: the browser softphone identifies itself with
 * a client identity that decodes back to an email, and the webhook still has to
 * decide what that member is allowed to reach. Built-in accounts are
 * synthesised the same way getMember does it, so the owner account works there
 * too.
 */
export async function memberByEmail(email: string): Promise<Member | null> {
  const addr = String(email || '').toLowerCase().trim()
  if (!addr) return null
  const acct = HARDCODED_ACCOUNTS.find((a) => a.email === addr)
  if (acct) {
    return { id: `builtin:${acct.email}`, email: acct.email, workspace: acct.workspace, role: 'admin', assigned_sites: [] }
  }
  const { data } = await supabase
    .from('members')
    .select('id, email, workspace, role, assigned_sites')
    .ilike('email', addr)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id,
    email: data.email,
    workspace: data.workspace as Workspace,
    role: data.role as Role,
    assigned_sites: data.assigned_sites ?? [],
  }
}

// The set of sites a member may access. Admins see every site in their
// workspace; standard members see only their assigned subset.
export function memberSites(member: Member): string[] {
  if (member.role === 'admin') return workspaceSites(member.workspace)
  // A standard member with NO sites picked gets the whole workspace, not
  // nothing. Two reasons, both from how this is actually used:
  //   • it is the sane default — a member added without a site list was
  //     previously blind, which reads as a broken account rather than a policy;
  //   • it stays true on its own. Listing every site on every member means
  //     going back and editing all of them the day a site is added, and the one
  //     nobody remembers to edit is the one that quietly loses leads.
  // Narrowing someone to a few sites still works exactly as before: pick them,
  // and only those apply. Empty means "everything in this workspace" — never
  // anything outside it.
  return member.assigned_sites.length > 0 ? member.assigned_sites : workspaceSites(member.workspace)
}

export function siteScope(member: Member): Set<string> {
  return new Set(memberSites(member))
}

export function canAccessSite(member: Member, siteId: string): boolean {
  return siteScope(member).has(siteId)
}

// The site a chat session belongs to (derived from its logs), or null.
export async function siteOfSession(sessionId: string): Promise<string | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('site_id')
    .eq('session_id', sessionId)
    .limit(1)
    .maybeSingle()
  return data?.site_id ?? null
}

export async function canAccessSession(member: Member, sessionId: string): Promise<boolean> {
  const siteId = await siteOfSession(sessionId)
  return siteId ? canAccessSite(member, siteId) : false
}
