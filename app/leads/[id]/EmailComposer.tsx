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
import { X, Send, TriangleAlert, Link2, Loader2 } from 'lucide-react'

export interface Alias { email: string; displayName: string; isPrimary: boolean; isDefault: boolean }

export interface GmailStatus {
  connected: boolean
  configured: boolean
  aliases: Alias[]
  reason?: string | null
  needsReconnect?: boolean
  connectedAt?: string
}

interface Draft { from: string; to: string; cc: string; subject: string; body: string }

const draftKey = (leadId: string) => `zee-email-draft-${leadId}`

export default function EmailComposer({ leadId, leadEmail, leadName, siteId, siteName, onClose, onSent }: {
  leadId: string
  leadEmail: string
  leadName: string
  siteId: string
  siteName: string
  onClose: () => void
  onSent: () => void
}) {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [needsReconnect, setNeedsReconnect] = useState(false)
  const [draft, setDraft] = useState<Draft>({ from: '', to: leadEmail, cc: '', subject: '', body: '' })
  const seeded = useRef(false)

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
            to: typeof d.to === 'string' && d.to ? d.to : cur.to,
            cc: typeof d.cc === 'string' ? d.cc : '',
            subject: typeof d.subject === 'string' ? d.subject : '',
            body: typeof d.body === 'string' ? d.body : '',
          }))
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
        body: JSON.stringify(draft),
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

  const connectHref = `/api/google/gmail/connect?back=${encodeURIComponent(`/leads/${leadId}`)}`
  const canSend = !!draft.from && !!draft.to.trim() && !!draft.subject.trim() && !!draft.body.trim() && !sending

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center px-4 py-8 bg-gray-900/40 backdrop-blur-sm"
      role="dialog" aria-modal="true" aria-label="Compose email"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm w-full max-w-2xl animate-in flex flex-col max-h-[85vh]">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 shrink-0">
          <Send size={13} strokeWidth={2} className="text-gray-400" aria-hidden />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            Email {leadName || leadEmail}
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
            <div className="p-3 space-y-2 overflow-y-auto">
              <Row label="From">
                <select value={draft.from} onChange={(e) => set({ from: e.target.value })}
                  aria-label="Send from"
                  className="w-full bg-gray-100 border border-gray-200 rounded-md px-1.5 py-1 text-xs text-gray-900 cursor-pointer focus:outline-none focus:border-blue-500">
                  {status.aliases.map((a) => (
                    <option key={a.email} value={a.email} className="bg-white text-gray-800">
                      {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="To">
                <input value={draft.to} onChange={(e) => set({ to: e.target.value })} aria-label="To"
                  className="w-full bg-gray-100 border border-gray-200 rounded-md px-1.5 py-1 text-xs text-gray-900 focus:outline-none focus:border-blue-500" />
              </Row>
              <Row label="Cc">
                <input value={draft.cc} onChange={(e) => set({ cc: e.target.value })} placeholder="optional" aria-label="Cc"
                  className="w-full bg-gray-100 border border-gray-200 rounded-md px-1.5 py-1 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
              </Row>
              <Row label="Subject">
                <input value={draft.subject} onChange={(e) => set({ subject: e.target.value })} aria-label="Subject"
                  className="w-full bg-gray-100 border border-gray-200 rounded-md px-1.5 py-1 text-xs font-medium text-gray-900 focus:outline-none focus:border-blue-500" />
              </Row>
              <textarea value={draft.body} onChange={(e) => set({ body: e.target.value })} rows={12}
                aria-label="Message" placeholder="Write your message…"
                className="w-full bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-y leading-relaxed" />

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

            <footer className="flex items-center gap-2 px-3 py-2 border-t border-gray-100 shrink-0">
              <button onClick={send} disabled={!canSend}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {sending ? <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden /> : <Send size={12} strokeWidth={2} aria-hidden />}
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button onClick={onClose} className="text-[11px] text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                Cancel
              </button>
              <span className="ml-auto text-[10px] text-gray-400">
                Sends from your Gmail · draft saved as you type
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
