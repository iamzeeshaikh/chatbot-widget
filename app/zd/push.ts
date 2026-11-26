'use client'

// ZeeDesk's half of web push: this device's subscription.
//
// The server side is shared with the other dashboards on purpose
// (/api/admin/push-subscribe, lib/push.ts, public/sw.js): a subscription is
// stored against the signed-in member AND their workspace, so a ZeeDesk
// device only ever receives ZeeDesk pushes. What is ZeeDesk's own is this
// file and the rail button that drives it.
//
// The per-device id is what lets the server retire whatever subscription this
// browser profile held before, so switching on twice replaces instead of
// adding a second copy of every notification (CLAUDE.md, "Push subscriptions
// dedupe on the DEVICE").

export type PushState = 'unsupported' | 'blocked' | 'off' | 'on'

const OFF_KEY = 'zd-push-off'
const REFRESHED_KEY = 'zd-push-refreshed'

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'

function deviceId(): string {
  try {
    const k = 'zd-push-did'
    let v = localStorage.getItem(k)
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v) }
    return v
  } catch { return '' }
}

const post = (body: unknown) => fetch('/api/admin/push-subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function subscribe(reg: ServiceWorkerRegistration): Promise<void> {
  const { publicKey } = await fetch('/api/admin/push-subscribe').then((r) => r.json())
  if (!publicKey) throw new Error('Notifications are not set up on the server yet.')
  const old = await reg.pushManager.getSubscription()
  if (old) await old.unsubscribe().catch(() => false)
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
  const res = await post({ subscription: sub.toJSON(), deviceId: deviceId() })
  if (!res.ok) throw new Error('This device could not be registered. Try again.')
}

/**
 * Where this device stands, read on load. Also the daily self-heal: a
 * subscription the push service has dropped still looks alive in the browser,
 * so where notifications are already on (and the member has not switched them
 * off here) a fresh one is minted once a day, with no click needed.
 */
export async function readPushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    let optedOut = false, stamp = ''
    try { optedOut = localStorage.getItem(OFF_KEY) === '1'; stamp = localStorage.getItem(REFRESHED_KEY) ?? '' } catch { /* ignore */ }
    const today = new Date().toISOString().slice(0, 10)
    if (sub && !optedOut && Notification.permission === 'granted' && stamp !== today) {
      try { await subscribe(reg); try { localStorage.setItem(REFRESHED_KEY, today) } catch { /* ignore */ } } catch { /* the old one stays; tomorrow tries again */ }
      return 'on'
    }
    return sub ? 'on' : 'off'
  } catch { return 'off' }
}

/** Switch notifications on for this device. Must run from a click: browsers
 *  (iPhone above all) only show the permission prompt for a user gesture. */
export async function enablePush(): Promise<{ state: PushState; note: string }> {
  if (!supported()) return { state: 'unsupported', note: 'This browser cannot show notifications. On an iPhone, install ZeeDesk to the Home Screen first, then switch them on from inside the app.' }
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return { state: perm === 'denied' ? 'blocked' : 'off', note: 'Notifications are blocked for this site. Allow them in the browser settings (the padlock in the address bar), then try again.' }
    await subscribe(await navigator.serviceWorker.ready)
    try { localStorage.removeItem(OFF_KEY); localStorage.setItem(REFRESHED_KEY, new Date().toISOString().slice(0, 10)) } catch { /* ignore */ }
    return { state: 'on', note: 'Notifications are on for this device. New chats, leads and reminders reach it even when ZeeDesk is closed.' }
  } catch (e) {
    return { state: 'off', note: e instanceof Error && e.message ? e.message : 'Notifications could not be switched on for this device.' }
  }
}

export async function disablePush(): Promise<{ state: PushState; note: string }> {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await post({ remove: true, endpoint: sub.endpoint }).catch(() => null)
      await sub.unsubscribe().catch(() => false)
    }
    try { localStorage.setItem(OFF_KEY, '1') } catch { /* ignore */ }
    return { state: 'off', note: 'Notifications are off for this device.' }
  } catch { return { state: 'off', note: 'Notifications could not be switched off. Try again.' } }
}

/** Tell the service worker whether a push may make a sound. A push is drawn
 *  and sounded outside the tab, so ZeeDesk's own sound switch has to be sent
 *  across; the worker cannot read localStorage. */
export function mirrorSoundToWorker(on: boolean): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.ready
    .then((reg) => { (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'zee-sound', on }) })
    .catch(() => { /* no worker: nothing to mirror */ })
}
