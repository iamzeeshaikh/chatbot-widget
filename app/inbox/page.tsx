'use client'

// The Inbox — /inbox.
//
// A mailbox, the way Gmail shows one. The LIST is every email conversation
// this member may see: unread bold with a count, the customer's own words as
// the preview, newest first. Clicking a row opens the THREAD right here —
// every message in order, quoted history behind a toggle, attachments inline,
// and a Reply that goes through the record's own composer. Nothing is stored
// twice: the thread is the lead's record read through /api/leads/<id>, the
// reply is the record's send route, and read-marking is the record's rows —
// so the record page shows every word of what happens here, automatically.
//
// Built from the record page's design system: the same type scale, tabular
// numbers and lucide icons at one stroke weight, in the light Tailwind
// utilities globals.css remaps for dark mode.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, ExternalLink, Inbox as InboxIcon, Mail, Paperclip, PenLine, RefreshCw, Reply } from 'lucide-react'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import GlobalSearch from '@/app/components/GlobalSearch'
import type { LeadRecord, TimelineEvent } from '@/lib/leadrecord'
import { EmailEntry, InboundEntry, Files, type ReplyContext } from '@/app/leads/[id]/Timeline'
import EmailComposer from '@/app/leads/[id]/EmailComposer'

interface Thread {
  leadId: string; siteId: string; siteName: string
  subject: string; from: string; snippet: string
  at: string | null; direction: 'in' | 'out'
  messages: number; unread: number; hasAttachments?: boolean; owner: string | null
}

