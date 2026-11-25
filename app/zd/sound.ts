// ZeeDesk's own alerts. The owner asked for sounds that are NOT the ZeeOps
// ones (2026-11-17): a two-note marimba for a new visitor message and a glass
// bell for a customer's reply, both soft enough to hear all shift.

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

/** Browsers only let a page make sound after a click or key press on it. */
export function unlockSound() {
  const c = audio()
  if (c && c.state === 'suspended') void c.resume()
}

function output(c: AudioContext, level: number): GainNode {
  const gain = c.createGain()
  gain.gain.value = level
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'; lp.frequency.value = 6000
  gain.connect(lp); lp.connect(c.destination)
  return gain
}

function tone(c: AudioContext, dest: AudioNode, freq: number, at: number, decay: number, peak: number) {
  const osc = c.createOscillator(); const gain = c.createGain()
  osc.type = 'sine'; osc.frequency.value = freq
  osc.connect(gain); gain.connect(dest)
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(peak, at + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.001, at + decay)
  osc.start(at); osc.stop(at + decay + 0.05)
}

/** A new message from a visitor: marimba, E5 then B5, played twice. */
export function chatDing() {
  const c = audio()
  if (!c) return
  try {
    unlockSound()
    const out = output(c, 0.9)
    const t0 = c.currentTime
    for (const at of [0, 0.7]) {
      for (const [freq, delay, len] of [[659, 0, 0.35], [988, 0.13, 0.5]] as const) {
        tone(c, out, freq, t0 + at + delay, len, 0.9)
        tone(c, out, freq * 4, t0 + at + delay, len * 0.25, 0.2)
      }
    }
  } catch { /* sound is never worth an error */ }
}

/** A visitor just landed on one of the sites: a doorbell, two descending
 *  notes (G5 then E5), bright enough to turn a head but shorter than the
 *  chat marimba so an arrival never sounds like a message waiting. The owner
 *  asked for this on 2026-11-25 after watching a visitor arrive in silence. */
export function visitorDing() {
  const c = audio()
  if (!c) return
  try {
    unlockSound()
    const out = output(c, 0.9)
    const t0 = c.currentTime
    for (const [freq, delay, len] of [[784, 0, 0.5], [659, 0.22, 0.75]] as const) {
      tone(c, out, freq, t0 + delay, len, 0.9)
      tone(c, out, freq * 3, t0 + delay, len * 0.3, 0.14)
    }
  } catch { /* sound is never worth an error */ }
}

/** A customer answered by email: one clear glass bell, struck twice. */
export function replyDing() {
  const c = audio()
  if (!c) return
  try {
    unlockSound()
    const out = output(c, 0.85)
    const t0 = c.currentTime
    for (const at of [0, 0.45]) {
      tone(c, out, 880, t0 + at, 1.0, 0.85)
      tone(c, out, 880 * 2.01, t0 + at, 0.6, 0.26)
      tone(c, out, 880 * 3.02, t0 + at, 0.35, 0.1)
    }
  } catch { /* sound is never worth an error */ }
}
