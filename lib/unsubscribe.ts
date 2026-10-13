// Unsubscribing from promotional email — a signed link, no login.
//
// The token is the address plus an HMAC, so a link cannot be edited to
// unsubscribe somebody else, and nothing about it needs a table (no DDL): an
// unsubscribe is a `crm_unsub` control row on the reserved zeeops-crm site,
// newest per address wins, so re-subscribing later is just another row.
//
// Only PROMOTIONAL mail checks this. Answering someone's own quote request is
// not marketing, and the bot's follow-ups also respect it so "stop" means stop.

import { createHmac, timingSafeEqual } from 'crypto'
import { supabase } from './supabase'

export const CRM_UNSUB_ROLE = 'crm_unsub'
const SITE = 'zeeops-crm'
const SESSION = 'zeeops-unsubscribes'

function secret(): string {
  return process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
}

export function unsubscribeToken(email: string): string {
  const e = Buffer.from(email.trim().toLowerCase(), 'utf8').toString('base64url')
  const sig = createHmac('sha256', `unsub:${secret()}`).update(e).digest('base64url').slice(0, 22)
  return `${e}.${sig}`
}

export function emailFromToken(token: string): string | null {
  const [e, sig] = String(token || '').split('.')
  if (!e || !sig) return null
  const want = createHmac('sha256', `unsub:${secret()}`).update(e).digest('base64url').slice(0, 22)
  const a = Buffer.from(sig), b = Buffer.from(want)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return Buffer.from(e, 'base64url').toString('utf8')
}

export function unsubscribeUrl(base: string, email: string): string {
  return `${base.replace(/\/$/, '')}/api/unsubscribe/${unsubscribeToken(email)}`
}

export async function recordUnsubscribe(email: string, via: string): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: SITE, session_id: SESSION, role: CRM_UNSUB_ROLE,
    message: JSON.stringify({ email: email.trim().toLowerCase(), unsubscribed: true, via, at: new Date().toISOString() }),
  })
}

/** Every address currently unsubscribed. Small: one row per person who asked. */
export async function unsubscribedSet(): Promise<Set<string>> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('role', CRM_UNSUB_ROLE).eq('session_id', SESSION).order('created_at', { ascending: true }).limit(20000)
  const out = new Set<string>()
  for (const r of data ?? []) {
    try {
      const o = JSON.parse(r.message)
      if (typeof o.email !== 'string') continue
      if (o.unsubscribed) out.add(o.email); else out.delete(o.email)
    } catch { /* skip */ }
  }
  return out
}
