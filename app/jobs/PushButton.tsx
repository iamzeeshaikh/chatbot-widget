'use client'

// Notifications on/off for the Jobs pages. The dashboard has its own switch,
// but the designer/estimator never sees the dashboard (lib/jobsonly.ts), and a
// job assigned to someone who gets no alert waits until they happen to look.
// Same endpoint and device-id rule as the dashboard's switch (app/page.tsx).

import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'

function deviceId(): string {
  try {
    const k = 'zee-push-did'
    let v = localStorage.getItem(k)
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v) }
    return v
  } catch { return '' }
}

export default function PushButton() {
  const [state, setState] = useState<'unsupported' | 'off' | 'on'>('unsupported')
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    navigator.serviceWorker.ready.then(async (reg) => setState((await reg.pushManager.getSubscription()) ? 'on' : 'off')).catch(() => setState('off'))
  }, [])
  if (state === 'unsupported') return null

  async function toggle() {
    try {
      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      if (existing) {
        await fetch('/api/admin/push-subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: true, endpoint: existing.endpoint }) }).catch(() => {})
        await existing.unsubscribe(); setState('off'); return
      }
      if ((await Notification.requestPermission()) !== 'granted') { alert('Notifications are blocked for this site — allow them in your browser settings.'); return }
      const { publicKey } = await fetch('/api/admin/push-subscribe').then((r) => r.json())
      if (!publicKey) { alert('Notifications are not set up on the server.'); return }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
      await fetch('/api/admin/push-subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), deviceId: deviceId() }) })
      setState('on')
    } catch { alert('Could not turn on notifications on this device.') }
  }

  return (
    <button type="button" onClick={toggle} title={state === 'on' ? 'Notifications are on — click to turn off' : 'Get a notification when a job is assigned to you or someone writes on it'}
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${state === 'on' ? 'border-emerald-300 bg-emerald-100 text-emerald-700' : 'border-amber-300 bg-amber-100 text-amber-700'}`}>
      {state === 'on' ? <Bell size={13} aria-hidden /> : <BellOff size={13} aria-hidden />}
      {state === 'on' ? 'Alerts on' : 'Turn on alerts'}
    </button>
  )
}
