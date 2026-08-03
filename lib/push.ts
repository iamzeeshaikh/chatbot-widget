// Web Push to agents' installed PWAs — works with the app closed. No DDL:
// each device subscription is a chat_logs control row (role 'push_sub',
// message JSON { email, ws, endpoint, sub | gone }). Latest row per endpoint
// wins, so unsubscribing or a dead endpoint (410/404 on send) just appends a
// { gone: true } row. VAPID keys live in env (VAPID_PUBLIC_KEY/PRIVATE_KEY).

import webpush from 'web-push'
import { supabase } from './supabase'
import type { Workspace } from './workspaces'

export const PUSH_SUB_ROLE = 'push_sub'
const PUSH_SITE = 'zeeops-push'

let vapidReady: boolean | null = null
function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady
  const pub = process.env.VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) {
    console.error('[push] VAPID keys missing — push disabled')
    vapidReady = false
    return false
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@zeeops.dev', pub, priv)
  vapidReady = true
  return true
}

interface SubRow {
  email: string
  ws: string
  endpoint: string
  /**
   * Stable per-browser-profile id, minted client-side and kept in
   * localStorage. See savePushSubscription for why it exists. Absent on rows
   * written before it was introduced.
   */
  did?: string
  sub?: webpush.PushSubscription
  gone?: boolean
}

/**
 * Register this device, retiring whatever this same device had before.
 *
 * The fold below is keyed on ENDPOINT, which dedupes a repeat save of the same
 * subscription but not a *new* endpoint from a browser that already had one —
 * and a browser can mint several. Real case: three distinct live endpoints
 * appeared for one member inside one second, and two live endpoints sat on one
 * account for three weeks, each getting its own copy of every notification.
 * Nothing retired them, because an orphan is only ever cleaned up when a send
 * comes back 404/410, and an orphan that is still LIVE never does.
 *
 * So dedupe on the device instead: one member on one browser profile holds at
 * most one active subscription, and re-subscribing replaces rather than adds.
 * `did` is the only thing that can carry that — endpoints rotate, user agents
 * are not unique, and there is no DDL to add a real device table.
 *
 * Rows written before `did` existed are deliberately NOT swept up here: they
 * are unattributable, and a member legitimately running a laptop and a phone
 * would lose one. They retire on their own when they die.
 */
export async function savePushSubscription(email: string, ws: Workspace, sub: webpush.PushSubscription, did?: string): Promise<void> {
  if (did) {
    for (const prev of await safeSubs(ws)) {
      if (prev.did !== did) continue
      if ((prev.email ?? '').trim().toLowerCase() !== email.trim().toLowerCase()) continue
      if (prev.endpoint === sub.endpoint) continue
      await removePushSubscription(email, ws, prev.endpoint).catch(() => {})
    }
  }
  await supabase.from('chat_logs').insert({
    site_id: PUSH_SITE,
    session_id: PUSH_SITE,
    role: PUSH_SUB_ROLE,
    message: JSON.stringify({ email, ws, endpoint: sub.endpoint, did, sub } satisfies SubRow),
  })
}

export async function removePushSubscription(email: string, ws: Workspace, endpoint: string): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: PUSH_SITE,
    session_id: PUSH_SITE,
    role: PUSH_SUB_ROLE,
    message: JSON.stringify({ email, ws, endpoint, gone: true } satisfies SubRow),
  })
}

// Active subscriptions for a workspace: fold rows oldest→newest, last action
// per endpoint wins.
async function listSubscriptions(ws: Workspace): Promise<SubRow[]> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('role', PUSH_SUB_ROLE)
    .order('created_at', { ascending: true })
  const byEndpoint = new Map<string, SubRow>()
  for (const r of data ?? []) {
    try {
      const o = JSON.parse(r.message) as SubRow
      if (!o?.endpoint) continue
      if (o.gone) byEndpoint.delete(o.endpoint)
      else if (o.ws === ws && o.sub) byEndpoint.set(o.endpoint, o)
    } catch { /* skip */ }
  }
  return Array.from(byEndpoint.values())
}

export interface PushPayload {
  title: string
  body: string
  url: string
  tag?: string
}

// Fire-and-forget: never throws (a push failure must never break chat).
export async function sendPushToWorkspace(ws: Workspace, payload: PushPayload): Promise<void> {
  return deliver(await safeSubs(ws), payload)
}

// One member's devices only. Task reminders are personal — the assignee gets
// them and nobody else — so this filters the workspace's subscriptions down to
// a single email rather than broadcasting.
//
// Returns how many devices actually accepted the push, so the reminder sweep
// can tell "delivered" from "this member has no device registered".
export async function sendPushToMember(email: string, ws: Workspace, payload: PushPayload): Promise<number> {
  const target = email.trim().toLowerCase()
  if (!target) return 0
  const subs = (await safeSubs(ws)).filter((s) => (s.email ?? '').trim().toLowerCase() === target)
  if (subs.length === 0) return 0
  await deliver(subs, payload)
  return subs.length
}

async function safeSubs(ws: Workspace): Promise<SubRow[]> {
  try {
    if (!ensureVapid()) return []
    return await listSubscriptions(ws)
  } catch (err) {
    console.error('[push] listSubscriptions failed (non-fatal):', err instanceof Error ? err.message : err)
    return []
  }
}

async function deliver(subs: SubRow[], payload: PushPayload): Promise<void> {
  try {
    if (subs.length === 0) return
    if (!ensureVapid()) return
    const body = JSON.stringify(payload)
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(s.sub!, body, { TTL: 300 })
      } catch (err) {
        const code = (err as { statusCode?: number })?.statusCode
        if (code === 404 || code === 410) {
          // Endpoint is dead (uninstalled / permissions revoked) — retire it.
          await removePushSubscription(s.email, s.ws as Workspace, s.endpoint).catch(() => {})
        } else {
          console.error('[push] send failed:', code, err instanceof Error ? err.message : err)
        }
      }
    }))
  } catch (err) {
    console.error('[push] deliver failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}
