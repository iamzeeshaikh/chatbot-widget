'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { attachSoftphone, setSoftphoneBusy, setSoftphoneReady } from '@/lib/softphonebus'

// The dashboard, as a telephone.
//
// WHY IT IS IN THE ROOT LAYOUT: a call has to survive navigation. Mounted on a
// lead page, the Device would be destroyed the moment the agent clicked
// Pipeline — mid-sentence — and an incoming call would only ring if they
// happened to be looking at the right record. So it is mounted once, above the
// router, and pages talk to it through lib/softphonebus.
//
// WHAT THE AGENT NEVER SEES: a phone number. Outgoing, the browser sends a LEAD
// ID and the server looks the number up (/api/twilio/voice/dial). Incoming, the
// caller ID on the client leg is pinned to the BUSINESS number and the caller's
// name arrives as a parameter — because the Voice SDK hands `From` straight to
// page JavaScript, and left alone that one attribute would undo the whole
// contact-privacy rule.
//
// IT COSTS NOTHING WHEN UNUSED: the token endpoint answers "not ready" for a
// workspace without telephony or a server without the four Twilio variables,
// and the ~90KB SDK is only imported after that answer comes back ready.

type Phase = 'off' | 'idle' | 'incoming' | 'connecting' | 'ringing' | 'live'

// Twilio's Call and Device, as much of them as this file touches. The SDK is
// loaded dynamically, so its types are not available at module scope.
interface TwilioCall {
  accept(): void
  reject(): void
  disconnect(): void
  mute(m: boolean): void
  isMuted(): boolean
  parameters: Record<string, string>
  customParameters?: Map<string, string>
  on(event: string, fn: (...args: unknown[]) => void): void
}
interface TwilioDevice {
  register(): Promise<void>
  destroy(): void
  connect(opts: { params: Record<string, string> }): Promise<TwilioCall>
  updateToken(token: string): void
  on(event: string, fn: (...args: unknown[]) => void): void
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function Softphone() {
  const [phase, setPhase] = useState<Phase>('off')
  const [who, setWho] = useState('')
  const [muted, setMuted] = useState(false)
  // A calm line for the ordinary endings — "nobody answered" is not a fault,
  // and showing it in red made a working call look broken.
  const [notice, setNotice] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')

  const deviceRef = useRef<TwilioDevice | null>(null)
  const callRef = useRef<TwilioCall | null>(null)
  const liveRef = useRef(false)

  const endedTo = useCallback((msg: string, tone: 'error' | 'notice' = 'error') => {
    callRef.current = null
    liveRef.current = false
    setSoftphoneBusy(false)
    setPhase('idle'); setMuted(false); setSeconds(0); setWho('')
    if (tone === 'notice') { setNotice(msg); setError('') }
    else if (msg) setError(msg)
  }, [])

  // Wire one call's lifecycle. Both directions share it — an accepted incoming
  // call and a connected outgoing one behave identically from here on.
  const bind = useCallback((call: TwilioCall, label: string) => {
    callRef.current = call
    setSoftphoneBusy(true)
    setWho(label)
    call.on('accept', () => { setPhase('live'); setSeconds(0); setError(''); setNotice('') })
    // 'ringing' arrives while the far end is being tried. Without it the panel
    // sat on "Connecting…" for the whole call and gave no sign of progress.
    call.on('ringing', () => { setPhase('ringing') })
    // The SDK does not always emit 'accept' on an outgoing leg, and when it
    // does not the timer never starts — so the first sign of a live media
    // stream is treated as the call being up, which is what it is. Guarded by
    // a ref because 'volume' fires many times a second.
    liveRef.current = false
    call.on('volume', () => {
      if (liveRef.current) return
      liveRef.current = true
      setPhase('live'); setSeconds(0); setError(''); setNotice('')
    })
    call.on('disconnect', () => endedTo('Call ended.', 'notice'))
    call.on('cancel', () => endedTo('The caller hung up.', 'notice'))
    call.on('reject', () => endedTo(''))
    call.on('error', (e: unknown) => {
      const code = (e as { code?: number })?.code
      // 31000 arrives on a NORMAL teardown: our <Dial action> hands back TwiML
      // that ends the agent's leg once the customer's leg is over, and the SDK
      // reports that as "Call is no longer valid". Shown as a failure it made
      // an unanswered call — the commonest outcome there is — read as a broken
      // system. The real reason is on the timeline either way.
      if (code === 31000) { endedTo('Call ended — the other side did not pick up, or the call finished.', 'notice'); return }
      const m = (e as { message?: string })?.message
      endedTo(m ? `Call failed: ${m}` : 'The call failed.')
    })
  }, [endedTo])

  useEffect(() => {
    let cancelled = false
    let refresh: ReturnType<typeof setInterval> | null = null

    async function boot() {
      let info: { ready?: boolean; token?: string; expiresIn?: number }
      try {
        const res = await fetch('/api/twilio/voice/token')
        // 401/403 is the ordinary answer for a signed-out tab or a workspace
        // without telephony. Not an error state — just no phone.
        if (!res.ok) return
        info = await res.json()
      } catch { return }
      if (cancelled || !info.ready || !info.token) return

      // Only now is the SDK worth downloading.
      const { Device, Call } = await import('@twilio/voice-sdk')
      if (cancelled) return

      const device = new Device(info.token, {
        // Opus where available; the fallback keeps older browsers working.
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      }) as unknown as TwilioDevice
      deviceRef.current = device

      device.on('registered', () => { setPhase('idle'); setSoftphoneReady(true) })
      device.on('unregistered', () => setSoftphoneReady(false))
      device.on('error', (e: unknown) => {
        const m = (e as { message?: string })?.message
        setError(m ? `Phone error: ${m}` : 'The phone went offline.')
      })
      device.on('incoming', (call: unknown) => {
        const c = call as TwilioCall
        // The name is a custom parameter; `From` is the business's own number
        // on purpose and says nothing about who is calling.
        const label = c.customParameters?.get('leadName') || 'New caller'
        bind(c, label)
        setPhase('incoming')
      })

      try {
        await device.register()
      } catch {
        setError('The phone could not connect. Reload the page to try again.')
      }

      // Tokens last an hour; renew well before that so a call in progress is
      // never cut off by an expiry.
      refresh = setInterval(async () => {
        try {
          const r = await fetch('/api/twilio/voice/token')
          if (!r.ok) return
          const j = await r.json()
          if (j.ready && j.token) device.updateToken(j.token)
        } catch { /* the next tick tries again */ }
      }, 45 * 60 * 1000)
    }

    boot()
    return () => {
      cancelled = true
      if (refresh) clearInterval(refresh)
      deviceRef.current?.destroy()
      deviceRef.current = null
      setSoftphoneReady(false)
    }
  }, [bind])

  // A lead page asking for a call.
  useEffect(() => attachSoftphone(async ({ leadId, leadName }) => {
    const device = deviceRef.current
    if (!device) return
    setError(''); setNotice(''); setPhase('connecting'); setWho(leadName || 'Calling…')

    // ── The microphone, BEFORE the call ────────────────────────────────────
    // This used to be left to the SDK, and the failure was silent and awful:
    // the call connected, the customer answered, and no audio ever left the
    // browser — Twilio waited, saw no RTP, and killed the line (error 32014,
    // "no audio received from callee"). On screen it looked like the call
    // "ended by itself" seconds after dialling, with nothing to act on.
    //
    // Asking here turns that into a sentence: the permission prompt appears
    // before anybody's phone rings, and a refusal is reported instead of
    // producing a call nobody can speak into.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Released immediately — the SDK opens its own; this was only a check.
      stream.getTracks().forEach((t) => t.stop())
    } catch (e) {
      const name = (e as { name?: string })?.name ?? ''
      endedTo(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Your browser is blocking the microphone, so nobody would hear you. Click the padlock in the address bar, allow the microphone, and try again.'
          : name === 'NotFoundError'
            ? 'No microphone was found. Plug one in (or connect a headset) and try again.'
            : 'The microphone could not be opened, so the call was not placed.',
      )
      return
    }

    try {
      // The lead id is all that is sent. The number lives on the server.
      const call = await device.connect({ params: { leadId } })
      bind(call, leadName || 'Calling…')
    } catch (e) {
      const m = e instanceof Error ? e.message : ''
      endedTo(m ? `The call could not be started: ${m}` : 'The call could not be started.')
    }
  }), [bind, endedTo])

