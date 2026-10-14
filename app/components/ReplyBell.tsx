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
    return JSON.parse(atob(decodeURIComponent(raw)))?.workspace === 'packaging'
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
    const master = c.createGain(); master.gain.value = 1
    const shaper = c.createWaveShaper()
    const curve = new Float32Array(1024)
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 1.6) }
    shaper.curve = curve
    master.connect(shaper); shaper.connect(c.destination)
    const partials: [number, number][] = [[0.5, 0.55], [1, 1], [1.2, 0.45], [1.5, 0.35], [2, 0.5], [2.74, 0.2]]
    const strike = (freq: number, t: number) => {
      for (const [ratio, peak] of partials) {
        const osc = c.createOscillator(); const gain = c.createGain()
        osc.connect(gain); gain.connect(master)
        osc.type = 'sine'; osc.frequency.value = freq * ratio
        gain.gain.setValueAtTime(0, t)
        gain.gain.linearRampToValueAtTime(peak, t + 0.008)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 1.1)
        osc.start(t); osc.stop(t + 1.15)
      }
    }
    const t0 = c.currentTime
    for (const round of [0, 1]) { strike(784, t0 + round); strike(587, t0 + round + 0.45) }
    strike(784, t0 + 2)
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