export default function InboxPage() {
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'unavailable' | 'error'>('loading')
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [open, setOpen] = useState<Thread | null>(null)

  const load = useCallback(() => fetch('/api/inbox')
    .then(async (r) => {
      if (r.status === 403) { setStatus('unavailable'); return }
      if (!r.ok) { setStatus('error'); return }
      const d = await r.json()
      setThreads(d.threads ?? [])
      setStatus('ok')
    })
    .catch(() => setStatus('error')), [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 60000)
    return () => clearInterval(iv)
  }, [load])

  const list = (threads ?? []).filter((t) => !onlyUnread || t.unread > 0)
  const unreadTotal = (threads ?? []).reduce((n, t) => n + t.unread, 0)

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <div className="border-b border-gray-200 bg-white/95 backdrop-blur px-5 py-3 flex items-center justify-between gap-3 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          {open ? (
            <button onClick={() => setOpen(null)}
              className="px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition-colors inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <ArrowLeft size={13} strokeWidth={2} aria-hidden /> Inbox
            </button>
          ) : (
            <Link href="/" className="px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition-colors inline-flex items-center gap-1">
              <ArrowLeft size={13} strokeWidth={2} aria-hidden /> Dashboard
            </Link>
          )}
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900 leading-tight flex items-center gap-2 truncate">
              <InboxIcon size={15} strokeWidth={2} className="shrink-0" aria-hidden />
              <span className="truncate">{open ? (open.subject || '(no subject)') : 'Inbox'}</span>
            </h1>
            <p className="text-gray-500 text-[11px] truncate">
              {open
                ? `${open.from || 'Conversation'} · ${open.siteName}`
                : status === 'ok'
                  ? unreadTotal > 0
                    ? `${unreadTotal} unread repl${unreadTotal === 1 ? 'y' : 'ies'} from customers`
                    : 'Nothing unread — all caught up'
                  : ' '}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <GlobalSearch />
          {!open && (
            <button onClick={() => setOnlyUnread((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${onlyUnread ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
              Unread only
            </button>
          )}
        </div>
      </div>

      {open ? (
        <ThreadView thread={open} onChanged={load} />
      ) : (
      <div className="p-4 sm:p-6 max-w-5xl mx-auto">
        {status === 'loading' && (
          <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-200/60 rounded-xl animate-pulse" />
          ))}</div>
        )}

        {status === 'unavailable' && (
          <div className="text-center py-20">
            <Mail size={28} strokeWidth={1.5} className="mx-auto text-gray-400 mb-3" aria-hidden />
            <p className="text-sm font-medium text-gray-700">Email is not enabled for this workspace</p>
          </div>
        )}
        {status === 'error' && (
          <div className="text-center py-20">
            <p className="text-sm font-medium text-gray-700">The inbox could not be loaded.</p>
            <button onClick={() => location.reload()} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100">
              <RefreshCw size={12} strokeWidth={2} aria-hidden /> Try again
            </button>
          </div>
        )}

        {status === 'ok' && list.length === 0 && (
          <div className="text-center py-20">
            <InboxIcon size={28} strokeWidth={1.5} className="mx-auto text-gray-400 mb-3" aria-hidden />
            <p className="text-sm font-medium text-gray-700">{onlyUnread ? 'Nothing unread' : 'No email conversations yet'}</p>
            <p className="text-xs text-gray-500 mt-1">{onlyUnread ? 'Every customer reply has been read.' : 'Email a lead from their record and the thread will appear here.'}</p>
          </div>
        )}

        {status === 'ok' && list.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden divide-y divide-gray-100">
            {list.map((t) => {
              const unread = t.unread > 0
              return (
                /* A real link (middle-click opens the record in a tab), but a
                   plain click opens the thread HERE, like Gmail. */
                <a key={t.leadId} href={`/leads/${encodeURIComponent(t.leadId)}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return
                    e.preventDefault()
                    setOpen(t)
                  }}
                  className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${unread ? 'bg-blue-50/40' : ''}`}>
                  {/* The unread dot is the row's anchor: scanning the left edge
                      answers "what needs me" without reading a word. */}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${unread ? 'bg-blue-600' : 'bg-transparent'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`text-sm truncate ${unread ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>{t.from || '(no sender)'}</span>
                      {unread && <span className="text-[10px] font-bold text-white bg-blue-600 rounded-full px-1.5 py-px tabular-nums shrink-0">{t.unread}</span>}
                      <span className="text-[10px] text-gray-500 border border-gray-200 bg-gray-100 rounded-full px-1.5 py-px truncate max-w-[130px] shrink-0">{t.siteName}</span>
                      {t.hasAttachments && <Paperclip size={11} className="text-gray-400 shrink-0" aria-label="Has attachments" />}
                    </span>
                    <span className="block text-xs text-gray-700 truncate mt-0.5">
                      <span className={unread ? 'font-semibold' : ''}>{t.subject || '(no subject)'}</span>
                      {t.snippet && <span className="text-gray-500"> — {t.direction === 'out' && <Reply size={10} className="inline -mt-px mr-0.5" aria-hidden />}{t.snippet}</span>}
                    </span>
                  </span>
                  <span className="text-[11px] text-gray-500 shrink-0 tabular-nums" title={t.at ? formatDateTime(t.at) : undefined}>
                    {t.at ? timeAgo(t.at) : ''}
                  </span>
                </a>
              )
            })}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

// One conversation, Gmail-style: the record's own email events in order,
// oldest first, with the record's own composer for the reply. The record IS
// the storage — this view adds nothing the record page will not also show.
function ThreadView({ thread, onChanged }: { thread: Thread; onChanged: () => void }) {
  const [record, setRecord] = useState<LeadRecord | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [composing, setComposing] = useState(false)
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const markedRef = useRef(false)

  const loadRecord = useCallback(async () => {
    try {
      const r = await fetch(`/api/leads/${encodeURIComponent(thread.leadId)}`)
      if (!r.ok) { setState('error'); return }
      const d = await r.json()
      setRecord(d.record as LeadRecord)
      setState('ok')
    } catch {
      setState('error')
    }
  }, [thread.leadId])

  useEffect(() => { void Promise.resolve().then(loadRecord) }, [loadRecord])

  // Opening the thread reads it — exactly what opening the record does. Once
  // per open, and the LIST refreshes after, so the blue dot dies everywhere at
  // the same moment: here, on the record, and on the nav badge's next poll.
  useEffect(() => {
    if (!record || markedRef.current) return
    const ids = record.timeline
      .filter((e) => e.kind === 'email_in' && e.unread && e.inbound)
      .map((e) => e.inbound!.gmailId)
    if (ids.length === 0) return
    markedRef.current = true
    fetch(`/api/leads/${encodeURIComponent(record.id)}/email/read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gmailIds: ids }),
    }).then(() => { loadRecord(); onChanged() }).catch(() => { markedRef.current = false })
  }, [record, loadRecord, onChanged])

  const events = (record?.timeline ?? [])
    .filter((e) => (e.kind === 'email' && e.email) || (e.kind === 'email_in' && e.inbound))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  // The newest message is what you came to read.
  useEffect(() => {
    if (state === 'ok' && events.length > 0) endRef.current?.scrollIntoView({ block: 'end' })
  }, [state, events.length])

  const latestInbound = [...events].reverse().find((e) => e.kind === 'email_in' && e.inbound)
  const latestSent = [...events].reverse().find((e) => e.kind === 'email' && e.email?.gmailId)
  const reify = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`)
  const openReply = (ctx: ReplyContext | null) => {
    // Replying without picking a message answers the latest thing the
    // customer said — the Gmail default.
    if (!ctx && latestInbound?.inbound) {
      const inb = latestInbound.inbound
      ctx = { replyToGmailId: inb.gmailId, to: inb.from, subject: reify(inb.subject) }
    }
    // No customer reply yet — a follow-up on OUR last send, still in the same
    // Gmail thread. Without this, Reply opened a blank unthreaded "New email"
    // (a real complaint, 2026-09-04): threadContextFor resolves a SENT
    // message's gmailId too, so the headers chain exactly as Gmail would.
    if (!ctx && latestSent?.email) {
      const out = latestSent.email
      ctx = { replyToGmailId: out.gmailId, to: out.to, subject: reify(out.subject) }
    }
    setReplyTo(ctx)
    setComposing(true)
  }

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      {state === 'loading' && (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-28 bg-gray-200/60 rounded-2xl animate-pulse" />
        ))}</div>
      )}
      {state === 'error' && (
        <div className="text-center py-20">
          <p className="text-sm font-medium text-gray-700">This conversation could not be loaded.</p>
          <button onClick={() => { setState('loading'); loadRecord() }}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100">
            <RefreshCw size={12} strokeWidth={2} aria-hidden /> Try again
          </button>
        </div>
      )}

      {state === 'ok' && record && (
        <>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-[11px] text-gray-500 truncate">
              With <span className="font-medium text-gray-700">{record.contact.name || record.contact.email || 'this lead'}</span> · {record.siteName}
            </p>
            <Link href={`/leads/${encodeURIComponent(record.id)}`}
              className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:text-blue-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
              <ExternalLink size={11} strokeWidth={2} aria-hidden /> Open the full record
            </Link>
          </div>

          {events.length === 0 && (
            <div className="text-center py-16 bg-white rounded-2xl border border-gray-200">
              <Mail size={24} strokeWidth={1.5} className="mx-auto text-gray-400 mb-2" aria-hidden />
              <p className="text-xs text-gray-500">No email on this lead yet.</p>
            </div>
          )}

          <div className="space-y-3">
            {events.map((e) => (
              <MessageCard key={e.id} e={e} leadId={record.id}
                onReply={(ctx) => openReply(ctx)}
                onRetryFile={async (gmailId, name) => {
                  const res = await fetch(`/api/leads/${encodeURIComponent(record.id)}/email/attachment`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gmailId, name }),
                  })
                  const j = await res.json().catch(() => ({}))
                  if (!res.ok) throw new Error(j.error || 'Could not fetch that file.')
                  await loadRecord()
                }} />
            ))}
          </div>
          <div ref={endRef} />

          {/* The reply lives at the bottom of the thread, where Gmail puts it. */}
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => openReply(null)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <Reply size={13} strokeWidth={2} aria-hidden /> Reply
            </button>
            <button onClick={() => { setReplyTo(null); setComposing(true) }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-xl bg-white border border-gray-300 text-gray-700 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <PenLine size={13} strokeWidth={2} aria-hidden /> New email
            </button>
          </div>

          {composing && (
            <EmailComposer
              leadId={record.id}
              leadEmail={record.contact.email}
              leadName={record.contact.name}
              contactsHidden={record.contactsHidden}
              recipientLocked={record.recipientLocked}
              siteId={record.siteId}
              siteName={record.siteName}
              replyTo={replyTo}
              onClose={() => { setComposing(false); setReplyTo(null) }}
              onSent={() => { loadRecord(); onChanged() }}
            />
          )}
        </>
      )}
    </div>
  )
}

// One message in the conversation. The BODY is the record page's own component
// (EmailEntry / InboundEntry / Files, exported from Timeline.tsx), so a
// message can never read differently here and there; this card only adds the
// Gmail dressing — avatar, who, when.
function MessageCard({ e, onReply, onRetryFile }: {
  e: TimelineEvent
  leadId: string
  onReply: (ctx: ReplyContext) => void
  onRetryFile: (gmailId: string, name: string) => Promise<void>
}) {
  const inbound = e.kind === 'email_in'
  const who = inbound
    ? (e.inbound!.fromName || e.inbound!.from || 'Customer')
    : e.actor
  const initial = (who.replace(/[^A-Za-z0-9]/g, '') || '?').charAt(0).toUpperCase()
  return (
    <div className={`bg-white rounded-2xl border px-4 py-3 ${inbound && e.unread ? 'border-violet-300 ring-1 ring-violet-200' : 'border-gray-200'}`}>
      <div className="flex items-center gap-2.5">
        <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${inbound ? 'bg-violet-100 text-violet-700' : 'bg-sky-100 text-sky-700'}`} aria-hidden>
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-gray-900 truncate">{who}</p>
          <p className="text-[10px] text-gray-500">{inbound ? 'Customer' : 'Sent by us'}</p>
        </div>
        <span className="text-[11px] text-gray-500 shrink-0 tabular-nums" title={formatDateTime(e.at)}>{timeAgo(e.at)}</span>
      </div>
      {inbound && e.inbound ? (
        <><InboundEntry entry={e.inbound} unread={!!e.unread} onReply={onReply} /><Files files={e.files} skipped={e.inbound.skippedAttachments} gmailId={e.inbound.gmailId} onRetryFile={onRetryFile} /></>
      ) : e.email ? (
        <><EmailEntry entry={e.email} /><Files files={e.files} /></>
      ) : null}
    </div>
  )
}
