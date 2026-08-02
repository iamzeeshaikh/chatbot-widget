'use client'

// Compose and send an email to the lead, as the agent, through their own Gmail.
//
// Plain text on purpose: the customer sees a normal business email from a real
// person, and a plain body cannot carry the formatting inconsistencies a rich
// editor introduces across mail clients. Blank lines are preserved.
//
// A half-written email survives a reload — the draft is kept in localStorage per
// lead, cleared only once the send actually succeeds.

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Send, TriangleAlert, Link2, Loader2, Plus, CornerUpLeft } from 'lucide-react'

export interface Alias { email: string; displayName: string; isPrimary: boolean; isDefault: boolean }

export interface GmailStatus {
  connected: boolean
  configured: boolean
  aliases: Alias[]
  reason?: string | null
  needsReconnect?: boolean
  connectedAt?: string
  /** False when the consent predates reply capture — sending still works. */
  canReadReplies?: boolean
  replyCaptureReason?: string | null
}

interface Draft { from: string; to: string; cc: string; subject: string; body: string }

/** Set when the composer was opened by Reply on an inbound message. */
export interface ReplyTo { replyToGmailId: string; to: string; subject: string }

const draftKey = (leadId: string) => `zee-email-draft-${leadId}`

export default function EmailComposer({ leadId, leadEmail, leadName, siteId, siteName, onClose, onSent, replyTo }: {
  leadId: string
  leadEmail: string
  leadName: string
  siteId: string
  siteName: string
  onClose: () => void
  onSent: () => void
  replyTo?: ReplyTo | null
}) {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [needsReconnect, setNeedsReconnect] = useState(false)
  // A reply seeds the recipient and the subject up front, so neither has to be
  // retyped. "Re:" is added once — a subject that already carries it is left
  // alone rather than becoming "Re: Re: Re: …" down a long thread.
  const [draft, setDraft] = useState<Draft>({
    from: '', to: replyTo?.to || leadEmail, cc: '',
    subject: replyTo?.subject ?? '', body: '',
  })
  const seeded = useRef(false)
  // CC is optional and usually unused, so it costs a permanent row for nothing.
  // It opens automatically when a restored draft already has one.
  const [showCc, setShowCc] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  // Whether this is a reply is fixed for the life of the composer — it is set
  // before mount and cleared on close — so the restore effect below reads it
  // from a ref rather than taking it as a dependency and re-running.
  const isReply = useRef(!!replyTo)

  // ── restore any half-written draft, then load the connection ──────────────
  useEffect(() => {
    let alive = true
    // Deferred so the restore never runs synchronously inside the effect body.
    queueMicrotask(() => {
      if (!alive) return
      try {
        const raw = localStorage.getItem(draftKey(leadId))
        if (raw) {
          const d = JSON.parse(raw)
          setDraft((cur) => ({
            from: typeof d.from === 'string' ? d.from : cur.from,
            // On a reply the recipient and subject are decided by the message
            // being answered, so a leftover draft only restores the body.
            to: isReply.current ? cur.to : (typeof d.to === 'string' && d.to ? d.to : cur.to),
            cc: typeof d.cc === 'string' ? d.cc : '',
            subject: isReply.current ? cur.subject : (typeof d.subject === 'string' ? d.subject : ''),
            body: typeof d.body === 'string' ? d.body : '',
          }))
          if (typeof d.cc === 'string' && d.cc.trim()) setShowCc(true)
        }
      } catch { /* malformed draft — start fresh */ }
    })
    return () => { alive = false }
  }, [leadId])

  useEffect(() => {
    let alive = true
    fetch('/api/google/gmail/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: GmailStatus | null) => {
        if (!alive) return
        setStatus(d)
        setLoading(false)
        if (d?.needsReconnect) setNeedsReconnect(true)
      })
      .catch(() => { if (alive) { setLoading(false); setError('Could not check your Gmail connection.') } })
    return () => { alive = false }
  }, [])

  // Default the From to the alias that matches this lead's site, so a reply to a
  // Tube Packaging customer goes out from the Tube Packaging address rather than
  // whatever happens to be first.
  useEffect(() => {
    if (seeded.current || !status?.aliases.length) return
    seeded.current = true
    setDraft((cur) => {
      if (cur.from) return cur
      const bySite = status.aliases.find((a) => {
        const local = a.email.split('@')[0].toLowerCase()
        const domain = (a.email.split('@')[1] ?? '').toLowerCase()
        const site = siteId.toLowerCase()
        const name = siteName.toLowerCase().replace(/[^a-z]/g, '')
        return domain.replace(/[^a-z]/g, '').includes(site) || domain.replace(/[^a-z]/g, '').includes(name)
          || local.includes(site)
      })
      const fallback = status.aliases.find((a) => a.isDefault) ?? status.aliases.find((a) => a.isPrimary) ?? status.aliases[0]
      return { ...cur, from: (bySite ?? fallback).email }
    })
  }, [status, siteId, siteName])

  // Persist the draft as it is typed.
  const save = useCallback((next: Draft) => {
    setDraft(next)
    try { localStorage.setItem(draftKey(leadId), JSON.stringify(next)) } catch { /* quota */ }
  }, [leadId])

  const set = (patch: Partial<Draft>) => save({ ...draft, ...patch })

  async function send() {
    if (sending) return
    setError('')
    setSending(true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draft, replyToGmailId: replyTo?.replyToGmailId }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (j.needsReconnect) setNeedsReconnect(true)
        throw new Error(j.error || 'Could not send the email.')
      }
      // Only now is the draft safe to discard.
      try { localStorage.removeItem(draftKey(leadId)) } catch { /* ignore */ }
      onSent()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the email.')
    } finally {
      setSending(false)
    }
  }

  // The body grows with what is typed instead of starting as a wall of empty
  // space: most of these are three lines, not an essay. Capped so the modal is
  // always sized to its content and never taller than the viewport.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`
  }, [draft.body, loading, status])

  const connectHref = `/api/google/gmail/connect?back=${encodeURIComponent(`/leads/${leadId}`)}`
  // A subject stays REQUIRED rather than optional-with-a-warning: this is
  // customer-facing sales mail, and a blank subject is both unprofessional and
  // a well-known spam signal, so the right moment to stop it is before it goes.
  //
  // What was wrong was not the rule but the silence — Send simply sat there
  // greyed out with nothing saying why. `missing` names whatever is still
  // needed, right next to the button.
  const missing: string[] = []
  if (!draft.from) missing.push('a From address')
  if (!draft.to.trim()) missing.push('a recipient')
  if (!draft.subject.trim()) missing.push('a subject')
  if (!draft.body.trim()) missing.push('a message')
  const canSend = missing.length === 0 && !sending

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center px-4 py-8 bg-gray-900/40 backdrop-blur-sm"
      role="dialog" aria-modal="true" aria-label="Compose email"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      {/* max-h caps it; the content decides the actual height, so a three-line
          reply is a small dialog rather than a full screen of empty textarea. */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-lg w-full max-w-xl animate-in flex flex-col max-h-[85vh]"
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter sends from anywhere in the form; Esc closes and the
          // draft is already in localStorage, so nothing typed is lost.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (canSend) send() }
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}>
        <header className="flex items-center gap-2 px-3.5 py-2.5 border-b border-gray-200 shrink-0">
          {replyTo
            ? <CornerUpLeft size={13} strokeWidth={2} className="text-violet-600" aria-hidden />
            : <Send size={13} strokeWidth={2} className="text-gray-500" aria-hidden />}
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-600 truncate">
            {replyTo ? 'Reply to' : 'Email'} {leadName || leadEmail}
          </h2>
          <button onClick={onClose} aria-label="Close"
            className="ml-auto p-1 rounded-md text-gray-400 hover:text-gray-800 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            <X size={13} strokeWidth={2} aria-hidden />
          </button>
        </header>

        {loading ? (
          <div className="p-4 space-y-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-8 bg-gray-200 rounded-lg animate-pulse" />)}
            <span className="sr-only" role="status">Checking your Gmail connection…</span>
          </div>
        ) : !status?.configured ? (
          <Notice tone="warn" title="Gmail is not set up on the server">
            {status?.reason ?? 'An admin needs to add the Google credentials before email can be sent.'}
          </Notice>
        ) : !status.connected ? (
          <div className="p-4">
            <Notice tone={needsReconnect ? 'warn' : 'info'}
              title={needsReconnect ? 'Your Gmail connection needs renewing' : 'Connect Gmail to send email'}>
              {status.reason ?? 'Email goes out from your own Google account, so the customer sees a normal business email and the reply lands in your inbox.'}
            </Notice>
            <a href={connectHref}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <Link2 size={12} strokeWidth={2} aria-hidden />
              {needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'}
            </a>
          </div>
        ) : (
          <>
            {/* Connected, but the consent cannot read replies. Sending is fine,
                so this warns rather than blocking — the old behaviour showed a
                wholly healthy composer while replies silently never arrived. */}
            {status.canReadReplies === false && (
              <div className="mx-3 mt-3 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2">
                <p className="flex items-start gap-1.5 text-[11px] text-amber-900">
                  <TriangleAlert size={12} strokeWidth={2} className="shrink-0 mt-px" aria-hidden />
                  <span>
                    <b>Replies will not appear on this record.</b>{' '}
                    {status.replyCaptureReason ?? 'This Gmail connection predates reply capture.'}
                  </span>
                </p>
                <a href={connectHref}
                  className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  <Link2 size={11} strokeWidth={2} aria-hidden /> Reconnect Gmail
                </a>
              </div>
            )}
            <div className="px-3.5 py-3 overflow-y-auto">
              {/* FROM is a real decision — which of your addresses the customer
                  sees — so it reads as a control. */}
              <Row label="From">
                <select value={draft.from} onChange={(e) => set({ from: e.target.value })}
                  aria-label="Send from"
                  className="w-full bg-white border border-gray-300 rounded-md px-2 py-1.5 text-xs font-medium text-gray-900 cursor-pointer focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500">
                  {status.aliases.map((a) => (
                    <option key={a.email} value={a.email} className="bg-white text-gray-800">
                      {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                    </option>
                  ))}
                </select>
              </Row>

              {/* TO is prefilled from the lead and rarely touched, so it is
                  quiet — borderless until focused — rather than shouting for
                  attention it does not need. */}
              <Row label="To">
                <div className="flex items-center gap-1.5 w-full">
                  <input value={draft.to} onChange={(e) => set({ to: e.target.value })} aria-label="To"
                    className="flex-1 min-w-0 bg-transparent border border-transparent hover:border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 focus:outline-none focus:bg-white focus:border-blue-500 focus:text-gray-900 transition-colors" />
                  {!showCc && (
                    <button type="button" onClick={() => setShowCc(true)}
                      className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-500 hover:text-gray-900 px-1.5 py-1 rounded-md hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                      <Plus size={9} strokeWidth={2.5} aria-hidden /> Cc
                    </button>
                  )}
                </div>
              </Row>

              {showCc && (
                <Row label="Cc">
                  <input value={draft.cc} onChange={(e) => set({ cc: e.target.value })} autoFocus
                    placeholder="name@example.com" aria-label="Cc"
                    className="w-full bg-transparent border border-transparent hover:border-gray-300 rounded-md px-2 py-1 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:bg-white focus:border-blue-500 transition-colors" />
                </Row>
              )}

              {/* SUBJECT is the most important field after the body — it is what
                  the customer sees in their inbox — so it gets the weight. */}
              <div className="mt-1.5 mb-2">
                <input value={draft.subject} onChange={(e) => set({ subject: e.target.value })} aria-label="Subject"
                  required aria-required="true" placeholder="Subject"
                  className={`w-full bg-white border rounded-md px-2.5 py-2 text-sm font-semibold text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors ${
                    draft.subject.trim() ? 'border-gray-300 focus:border-blue-500' : 'border-amber-300 focus:border-blue-500'
                  }`} />
              </div>

              <textarea ref={bodyRef} value={draft.body} onChange={(e) => set({ body: e.target.value })} rows={5}
                aria-label="Message" placeholder="Write your message…"
                className="w-full min-h-[112px] bg-white border border-gray-300 rounded-md px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none leading-relaxed transition-colors" />

              {error && (
                <p role="alert" className="flex items-start gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                  <TriangleAlert size={12} strokeWidth={2} className="shrink-0 mt-px" aria-hidden />
                  <span>
                    {error}
                    {needsReconnect && (
                      <> <a href={connectHref} className="underline font-semibold">Reconnect Gmail</a>.</>
                    )}
                  </span>
                </p>
              )}
            </div>

            <footer className="flex items-center gap-2 px-3.5 py-2.5 border-t border-gray-200 shrink-0 flex-wrap">
              {/* Three visibly different states. Disabled is a flat grey button,
                  not a dimmed blue one — the old 40%-opacity blue read as
                  "enabled but broken", which is exactly how it was reported. */}
              <button onClick={send} disabled={!canSend}
                title={canSend ? 'Send (⌘↵)' : `Still needs ${missing.join(', ')}`}
                className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-3.5 py-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  sending
                    ? 'bg-blue-500 text-white cursor-wait'
                    : canSend
                      ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                      : 'bg-gray-200 text-gray-500 border border-gray-300 cursor-not-allowed'
                }`}>
                {sending ? <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden /> : <Send size={12} strokeWidth={2} aria-hidden />}
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button onClick={onClose} disabled={sending}
                className="text-[11px] text-gray-600 hover:text-gray-900 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded px-1">
                Cancel
              </button>

              {/* Says what is still missing instead of leaving a dead button. */}
              {missing.length > 0 && !sending && (
                <span className="text-[10px] text-amber-700">
                  Needs {missing.join(', ')}
                </span>
              )}

              <span className="ml-auto text-[10px] text-gray-400 hidden sm:inline">
                ⌘↵ to send · draft saved
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 w-[52px] shrink-0">{label}</span>
      {children}
    </label>
  )
}

function Notice({ tone, title, children }: { tone: 'info' | 'warn'; title: string; children: React.ReactNode }) {
  const cls = tone === 'warn'
    ? 'bg-amber-50 border-amber-200 text-amber-700'
    : 'bg-blue-50 border-blue-200 text-blue-700'
  return (
    <div className={`m-4 rounded-lg border px-3 py-2 ${cls}`}>
      <p className="text-xs font-semibold">{title}</p>
      <p className="text-[11px] mt-0.5 leading-relaxed">{children}</p>
    </div>
  )
}
