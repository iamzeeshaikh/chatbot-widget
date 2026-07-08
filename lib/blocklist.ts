// IP blocklist — persisted WITHOUT any schema change (no DDL), as chat_logs
// control rows: role 'blocked_visitor', message JSON { ip, block, by, at }.
// Rows are append-only; the LATEST row per IP wins (so unblocking appends a
// { block:false } row). Enforcement is global across all sites.
//
// Enforced in three places, so a blocked visitor:
//   • never sees the widget at all (site-config returns blocked:true),
//   • can't create live-visitor rows (visitor/ping ignores them),
//   • can't send chat messages (api/chat drops them silently).
// The set is cached in-memory per server instance for CACHE_MS, so a new block
// takes effect within a minute everywhere.

import { supabase } from './supabase'

export const BLOCKED_ROLE = 'blocked_visitor'
// Control rows need a site_id; blocks are global so they live under a marker id.
export const BLOCKLIST_SITE = 'zeeops-blocklist'

export interface BlockEntry { ip: string; block: boolean; by: string; at: string }

export function parseBlockEntry(message: string | null | undefined): BlockEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && typeof o.ip === 'string' && o.ip) {
      return { ip: o.ip, block: o.block !== false, by: typeof o.by === 'string' ? o.by : '', at: typeof o.at === 'string' ? o.at : '' }
    }
  } catch { /* not a block row */ }
  return null
}

const CACHE_MS = 60 * 1000
let cache: { at: number; ips: Set<string> } | null = null

// Currently blocked IPs (latest action per IP wins). Never throws — on any
// error it returns the last cache or an empty set, so chat can't break.
export async function getBlockedIps(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ips
  try {
    const { data } = await supabase
      .from('chat_logs')
      .select('message')
      .eq('role', BLOCKED_ROLE)
      .order('created_at', { ascending: true })
    const ips = new Set<string>()
    for (const r of data ?? []) {
      const e = parseBlockEntry(r.message)
      if (!e) continue
      if (e.block) ips.add(e.ip)
      else ips.delete(e.ip)
    }
    cache = { at: Date.now(), ips }
    return ips
  } catch (err) {
    console.error('[blocklist] getBlockedIps failed:', err instanceof Error ? err.message : err)
    return cache?.ips ?? new Set()
  }
}

// Append a block/unblock action and invalidate the local cache immediately.
export async function setIpBlocked(ip: string, block: boolean, by: string): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: BLOCKLIST_SITE,
    session_id: BLOCKLIST_SITE,
    role: BLOCKED_ROLE,
    message: JSON.stringify({ ip, block, by, at: new Date().toISOString() } satisfies BlockEntry),
  })
  cache = null
}

export function requestIp(headers: Headers): string {
  return (headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
}
