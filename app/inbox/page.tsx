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
import { ArrowLeft, ExternalLink, FileText, Image as ImageIcon, Inbox as InboxIcon, Mail, Paperclip, PenLine, RefreshCw, Reply, Send, type LucideIcon } from 'lucide-react'
import { formatDateTime, formatShortDate, formatTime, pktDayKey, timeAgo } from '@/lib/datetime'
import GlobalSearch from '@/app/components/GlobalSearch'
import type { LeadRecord, TimelineEvent } from '@/lib/leadrecord'
import { EmailEntry, InboundEntry, Files, type ReplyContext } from '@/app/leads/[id]/Timeline'
import EmailComposer from '@/app/leads/[id]/EmailComposer'

interface Thread {
  leadId: string; siteId: string; siteName: string
  subject: string; from: string; snippet: string
  at: string | null; direction: 'in' | 'out'
  messages: number; unread: number; hasAttachments?: boolean; owner: string | null
  participants: string[]; files: { name: string; mime: string }[]; lastOutAt: string | null
}

export default function InboxPage() {
  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'unavailable' | 'error'>('loading')
  const [folder, setFolder] = useState<'inbox' | 'sent' | 'drafts'>('inbox')
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [open, setOpen] = useState<Thread | null>(null)
  const [composeNew, setComposeNew] = useState(false)
  const [picking, setPicking] = useState(false)
  const [pick, setPick] = useState('')
  const [drafts, setDrafts] = useState<{ leadId: string; subject: string; body: string }[]>([])

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

  // Drafts live where the composer keeps them: localStorage, one per lead.
  const readDrafts = useCallback(() => {
    const out: { leadId: string; subject: string; body: string }[] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || ''
        if (!k.startsWith('zee-email-draft-')) continue
        const d = JSON.parse(localStorage.getItem(k) || '{}')
        const body = String(d.html || d.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        if (!String(d.subject || '').trim() && !body) continue
        out.push({ leadId: k.slice('zee-email-draft-'.length), subject: String(d.subject || ''), body })
      }
    } catch { /* storage blocked */ }
    setDrafts(out)
  }, [])
  useEffect(() => { void Promise.resolve().then(readDrafts) }, [readDrafts, open, folder])

  const all = threads ?? []
  const unreadTotal = all.reduce((n, t) => n + t.unread, 0)
  const sent = all.filter((t) => t.lastOutAt).sort((a, b) => String(b.lastOutAt).localeCompare(String(a.lastOutAt)))
  const list = folder === 'inbox' ? all.filter((t) => !onlyUnread || t.unread > 0)
    : folder === 'sent' ? sent
    : []
  const byLead = new Map(all.map((t) => [t.leadId, t]))
  const pickList = pick.trim()
    ? all.filter((t) => `${t.from} ${t.subject} ${t.siteName}`.toLowerCase().includes(pick.trim().toLowerCase())).slice(0, 12)
    : all.slice(0, 12)

  const openThread = (t: Thread, compose = false) => { setComposeNew(compose); setOpen(t); setPicking(false); setPick('') }

  const NAV = (key: typeof folder, label: string, Icon: LucideIcon, count?: number) => (
    <button onClick={() => { setFolder(key); setOpen(null) }}
      className={`w-full flex items-center gap-3 px-4 py-1.5 rounded-r-full text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        folder === key && !open ? 'bg-blue-100 text-blue-900 font-bold' : 'text-gray-700 hover:bg-gray-200'}`}>
      <Icon size={16} strokeWidth={folder === key ? 2.2 : 1.8} aria-hidden />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && count > 0 && <span className="text-xs font-bold tabular-nums">{count}</span>}
    </button>
  )

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      <div className="border-b border-gray-200 bg-white/95 backdrop-blur px-5 py-3 flex items-center justify-between gap-3 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          {open ? (
            <button onClick={() => setOpen(null)}
              className="px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition-colors inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <ArrowLeft size={13} strokeWidth={2} aria-hidden /> Back
            </button>
          ) : (
            <Link href="/" className="px-2.5 py-1.5 text-xs text-gray-500 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-lg transition-colors inline-flex items-center gap-1">
              <ArrowLeft size={13} strokeWidth={2} aria-hidden /> Dashboard
            </Link>
          )}
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900 leading-tight flex items-center gap-2 truncate">
              <InboxIcon size={15} strokeWidth={2} className="shrink-0" aria-hidden />
              <span className="truncate">{open ? (open.subject || '(no subject)') : 'Mail'}</span>
            </h1>
            <p className="text-gray-500 text-[11px] truncate">
              {open ? `${open.participants.join(', ') || open.from || 'Conversation'} · ${open.siteName}`
                : status === 'ok' ? (unreadTotal > 0 ? `${unreadTotal} unread` : 'All caught up') : ' '}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <GlobalSearch />
          {!open && folder === 'inbox' && (
            <button onClick={() => setOnlyUnread((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${onlyUnread ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-100'}`}>
              Unread only
            </button>
          )}
        </div>
      </div>

      <div className="flex">
        {/* ── Gmail's left rail ─────────────────────────────────────────── */}
        <aside className="hidden sm:block w-56 shrink-0 pt-4 pr-2">
          <div className="px-3 mb-3">
            <button onClick={() => { setPicking(true); setOpen(null) }}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-blue-100 hover:bg-blue-200 text-blue-900 text-sm font-semibold shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              <PenLine size={16} strokeWidth={2} aria-hidden /> Compose
            </button>
          </div>
          {NAV('inbox', 'Inbox', InboxIcon, unreadTotal)}
          {NAV('sent', 'Sent', Send)}
          {NAV('drafts', 'Drafts', FileText, drafts.length)}
        </aside>

        <main className="flex-1 min-w-0">
          {open ? (
            <ThreadView thread={open} composeNew={composeNew} onChanged={load} />
          ) : (
          <div className="p-2 sm:p-4 sm:pl-0">
            {/* Compose: pick who it is to — a lead — then the composer opens on their thread. */}
            {picking && (
              <div className="mb-3 bg-white rounded-2xl border border-gray-200 p-3">
                <div className="flex items-center gap-2">
                  <PenLine size={14} className="text-gray-500 shrink-0" aria-hidden />
                  <input autoFocus value={pick} onChange={(e) => setPick(e.target.value)} placeholder="To — type a name, email or site…"
                    className="flex-1 text-sm bg-transparent focus:outline-none" />
                  <button onClick={() => { setPicking(false); setPick('') }} className="text-xs text-gray-500 hover:text-gray-900">Cancel</button>
                </div>
                <div className="mt-2 divide-y divide-gray-100 max-h-72 overflow-y-auto">
                  {pickList.map((t) => (
                    <button key={t.leadId} onClick={() => openThread(t, true)}
                      className="w-full text-left px-2 py-1.5 text-sm hover:bg-gray-100 rounded flex items-center gap-2">
                      <span className="font-medium truncate">{t.from || '(no name)'}</span>
                      <span className="text-[10px] text-gray-500 border border-gray-200 bg-gray-100 rounded-full px-1.5 shrink-0">{t.siteName}</span>
                      <span className="text-xs text-gray-500 truncate">{t.subject}</span>
                    </button>
                  ))}
                  {pickList.length === 0 && <p className="text-xs text-gray-500 px-2 py-2">No matching lead. Open the lead from the dashboard to email them.</p>}
                </div>
              </div>
            )}

            {/* Mobile folder switch — the rail is hidden below sm */}
            <div className="sm:hidden flex gap-1 mb-2">
              {(['inbox', 'sent', 'drafts'] as const).map((f) => (
                <button key={f} onClick={() => setFolder(f)}
                  className={`px-3 py-1 rounded-full text-xs font-medium ${folder === f ? 'bg-blue-100 text-blue-900' : 'bg-white border border-gray-200 text-gray-700'}`}>
                  {f[0].toUpperCase() + f.slice(1)}
                </button>
              ))}
            </div>

            {status === 'loading' && (
              <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-200/60 rounded-xl animate-pulse" />
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

            {status === 'ok' && folder === 'drafts' && (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden divide-y divide-gray-100">
                {drafts.length === 0 && <p className="text-sm text-gray-500 text-center py-16">No drafts.</p>}
                {drafts.map((d) => {
                  const t = byLead.get(d.leadId)
                  return (
                    <button key={d.leadId} onClick={() => { if (t) openThread(t, true) }}
                      className="w-full text-left flex items-center gap-3 px-4 py-2.5 hover:bg-gray-100 transition-colors">
                      <span className="w-44 shrink-0 text-sm text-red-700 font-medium truncate">Draft{t ? ` · ${t.from}` : ''}</span>
                      <span className="min-w-0 flex-1 text-sm truncate"><span className="text-gray-900">{d.subject || '(no subject)'}</span><span className="text-gray-500"> - {d.body}</span></span>
                      {t && <span className="text-[10px] text-gray-500 border border-gray-200 bg-gray-100 rounded-full px-1.5 shrink-0">{t.siteName}</span>}
                    </button>
                  )
                })}
              </div>
            )}

            {status === 'ok' && folder !== 'drafts' && list.length === 0 && (
              <div className="text-center py-20">
                <InboxIcon size={28} strokeWidth={1.5} className="mx-auto text-gray-400 mb-3" aria-hidden />
                <p className="text-sm font-medium text-gray-700">{folder === 'sent' ? 'Nothing sent yet' : onlyUnread ? 'Nothing unread' : 'No email conversations yet'}</p>
              </div>
            )}

            {status === 'ok' && folder !== 'drafts' && list.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden divide-y divide-gray-100">
                {list.map((t) => {
                  const unread = t.unread > 0
                  const when = folder === 'sent' ? t.lastOutAt : t.at
                  const who = t.participants.length ? t.participants.join(', ') : (t.from || '(no sender)')
                  return (
                    /* A real link (middle-click opens the record), a plain click opens the thread here. */
                    <a key={t.leadId} href={`/leads/${encodeURIComponent(t.leadId)}`}
                      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); openThread(t) }}
                      className={`block px-3 sm:px-4 py-2 transition-colors hover:shadow-[inset_0_-1px_0_0_rgba(0,0,0,0.06),0_1px_3px_rgba(0,0,0,0.12)] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${unread ? 'bg-white' : 'bg-gray-50/70'}`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${unread ? 'bg-blue-600' : 'bg-transparent'}`} aria-hidden />
                        {/* Gmail's participants column: "Samir, Damaria 10" */}
                        <span className={`w-40 sm:w-48 shrink-0 text-sm truncate ${unread ? 'font-bold text-gray-900' : 'text-gray-800'}`} title={who}>
                          {who}{t.messages > 1 && <span className="ml-1 text-xs font-normal text-gray-500 tabular-nums">{t.messages}</span>}
                        </span>
                        <span className="min-w-0 flex-1 text-sm truncate">
                          <span className={unread ? 'font-bold text-gray-900' : 'text-gray-900'}>{t.subject || '(no subject)'}</span>
                          {t.snippet && <span className="text-gray-500"> - {t.snippet}</span>}
                        </span>
                        <span className="hidden md:inline text-[10px] text-gray-500 border border-gray-200 bg-gray-100 rounded-full px-1.5 py-px truncate max-w-[120px] shrink-0">{t.siteName}</span>
                        <span className={`text-xs shrink-0 tabular-nums w-16 text-right ${unread ? 'font-bold text-gray-900' : 'text-gray-500'}`} title={when ? formatDateTime(when) : undefined}>
                          {gmailDate(when)}
                        </span>
                      </div>
                      {t.files.length > 0 && (
                        <div className="mt-1 ml-5 sm:ml-[13.25rem] flex items-center gap-1.5 flex-wrap">
                          {t.files.slice(0, 3).map((f, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-xs text-gray-700 border border-gray-300 rounded-full px-2 py-0.5 max-w-[150px]">
                              <FileIcon mime={f.mime} />
                              <span className="truncate">{f.name}</span>
                            </span>
                          ))}
                          {t.files.length > 3 && <span className="text-xs text-gray-600 border border-gray-300 rounded-full px-2 py-0.5">+{t.files.length - 3}</span>}
                        </div>
                      )}
                    </a>
                  )
                })}
              </div>
            )}
          </div>
          )}
        </main>
      </div>
    </div>
  )
}

// Gmail's date column: the time today, the short date otherwise.
function gmailDate(at: string | null | undefined): string {
  if (!at) return ''
  return pktDayKey(at) === pktDayKey(new Date()) ? formatTime(at) : formatShortDate(at)
}

function FileIcon({ mime }: { mime: string }) {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return <ImageIcon size={12} className="text-red-500 shrink-0" aria-hidden />
  if (m.includes('pdf')) return <FileText size={12} className="text-red-600 shrink-0" aria-hidden />
  return <Paperclip size={12} className="text-gray-500 shrink-0" aria-hidden />
}

// One conversation, Gmail-style: the record's own email events in order,
// oldest first, with the record's own composer for the reply. The record IS
// the storage — this view adds nothing the record page will not also show.
function ThreadView({ thread, onChanged, composeNew = false }: { thread: Thread; onChanged: () => void; composeNew?: boolean }) {
  const [record, setRecord] = useState<LeadRecord | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [composing, setComposing] = useState(composeNew)
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
