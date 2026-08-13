// IP blocklist — persisted WITHOUT any schema change (no DDL), as chat_logs
// control rows: role 'blocked_visitor', message JSON { ip, block, by, at, ws }.
// Rows are append-only; the LATEST row per IP wins (so unblocking appends a
// { block:false } row).
//
// ── Enforcement is per WORKSPACE, not global (2026-08-13) ────────────────────
// It used to be global, which meant a sports admin could block an IP and hide
// the widget on all 22 packaging sites — the one place either workspace could
// act on the other's live sites. A block now belongs to the workspace of the
// admin who set it, and is only enforced on that workspace's sites.
//
// Rows written before `ws` existed are read as PACKAGING: packaging is the only
// workspace that has ever used this in practice, so that keeps every existing
// block doing exactly what it does today rather than silently lapsing.
//
// Enforced in three places, so a blocked visitor:
//   • never sees the widget at all (site-config returns blocked:true),
//   • can't create live-visitor rows (visitor/ping ignores them),
//   • can't send chat messages (api/chat drops them silently).
// The set is cached in-memory per server instance for CACHE_MS, so a new block
// takes effect within a minute everywhere.

import { supabase } from './supabase'
import type { Workspace } from './workspaces'

export const BLOCKED_ROLE = 'blocked_visitor'
// Control rows need a site_id; the list spans sites, so it lives under a marker id.
export const BLOCKLIST_SITE = 'zeeops-blocklist'

/** A row with no `ws` predates workspace scoping — see the header note. */
const LEGACY_WORKSPACE: Workspace = 'packaging'

export interface BlockEntry { ip: string; block: boolean; by: string; at: string; ws: Workspace }

export function parseBlockEntry(message: string | null | undefined): BlockEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && typeof o.ip === 'string' && o.ip) {
      return {
        ip: o.ip,
        block: o.block !== false,
        by: typeof o.by === 'string' ? o.by : '',
        at: typeof o.at === 'string' ? o.at : '',
        ws: o.ws === 'sports' || o.ws === 'packaging' ? o.ws : LEGACY_WORKSPACE,
      }
    }
  } catch { /* not a block row */ }
  return null
}

const CACHE_MS = 60 * 1000
let cache: { at: number; byWs: Map<Workspace, Set<string>> } | null = null

function forWs(byWs: Map<Workspace, Set<string>>, ws?: Workspace): Set<string> {
  if (ws) return byWs.get(ws) ?? new Set()
  // No workspace given: the union, which is what a caller with nothing but an
  // IP (and no site) should compare against.
  const all = new Set<string>()
  for (const set of byWs.values()) for (const ip of set) all.add(ip)
  return all
}

// Currently blocked IPs for a workspace (latest action per IP wins). Never
// throws — on any error it returns the last cache or an empty set, so chat
// can't break. Omitting `ws` returns every workspace's blocks.
export async function getBlockedIps(ws?: Workspace): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return forWs(cache.byWs, ws)
  try {
    const { data } = await supabase
      .from('chat_logs')
      .select('message')
      .eq('role', BLOCKED_ROLE)
      .order('created_at', { ascending: true })
    const byWs = new Map<Workspace, Set<string>>()
    for (const r of data ?? []) {
      const e = parseBlockEntry(r.message)
      if (!e) continue
      const set = byWs.get(e.ws) ?? new Set<string>()
      if (e.block) set.add(e.ip)
      else set.delete(e.ip)
      byWs.set(e.ws, set)
    }
    cache = { at: Date.now(), byWs }
    return forWs(byWs, ws)
  } catch (err) {
    console.error('[blocklist] getBlockedIps failed:', err instanceof Error ? err.message : err)
    return cache ? forWs(cache.byWs, ws) : new Set()
  }
}

// Append a block/unblock action and invalidate the local cache immediately.
// `ws` is the acting admin's workspace, never anything client-supplied.
export async function setIpBlocked(ip: string, block: boolean, by: string, ws: Workspace): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: BLOCKLIST_SITE,
    session_id: BLOCKLIST_SITE,
    role: BLOCKED_ROLE,
    message: JSON.stringify({ ip, block, by, at: new Date().toISOString(), ws } satisfies BlockEntry),
  })
  cache = null
}

export function requestIp(headers: Headers): string {
  return (headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
}