  // The live timer.
  useEffect(() => {
    if (phase !== 'live') return
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  const answer = () => { callRef.current?.accept(); setPhase('connecting') }
  const decline = () => { callRef.current?.reject(); endedTo('') }
  const hangUp = () => { callRef.current?.disconnect(); endedTo('') }
  const toggleMute = () => {
    const c = callRef.current
    if (!c) return
    const next = !c.isMuted()
    c.mute(next); setMuted(next)
  }

  // Nothing to show when there is no phone and nothing has gone wrong.
  if (phase === 'off' && !error && !notice) return null
  if (phase === 'idle' && !error && !notice) return null

  return (
    <div
      role="region"
      aria-label="Phone"
      className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-lg"
    >
      {error && (
        <p role="alert" className="mb-2 text-[11px] text-red-700">{error}</p>
      )}
      {!error && notice && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] text-gray-500">{notice}</p>
          <button onClick={() => setNotice('')} aria-label="Dismiss"
            className="-mt-0.5 shrink-0 rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-600">×</button>
        </div>
      )}

      {phase === 'incoming' && (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Incoming call</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-gray-900">{who}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={answer}
              className="flex-1 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700">
              Answer
            </button>
            <button onClick={decline}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100">
              Decline
            </button>
          </div>
        </>
      )}

      {(phase === 'connecting' || phase === 'ringing' || phase === 'live') && (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            {phase === 'live' ? `On a call · ${mmss(seconds)}` : phase === 'ringing' ? 'Ringing…' : 'Connecting…'}
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold text-gray-900">{who}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={toggleMute} disabled={phase !== 'live'}
              aria-pressed={muted}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button onClick={hangUp}
              className="flex-1 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700">
              Hang up
            </button>
          </div>
        </>
      )}
    </div>
  )
}
