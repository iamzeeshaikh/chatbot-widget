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
  // Set when a browser call died without audio ever flowing. That is the
  // signature of a network that blocks WebRTC media, and the fix is not another
  // browser call — it is the path that needs no WebRTC at all.
  const [offerPhoneFallback, setOfferPhoneFallback] = useState<{ leadId: string; leadName: string } | null>(null)
  const [ringing, setRinging] = useState(false)
  const lastCallRef = useRef<{ leadId: string; leadName: string } | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')

  const deviceRef = useRef<TwilioDevice | null>(null)
  // How many reconnect attempts the current outage has cost, reset on success.
  const retries = useRef(0)
  const callRef = useRef<TwilioCall | null>(null)
  const liveRef = useRef(false)
  // The last thing the SDK complained about on this call. Kept because a call
  // that dies at a fixed 15–20 seconds is a MEDIA failure, not a person hanging
  // up, and the SDK says which one — 'ice-connectivity-lost' means the audio
  // path never formed, 'low-bytes-sent' means the microphone is silent. Without
  // it every such call reads as the useless "Call ended."
  const warnRef = useRef('')

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
    call.on('warning', (name: unknown) => {
      const w = String(name ?? '')
      warnRef.current = w
      // These two are fatal in practice: the call will die shortly. Say so
      // while it is happening rather than after.
      if (w === 'ice-connectivity-lost') setNotice('Audio path lost — the network is blocking the call.')
      else if (w === 'low-bytes-sent') setNotice('No sound is leaving your microphone.')
    })
    call.on('warning-cleared', () => { warnRef.current = '' })
    call.on('disconnect', () => {
      // Never went live = the audio path never formed. Twilio kills such a call
      // after ~30 seconds of silence (error 32014, "no audio received from
      // callee") while the customer's phone rings on, which reads as "the call
      // ended by itself".
      if (!liveRef.current && lastCallRef.current) setOfferPhoneFallback(lastCallRef.current)
      const w = warnRef.current
      endedTo(
        w === 'ice-connectivity-lost'
          ? 'Call ended: the audio connection could not be held. This is usually a network or firewall blocking WebRTC — try another network, or use a phone instead.'
          : w === 'low-bytes-sent'
            ? 'Call ended: no sound was leaving your microphone. Check the right microphone is selected and unmuted.'
            : w === 'low-bytes-received'
              ? 'Call ended: no sound was arriving from the other side.'
              : 'Call ended.',
        w ? 'error' : 'notice',
      )
    })
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

      device.on('registered', () => {
        setPhase('idle'); setSoftphoneReady(true); setError('')
        // Clearing the notice here is the whole point: the SDK reconnects on
        // its own, and without this the "Phone reconnecting…" banner stayed on
        // screen over a phone that had been working again for hours. An agent
        // reading a stale warning assumes the feature is broken and stops
        // using it — which is exactly what happened.
        setNotice('')
        retries.current = 0
      })
      device.on('unregistered', () => setSoftphoneReady(false))
      device.on('error', (e: unknown) => {
        const err = e as { code?: number; message?: string }
        // ── Which device errors are worth a red line, and which are weather ──
        // 31009 (TransportError, "no transport available") and 31005 mean the
        // signalling websocket dropped — a network blip, a laptop waking, a
        // proxy timing out. The SDK reconnects on its own, and the MEDIA path
        // is separate, so an established call keeps working right through it.
        // Shown as an error it appeared in red over a call that was audibly
        // fine, which teaches an agent to ignore the one place we tell them
        // something is wrong.
        if (err.code === 31009 || err.code === 31005) {
          if (callRef.current) return                 // a live call is unaffected
          setSoftphoneReady(false)
          setNotice('Phone reconnecting…')
          // Ask for a fresh token and register again: after a long drop the old
          // one may have expired, and re-registering with it fails silently.
          //
          // RETRIED, with a backoff. A single attempt that threw left the
          // banner up and the phone unregistered with nothing scheduled to try
          // again — no further error event arrives once the transport has
          // given up, so it stayed that way until somebody reloaded the page.
          void (async () => {
            for (let attempt = 0; attempt < 6; attempt++) {
              try {
                const r = await fetch('/api/twilio/voice/token')
                if (r.ok) {
                  const j = await r.json()
                  if (j.ready && j.token) device.updateToken(j.token)
                }
                await device.register()
                return                      // 'registered' clears the banner
              } catch {
                retries.current = attempt + 1
                await new Promise((done) => setTimeout(done, Math.min(30000, 2000 * 2 ** attempt)))
              }
            }
            // Out of attempts: say something the agent can act on rather than
            // leaving a spinner-ish banner that means nothing.
            setNotice('')
            setError('The phone could not reconnect. Reload the page to use it again.')
          })()
          return
        }
        // 20101/20104: the token itself is bad or expired — a new one is the
        // whole fix, so it is fetched rather than reported.
        if (err.code === 20101 || err.code === 20104) {
          void (async () => {
            try {
              const r = await fetch('/api/twilio/voice/token')
              if (!r.ok) return
              const j = await r.json()
              if (j.ready && j.token) { device.updateToken(j.token); await device.register() }
            } catch { /* ignored */ }
          })()
          return
        }
        setError(err.message ? `Phone error: ${err.message}` : 'The phone went offline.')
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
    setError(''); setNotice(''); setOfferPhoneFallback(null)
    lastCallRef.current = { leadId, leadName }
    setPhase('connecting'); setWho(leadName || 'Calling…')

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

  async function ringMyPhone() {
    const target = offerPhoneFallback
    if (!target || ringing) return
    setRinging(true); setError('')
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(target.leadId)}/call`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d.error || 'Your phone could not be rung.'); return }
      setOfferPhoneFallback(null)
      setNotice('Your phone is ringing — answer it and you will be connected.')
    } catch {
      setError('Your phone could not be rung.')
    } finally {
      setRinging(false)
    }
  }

  // Nothing to show when there is no phone and nothing has gone wrong.
  if (phase === 'off' && !error && !notice && !offerPhoneFallback) return null
  if (phase === 'idle' && !error && !notice && !offerPhoneFallback) return null

  return (
    <div
      role="region"
      aria-label="Phone"
      className="fixed bottom-4 right-4 z-50 w-72 rounded-xl border border-gray-200 bg-white p-3 shadow-lg"
    >
      {/* An error is worth the top of the panel only when there is no call to
          look at. During a call the state that matters is the timer and the
          hang-up button, and a red line above them reads as "this call is
          broken" when it is not. */}
      {error && phase !== 'live' && phase !== 'ringing' && (
        <p role="alert" className="mb-2 text-[11px] text-red-700">{error}</p>
      )}
      {!error && notice && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] text-gray-500">{notice}</p>
          <button onClick={() => setNotice('')} aria-label="Dismiss"
            className="-mt-0.5 shrink-0 rounded px-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-600">×</button>
        </div>
      )}

      {/* The way out of a network that blocks WebRTC: ring the agent's own
          phone and bridge the customer to it. No browser audio is involved, so
          it works where the softphone cannot. */}
      {offerPhoneFallback && phase === 'idle' && (
        <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 p-2">
          <p className="text-[11px] text-amber-900">
            No audio reached the other side — your network is blocking browser calls.
          </p>
          <button onClick={ringMyPhone} disabled={ringing}
            className="mt-1.5 w-full rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50">
            {ringing ? 'Ringing your phone…' : 'Ring my phone instead'}
          </button>
          <button onClick={() => setOfferPhoneFallback(null)}
            className="mt-1 w-full text-[11px] text-gray-500 hover:text-gray-700">Dismiss</button>
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
