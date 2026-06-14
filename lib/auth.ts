import { NextRequest } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { supabase } from './supabase'
import { Workspace, workspaceSites } from './workspaces'

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
export const HARDCODED_ACCOUNTS: { email: string; password: string; workspace: Workspace }[] = [
  { email: 'packaging@zeeops.dev', password: 'uzairzia@4321', workspace: 'packaging' },
  { email: 'sports@zeeops.dev', password: 'uzairzia@4321', workspace: 'sports' },
]

// ── Signed session token: `<payload>.<hmac>` ─────────────────────────────────
// Two shapes: built-in account (by email) or a Supabase-auth member (by uid).
type SessionPayload = { t: 'h'; e: string } | { t: 'm'; uid: string }

function secret(): string {
  return process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signSession(payload: SessionPayload): string {
  const data = b64url(JSON.stringify(payload))
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

// Resolve the authenticated member. Built-in accounts are synthesised; real
// members are read fresh from the DB so role/site changes (and deletion) take
// effect immediately.
export async function getMember(req: NextRequest): Promise<Member | null> {
  const session = verifySession(req.cookies.get(SESSION_COOKIE)?.value)
  if (!session) return null

  if (session.t === 'h') {
    const acct = HARDCODED_ACCOUNTS.find((a) => a.email === session.e)
    if (!acct) return null
    return { id: `builtin:${acct.email}`, email: acct.email, workspace: acct.workspace, role: 'admin', assigned_sites: [] }
  }

  const { data } = await supabase
    .from('members')
    .select('id, email, workspace, role, assigned_sites')
    .eq('id', session.uid)
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
  return member.role === 'admin' ? workspaceSites(member.workspace) : member.assigned_sites
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
