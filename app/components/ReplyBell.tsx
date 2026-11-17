'use client'

// The big reply bell on EVERY page except the dashboard, which rings it itself
// (app/page.tsx, playReplyBell). Before this, an agent sitting on the Inbox or
// on a lead record heard nothing when a customer answered — the bell only
// lived on the dashboard. Same endpoint and cadence as the dashboard badge
// (60s visible, every 4th tick hidden), same mute switch (localStorage
// "zee-dash-sound"), and it stops for good on a 401/403: a public page has no
// session. Packaging only.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!ctx) ctx = new AC()
  return ctx
}

// Packaging only: the sports dashboard was not asked for this and keeps its
// own chime. Read from the same non-httpOnly zee-auth cookie WorkspaceChrome uses.
function isPackaging(): boolean {
  try {
    const raw = document.cookie.split('; ').find((c) => c.startsWith('zee-auth='))?.split('=')[1]
    if (!raw) return false
    const ws = JSON.parse(atob(decodeURIComponent(raw)))?.workspace
    return ws === 'packaging' || ws === 'zeedesk'
  } catch {
    return false
  }
}

function soundOn(): boolean {
  try { return localStorage.getItem('zee-dash-sound') !== 'off' } catch { return true }
}

export function ringReplyBell() {
  if (!soundOn()) return
  const c = audio()
  if (!c) return
  try {
    if (c.state === 'suspended') void c.resume()
    // The same warm chord, struck twice, as playReplyBell on the dashboard
    // (app/page.tsx) — the owner's pick of 2026-11-17. Keep the two in step.
    const master = c.createGain(); master.gain.value = 0.8
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000
    master.connect(lp); lp.connect(c.destination)
    const voice = (type: OscillatorType, freq: number, t: number, decay: number, peak: number) => {
      const osc = c.createOscillator(); const gain = c.createGain()
      osc.connect(gain); gain.connect(master)
      osc.type = type; osc.frequency.value = freq
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(peak, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, t + decay)
      osc.start(t); osc.stop(t + decay + 0.05)
    }
    const t0 = c.currentTime
    for (const at of [0, 1.4]) {
      ;[523, 659, 784].forEach((freq, i) => {
        voice('sine', freq, t0 + at + i * 0.03, 1.3, 0.6)
        voice('triangle', freq * 2, t0 + at + i * 0.03, 0.7, 0.1)
      })
    }
  } catch { /* ignore */ }
}

export default function ReplyBell() {
  const pathname = usePathname()
  const onDashboard = pathname === '/'
  useEffect(() => {
    if (onDashboard || !isPackaging()) return
    // Browsers only let a page make sound after a click or key press on it.
    const unlock = () => { const c = audio(); if (c && c.state === 'suspended') void c.resume() }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })

    let prevReplies = -1, prevWa = -1, stopped = false, missed = 0
    const pull = async () => {
      if (stopped) return
      try {
        const r = await fetch('/api/tasks/count')
        if (r.status === 401 || r.status === 403) { stopped = true; return }
        if (!r.ok) return
        const d = await r.json()
        const replies = typeof d.unreadReplies === 'number' ? d.unreadReplies : 0
        const wa = typeof d.waWaiting === 'number' ? d.waWaiting : 0
        if ((prevReplies >= 0 && replies > prevReplies) || (prevWa >= 0 && wa > prevWa)) ringReplyBell()
        prevReplies = replies; prevWa = wa
      } catch { /* offline — next tick */ }
    }
    void pull()
    const iv = setInterval(() => {
      if (!document.hidden) { missed = 0; void pull(); return }
      if (++missed >= 4) { missed = 0; void pull() }
    }, 60000)
    return () => {
      clearInterval(iv)
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [onDashboard])
  return null
}
