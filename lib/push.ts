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
  sub?: webpush.PushSubscription
  gone?: boolean
}

export async function savePushSubscription(email: string, ws: Workspace, sub: webpush.PushSubscription): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: PUSH_SITE,
    session_id: PUSH_SITE,
    role: PUSH_SUB_ROLE,
    message: JSON.stringify({ email, ws, endpoint: sub.endpoint, sub } satisfies SubRow),
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
  try {
    if (!ensureVapid()) return
    const subs = await listSubscriptions(ws)
    if (subs.length === 0) return
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
    console.error('[push] sendPushToWorkspace failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}
