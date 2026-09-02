'use client'

import { useEffect, useRef, useState } from 'react'
import { MessageCircle, Paperclip, Send, Check, CheckCheck, TriangleAlert, Mic, Square, Trash2, Phone, Loader2 } from 'lucide-react'
import type { TimelineEvent } from '@/lib/leadrecord'
import { formatDateTime } from '@/lib/datetime'

// The WhatsApp conversation, as a conversation.
//
// It used to live only in the timeline, interleaved with calls, notes and stage
// changes, and the reply box was behind a button in a modal. Reading a thread
// meant scrolling past everything else and reconstructing who said what — on a
// record with nineteen events, one customer message was genuinely hard to find,
// which is exactly how a real enquiry went unanswered for an hour.
//
// So: the same thing WhatsApp itself shows. Their words on the left, ours on
// the right, oldest at the top, the composer underneath. The timeline still
// carries every message — this is a second view of the same rows, not a second
// copy of them.

interface Props {
  events: TimelineEvent[]
  leadId: string
  /** Verdict from lib/whatsappstatus.ts — 'yes' | 'no' | 'maybe' | … */
  state?: string
  stateReason?: string
  canMessage: boolean
  onSend: (text: string, file: File | null) => Promise<string | null>
  onRefresh: () => void
  /** Ring this customer. WhatsApp puts a call button in the chat header and so
   *  does this — the person you want to phone is the one you are reading. */
  onCall?: () => void
}


// ── Recording a voice note in the browser ───────────────────────────────────
// WhatsApp takes audio as OGG (opus codec only), AAC, MPEG, AMR or 3GP. It does
// NOT take webm — which is what Chrome's MediaRecorder produces — and it does
// not take Chrome's audio/mp4 either: that came back from Twilio as 63021,
// "channel invalid content", after the agent had already spoken into it.
//
// No browser records ogg/opus except Firefox, so the encoder is carried:
// opus-recorder runs libopus in a worker and writes a real OGG/opus file, which
// is exactly the format a WhatsApp voice note is. The worker is served from
// /opus/encoderWorker.min.js (committed under public/, not resolved from
// node_modules at runtime).
const OPUS_WORKER = '/opus/encoderWorker.min.js'

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return `${m}:${String(seconds % 60).padStart(2, '0')}`
}

/** WhatsApp's own 24-hour rule, worked out from the thread rather than guessed:
 *  a free-form reply is allowed only within a day of the customer's last
 *  message. Knowing it BEFORE typing is the difference between a reply and a
 *  63016 error after the fact. */
function windowOpen(events: TimelineEvent[]): { open: boolean; closesAt: number | null } {
  let lastInbound = 0
  for (const e of events) {
    if (e.kind !== 'wa_in') continue
    const t = new Date(e.at).getTime()
    if (t > lastInbound) lastInbound = t
  }
  if (!lastInbound) return { open: false, closesAt: null }
  const closesAt = lastInbound + 24 * 60 * 60 * 1000
  return { open: Date.now() < closesAt, closesAt }
}

function hoursLeft(closesAt: number): string {
  const ms = closesAt - Date.now()
  if (ms <= 0) return ''
  const h = Math.floor(ms / 3600000)
  if (h >= 1) return `${h}h left`
  return `${Math.max(1, Math.round(ms / 60000))}m left`
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date(Date.now() - 86400000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return 'Today'
  if (same(d, y)) return 'Yesterday'
  return d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/** The ticks everyone already knows how to read, rather than a word. */
function Ticks({ status }: { status?: string }) {
  if (status === 'read') return <CheckCheck size={12} strokeWidth={2.5} className="text-sky-300" aria-label="Read" />
  if (status === 'delivered') return <CheckCheck size={12} strokeWidth={2.5} className="text-green-100/80" aria-label="Delivered" />
  if (status === 'failed' || status === 'undelivered') {
    return <TriangleAlert size={12} strokeWidth={2.5} className="text-red-200" aria-label="Not delivered" />
  }
  return <Check size={12} strokeWidth={2.5} className="text-green-100/70" aria-label="Sent" />
}

export default function WhatsAppThread({ events, leadId, state, stateReason, canMessage, onSend, onRefresh, onCall }: Props) {
  const msgs = events
    .filter((e) => e.kind === 'wa_in' || e.kind === 'wa_out')
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)

  // Voice note recording.
  const [recording, setRecording] = useState(false)
  // Between the click and the first byte there is real work — loading the
  // encoder, then asking macOS for the microphone — and with no state for it
  // the button sat there looking broken for a couple of seconds. It is not a
  // cosmetic spinner: without it people click again, and the second click
  // arrives while the first is still opening the device.
  const [starting, setStarting] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const recorderRef = useRef<InstanceType<typeof import('opus-recorder').default> | null>(null)
  const keepRef = useRef(true)

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setRecSeconds((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [recording])

  // Fetch the encoder and its worker as soon as the thread is on screen. This
  // is ~390KB that used to be downloaded on the FIRST CLICK, which is most of
  // why recording began "bohat late" — the wait was the download, not the
  // microphone. Failures are ignored: startRecording loads it properly and
  // reports its own errors.
  useEffect(() => {
    let dead = false
    void import('opus-recorder').catch(() => {})
    fetch(OPUS_WORKER).then((r) => r.arrayBuffer()).catch(() => {}).finally(() => { if (dead) return })
    return () => { dead = true }
  }, [])

  // Never leave the microphone open behind us.
  useEffect(() => () => {
    keepRef.current = false
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
  }, [])

  async function startRecording() {
    if (starting || recording) return
    setError('')
    setStarting(true)
    let Recorder: typeof import('opus-recorder').default
    try {
      Recorder = (await import('opus-recorder')).default
    } catch {
      setError('The voice recorder could not be loaded. Attach an audio file instead.')
      setStarting(false)
      return
    }

    // opus-recorder asks for the microphone itself, but asking here first turns
    // a refusal into a sentence rather than a button that does nothing.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
    } catch (e) {
      const name = (e as { name?: string })?.name ?? ''
      // NotFoundError / NotReadableError mean the machine has no usable input —
      // which on a Mac is usually an iPhone still selected as the microphone
      // after it has been unplugged. The browser is not at fault and telling
      // somebody to check the padlock sends them to the wrong place.
      setError(name === 'NotAllowedError'
        ? 'Your browser is blocking the microphone. Allow it from the padlock in the address bar and try again.'
        : name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError'
          ? 'No working microphone. On a Mac, open System Settings → Sound → Input and pick the built-in microphone — an iPhone left selected there is the usual cause.'
          : 'The microphone could not be opened.')
      setStarting(false)
      return
    }

    const rec = new Recorder({
      encoderPath: OPUS_WORKER,
      // Voice, not music: one channel at 16kHz keeps a minute-long note well
      // under a hundred kilobytes, and is what a phone sends anyway.
      numberOfChannels: 1,
      encoderSampleRate: 16000,
      encoderApplication: 2048,        // libopus VOIP mode — tuned for speech
      streamPages: false,
    })
    recorderRef.current = rec
    keepRef.current = true
    rec.ondataavailable = (data: Uint8Array) => {
      if (!keepRef.current) return
      const blob = new Blob([data as unknown as BlobPart], { type: 'audio/ogg' })
      if (blob.size === 0) { setError('Nothing was recorded.'); return }
      setFile(new File([blob], 'voice-note.ogg', { type: 'audio/ogg' }))
    }
    try {
      await rec.start()
    } catch {
      setError('Recording could not start.')
      recorderRef.current = null
      setStarting(false)
      return
    }
    setRecSeconds(0)
    setStarting(false)
    setRecording(true)
  }

  function stopRecording(keep: boolean) {
    keepRef.current = keep
    // stop() flushes the encoder, which is what fires ondataavailable with the
    // finished OGG — so a discard has to be flagged BEFORE stopping.
    try { recorderRef.current?.stop() } catch { /* already stopped */ }
    recorderRef.current = null
    setRecording(false)
  }

  // Newest message in view when the thread grows, the way a chat behaves.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' })
  }, [msgs.length])

  const { open, closesAt } = windowOpen(events)

  async function send() {
    if (sending || (!text.trim() && !file)) return
    setSending(true); setError('')
    try {
      const err = await onSend(text.trim(), file)
      if (err) { setError(err); return }
      setText(''); setFile(null)
      onRefresh()
    } finally {
      setSending(false)
    }
  }

  return (
    <section
      id="whatsapp-thread"
      aria-label="WhatsApp conversation"
      className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden mb-6"
    >
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 bg-gradient-to-r from-green-50 to-white">
        <span className="w-7 h-7 rounded-lg bg-green-600 text-white flex items-center justify-center shrink-0">
          <MessageCircle size={15} strokeWidth={2.25} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 leading-tight">WhatsApp</h2>
          <p className="text-[11px] text-gray-500 leading-tight truncate" title={stateReason}>
            {state === 'yes' ? 'On WhatsApp'
              : state === 'no' ? 'Not reachable on WhatsApp'
              : state === 'maybe' ? 'Mobile — WhatsApp likely'
              : state === 'unlikely' ? 'Unlikely to have WhatsApp'
              : 'Not checked'}
            {msgs.length > 0 && ` · ${msgs.length} message${msgs.length === 1 ? '' : 's'}`}
          </p>
        </div>
        {/* An ordinary phone call, from the chat — the customer in front of you
            is the one you want to ring. It is NOT a WhatsApp call: Meta does not
            allow a business with a US number to place those, so this dials their
            number the normal way, through the browser. */}
        {onCall && canMessage && (
          <button onClick={onCall} title="Call this customer from your browser"
            className="ml-auto shrink-0 rounded-full border border-green-300 bg-white p-2 text-green-700 hover:bg-green-50 transition-colors">
            <Phone size={15} strokeWidth={2.25} aria-hidden />
            <span className="sr-only">Call</span>
          </button>
        )}
        {/* The 24-hour rule, stated before it bites rather than after. */}
        {closesAt !== null && (
          <span
            title={open
              ? 'WhatsApp allows a free-form reply for 24 hours after the customer’s last message'
              : 'Outside the 24-hour window — WhatsApp will refuse a free-form message until they write again'}
            className={`${onCall && canMessage ? '' : 'ml-auto '}shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold border ${
              open ? 'text-green-800 bg-green-100 border-green-200' : 'text-amber-800 bg-amber-50 border-amber-300'}`}
          >
            {open ? `Window open · ${hoursLeft(closesAt)}` : 'Window closed'}
          </span>
        )}
      </header>

      {/* ── The conversation ─────────────────────────────────────────────── */}
      <div className="max-h-80 overflow-y-auto px-4 py-3 space-y-2 bg-[#f7f6f3]">
        {msgs.length === 0 ? (
          <p className="py-6 text-center text-xs text-gray-500">
            No WhatsApp messages yet. Anything you send here appears in the customer’s WhatsApp.
          </p>
        ) : msgs.map((e, i) => {
          const mine = e.kind === 'wa_out'
          const prev = msgs[i - 1]
          const newDay = !prev || dayLabel(prev.at) !== dayLabel(e.at)
          const failed = e.wa?.status === 'failed' || e.wa?.status === 'undelivered'
          return (
            <div key={e.id}>
              {newDay && (
                <p className="my-3 text-center">
                  <span className="rounded-full bg-white/80 border border-gray-200 px-2.5 py-0.5 text-[10px] font-medium text-gray-500">
                    {dayLabel(e.at)}
                  </span>
                </p>
              )}
              <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-2 shadow-sm ${
                    mine
                      ? failed ? 'bg-red-600 text-white rounded-br-sm' : 'bg-green-600 text-white rounded-br-sm'
                      : 'bg-white text-gray-900 border border-gray-200 rounded-bl-sm'
                  }`}
                >
                  {/* Files, voice notes and photos, served through our own
                      endpoint so the customer's media never needs Twilio
                      credentials in a browser. */}
                  {e.wa?.media?.map((m, k) => {
                    const src = `/api/leads/${encodeURIComponent(leadId)}/whatsapp/media?` +
                      (m.path ? `path=${encodeURIComponent(m.path)}` : `url=${encodeURIComponent(m.url ?? '')}`)
                    const type = (m.type || '').toLowerCase()
                    if (type.startsWith('audio/')) return <audio key={k} controls preload="none" className="mb-1 w-56 h-9" src={src} />
                    if (type.startsWith('image/')) {
                      return (
                        <a key={k} href={src} target="_blank" rel="noopener noreferrer" className="block mb-1">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt={m.name || 'Photo'} className="max-h-44 rounded-lg" />
                        </a>
                      )
                    }
                    if (type.startsWith('video/')) return <video key={k} controls preload="none" className="mb-1 w-56 rounded-lg" src={src} />
                    return (
                      <a key={k} href={src} target="_blank" rel="noopener noreferrer"
                        className={`mb-1 flex items-center gap-1.5 underline ${mine ? 'text-green-50' : 'text-blue-700'}`}>
                        <Paperclip size={12} aria-hidden />
                        <span className="text-xs truncate">{m.name || 'File'}</span>
                      </a>
                    )
                  })}

                  {e.body && (
                    <p className="text-[13px] leading-snug whitespace-pre-wrap break-words">{e.body}</p>
                  )}

                  <div className={`mt-0.5 flex items-center gap-1 justify-end ${mine ? 'text-green-50/80' : 'text-gray-400'}`}>
                    <span className="text-[10px] tabular-nums" title={formatDateTime(e.at)}>{timeLabel(e.at)}</span>
                    {mine && <Ticks status={e.wa?.status} />}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* ── Reply, in place ──────────────────────────────────────────────── */}
      <div className="border-t border-gray-200 bg-white px-3 py-2.5">
        {error && <p role="alert" className="mb-1.5 text-[11px] text-red-700">{error}</p>}
        {file && (
          <div className="mb-1.5 flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-100 px-2.5 py-1.5">
            {file.type.startsWith('audio/')
              ? <Mic size={12} className="text-green-700 shrink-0" aria-hidden />
              : <Paperclip size={12} className="text-gray-500 shrink-0" aria-hidden />}
            <span className="text-xs text-gray-800 truncate">
              {file.name.startsWith('voice-note.') ? `Voice note · ${clock(recSeconds)}` : file.name}
            </span>
            <span className="text-[11px] text-gray-500 shrink-0">{Math.max(1, Math.round(file.size / 1024))}KB</span>
            <button onClick={() => setFile(null)} aria-label="Remove the file"
              className="ml-auto shrink-0 rounded px-1 text-gray-500 hover:bg-gray-200 hover:text-gray-800">&times;</button>
          </div>
        )}
        {/* Recording takes over the composer, the way it does in WhatsApp: there
            is nothing else to do while the microphone is live, and leaving the
            text box available invites typing into a message that is about to be
            replaced by audio. */}
        {recording ? (
          <div className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-3 py-2">
            <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
            </span>
            <span className="text-[13px] font-semibold text-red-800 tabular-nums">Recording · {clock(recSeconds)}</span>
            <button onClick={() => stopRecording(false)}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-white"
              title="Discard this recording">
              <Trash2 size={13} strokeWidth={2} aria-hidden /> Discard
            </button>
            <button onClick={() => stopRecording(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700"
              title="Stop and attach the recording">
              <Square size={12} strokeWidth={2.5} aria-hidden /> Stop
            </button>
          </div>
        ) : (
        <div className="flex items-end gap-2">
          <label className="shrink-0 cursor-pointer rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            title="Attach a photo, PDF, voice note or video (16MB)">
            <Paperclip size={16} strokeWidth={2} aria-hidden />
            <span className="sr-only">Attach a file</span>
            <input type="file" className="sr-only"
              accept="image/jpeg,image/png,image/webp,application/pdf,audio/*,video/mp4,video/3gpp"
              onChange={(ev) => { setFile(ev.target.files?.[0] ?? null); setError(''); ev.target.value = '' }} />
          </label>
          <textarea
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            // Enter sends, Shift+Enter makes a new line — what every chat does,
            // and what an agent's fingers already expect.
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
            rows={text.split('\n').length > 2 ? 3 : 1}
            disabled={!canMessage}
            placeholder={canMessage ? 'Write a message…' : 'Add a phone number first'}
            className="flex-1 resize-none rounded-2xl border border-gray-300 bg-white px-3 py-2 text-[13px] text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500 disabled:bg-gray-100"
          />
          {/* Mic when there is nothing to send, arrow when there is — the same
              swap WhatsApp does, so the button under the thumb is always the
              one that means "go". */}
          {!text.trim() && !file ? (
            <button
              onClick={startRecording}
              disabled={!canMessage || starting}
              aria-label="Record a voice note"
              title={starting ? 'Opening the microphone…' : 'Record a voice note'}
              className="shrink-0 rounded-full bg-green-600 p-2.5 text-white hover:bg-green-700 disabled:opacity-60 transition-colors"
            >
              {starting
                ? <Loader2 size={16} strokeWidth={2.25} className="animate-spin" aria-hidden />
                : <Mic size={16} strokeWidth={2.25} aria-hidden />}
            </button>
          ) : (
            <button
              onClick={send}
              disabled={sending || !canMessage}
              aria-label="Send on WhatsApp"
              className="shrink-0 rounded-full bg-green-600 p-2.5 text-white hover:bg-green-700 disabled:opacity-40 transition-colors"
            >
              <Send size={16} strokeWidth={2.25} aria-hidden />
            </button>
          )}
        </div>
        )}
        {closesAt !== null && !open && (
          <p className="mt-1.5 text-[11px] text-amber-800">
            More than 24 hours have passed since their last message, so WhatsApp will refuse this
            until they write again.
          </p>
        )}
      </div>
    </section>
  )
}
