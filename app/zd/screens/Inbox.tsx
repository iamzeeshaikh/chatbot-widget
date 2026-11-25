'use client'

// ZeeDesk's email inbox: every email conversation this member may see on the
// left, the open conversation in the middle with the reply box under it, and
// the customer on the right.
//
// Nothing is stored here. The list is /api/inbox, a conversation is the lead's
// own record read through /api/leads/<id>, a reply goes through that record's
// send route and reading marks that record's rows, so whatever happens on this
// screen is on the lead's record too. Every one of those routes decides on the
// server who may see or send what; this file only draws the answer.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Check, CheckCheck, ChevronDown, ChevronRight, CornerUpLeft, ExternalLink, FileText, Image as ImageIcon, Link2,
  Loader2, Mail, MessageCircle, Paperclip, PenLine, RefreshCw, Search, Send, TriangleAlert, UserRound, X,
} from 'lucide-react'
import { dateDividerLabel, formatDateTime, formatShortDate, formatTime, pktDayKey, timeAgo } from '@/lib/datetime'
import { hasFeature } from '@/lib/workspaces'
import { plainToHtml } from '@/lib/richtext'
import { matchSiteAlias } from '@/lib/sitealias'
import { waErrorHint } from '@/lib/whatsapp'
import { MAX_EMAIL_ATTACHMENT_BYTES, MAX_EMAIL_ATTACHMENTS, MAX_EMAIL_ATTACHMENTS_TOTAL, humanSize, isRetryableSkip } from '@/lib/emailattach'
import type { LeadRecord, TimelineEvent } from '@/lib/leadrecord'
import { Avatar, Chip, Notice, BTN_PLAIN, BTN_PRIMARY, LABEL, postJson, short, type ZdScreenProps } from '../ui'
import { chatDing } from '../sound'
import RichEditor from '../RichEditor'

// ── Shapes the API hands back ───────────────────────────────────────────────

/** One row of GET /api/inbox. A conversation is a lead: `leadId` is its record id. */
interface Thread {
  leadId: string; siteId: string; siteName: string
  subject: string; from: string; snippet: string
  at: string | null; direction: 'in' | 'out'
  messages: number; unread: number; hasAttachments?: boolean; owner: string | null
  participants: string[]; files: { name: string; mime: string }[]; lastOutAt: string | null; lastOutOpened?: boolean
}

interface Alias { email: string; displayName: string; isPrimary: boolean; isDefault: boolean }

/** GET /api/google/gmail/status. */
interface GmailStatus {
  connected: boolean
  available?: boolean
  configured?: boolean
  aliases?: Alias[]
  reason?: string | null
  needsReconnect?: boolean
  /** False when the consent predates reply capture. Sending still works. */
  canReadReplies?: boolean
  replyCaptureReason?: string | null
  /** Gmail was throttling us when we asked. Connected, just busy. */
  rateLimited?: boolean
}

interface ReplyTo { replyToGmailId: string; to: string; subject: string }
interface Draft { from: string; to: string; cc: string; subject: string; body: string; html: string }
interface DraftRow { leadId: string; subject: string; body: string }
interface Attached { key: string; name: string; size: number; mime: string; path: string | null; progress: boolean }
interface Flash { text: string; bad?: boolean }

type Folder = 'inbox' | 'unread' | 'sent' | 'drafts'

// A half-written email is kept in the browser, one per lead, under the same key
// the lead's record page uses, so a draft started on either screen is found on both.
const DRAFT_PREFIX = 'zee-email-draft-'
const POLL_MS = 60000

const reSubject = (subject: string) => (/^re:/i.test(subject) ? subject : `Re: ${subject}`)

/** The time today, the short date otherwise. */
function listDate(at: string | null | undefined): string {
  if (!at) return ''
  return pktDayKey(at) === pktDayKey(new Date()) ? formatTime(at) : formatShortDate(at)
}

/** Marks the searched term inside a line of text. */
function highlight(text: string, q: string): ReactNode {
  if (!q) return text
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  let i = 0
  for (;;) {
    const j = lower.indexOf(q, i)
    if (j < 0) { parts.push(text.slice(i)); break }
    parts.push(text.slice(i, j), <mark key={j} className="bg-[#ffe9a8] text-inherit rounded-sm">{text.slice(j, j + q.length)}</mark>)
    i = j + q.length
  }
  return parts
}

function FileIcon({ mime, size = 12 }: { mime: string; size?: number }) {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return <ImageIcon size={size} className="shrink-0 text-[#68737d]" aria-hidden />
  if (m.includes('pdf')) return <FileText size={size} className="shrink-0 text-[#cc3340]" aria-hidden />
  return <Paperclip size={size} className="shrink-0 text-[#68737d]" aria-hidden />
}

function readDraftRows(): DraftRow[] {
  const out: DraftRow[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || ''
      if (!k.startsWith(DRAFT_PREFIX)) continue
      const d = JSON.parse(localStorage.getItem(k) || '{}')
      const body = String(d.html || d.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (!String(d.subject || '').trim() && !body) continue
      out.push({ leadId: k.slice(DRAFT_PREFIX.length), subject: String(d.subject || ''), body })
    }
  } catch { /* storage blocked: there are simply no drafts to list */ }
  return out
}

/** What Google sent the member back with after the consent screen, read once. */
function gmailReturn(): Flash | null {
  if (typeof window === 'undefined') return null
  const sp = new URLSearchParams(window.location.search)
  const g = sp.get('gmail')
  if (g === 'connected') return { text: 'Gmail is connected. You can send email now.' }
  if (g === 'error') return { text: sp.get('reason') || 'Gmail could not be connected. Try again.', bad: true }
  if (g === 'unavailable') return { text: 'Email is not enabled for this workspace.', bad: true }
  return null
}

/** Where the Connect button sends the member back to: this very screen. */
function connectLink(): string {
  if (typeof window === 'undefined') return '/api/google/gmail/connect?back=%2F'
  const sp = new URLSearchParams(window.location.search)
  sp.delete('gmail'); sp.delete('reason')
  const qs = sp.toString()
  return `/api/google/gmail/connect?back=${encodeURIComponent(`${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`)}`
}

// ── The email screen ──────────────────────────────────────────────────────────────

function MailInbox({ me, openLead, channelSwitch, startWith }: {
  me: ZdScreenProps['me']
  openLead: (recordId: string) => void
  /** The Email | WhatsApp switch, when the workspace has both. */
  channelSwitch: ReactNode
  /** A lead to open straight away with a new email started. */
  startWith: string | null
}) {
  const emailOn = hasFeature(me.workspace as Parameters<typeof hasFeature>[0], 'email')

  const [threads, setThreads] = useState<Thread[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'unavailable' | 'error'>(emailOn ? 'loading' : 'unavailable')
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [folder, setFolder] = useState<Folder>('inbox')
  const [typed, setTyped] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<{ leadId: string; compose: boolean } | null>(startWith ? { leadId: startWith, compose: true } : null)
  const [picking, setPicking] = useState(false)
  const [pick, setPick] = useState('')
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [gmail, setGmail] = useState<GmailStatus | null>(null)
  const [gmailFailed, setGmailFailed] = useState(false)
  const [returned, setReturned] = useState<Flash | null>(gmailReturn)
  const [connectHref] = useState(connectLink)
  const [showInfo, setShowInfo] = useState(true)

  const seq = useRef(0)
  const loadedAt = useRef(0)
  const gmailAt = useRef(0)

  // The consent result has been read into state; take it out of the address so
  // a reload does not announce it a second time.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('gmail')) return
    url.searchParams.delete('gmail'); url.searchParams.delete('reason')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  // Search runs on the server, across subjects, every message, senders and
  // file names. A new term means a new list is on its way, so the old one is
  // not left standing under the new heading.
  useEffect(() => {
    const next = typed.trim()
    if (next === q) return
    const id = setTimeout(() => { setQ(next); setStatus((s) => (s === 'unavailable' ? s : 'loading')) }, 300)
    return () => clearTimeout(id)
  }, [typed, q])

  const load = useCallback(async () => {
    const mine = ++seq.current
    loadedAt.current = Date.now()
    try {
      const r = await fetch(q ? `/api/inbox?q=${encodeURIComponent(q)}` : '/api/inbox')
      if (mine !== seq.current) return
      if (r.status === 403) { setStatus('unavailable'); return }
      if (!r.ok) throw new Error('failed')
      const d = await r.json()
      if (mine !== seq.current) return
      setThreads(d.threads ?? [])
      setStatus('ok')
      setRefreshFailed(false)
    } catch {
      if (mine !== seq.current) return
      // A failed refresh keeps the list already on screen; only a first load
      // or a new search has nothing to fall back on.
      setStatus((s) => (s === 'ok' ? 'ok' : 'error'))
      setRefreshFailed(true)
    }
  }, [q])

  // Once a minute, the cadence the server caches this list at.
  useEffect(() => {
    if (!emailOn) return
    const first = setTimeout(load, 0)
    const iv = setInterval(() => { if (!document.hidden) load() }, POLL_MS)
    const seen = () => { if (!document.hidden && Date.now() - loadedAt.current > POLL_MS) load() }
    document.addEventListener('visibilitychange', seen)
    return () => { clearTimeout(first); clearInterval(iv); document.removeEventListener('visibilitychange', seen) }
  }, [load, emailOn])

  const loadGmail = useCallback(async () => {
    gmailAt.current = Date.now()
    try {
      const r = await fetch('/api/google/gmail/status')
      if (!r.ok) throw new Error('failed')
      setGmail(await r.json())
      setGmailFailed(false)
    } catch {
      setGmailFailed(true)
    }
  }, [])
  /** The reply box asks for a fresh answer when it opens, unless one just arrived. */
  const ensureGmail = useCallback(() => { if (Date.now() - gmailAt.current > 30000) void loadGmail() }, [loadGmail])

  useEffect(() => {
    if (!emailOn) return
    const t = setTimeout(loadGmail, 0)
    return () => clearTimeout(t)
  }, [emailOn, loadGmail])

  const refreshDrafts = useCallback(() => setDrafts(readDraftRows()), [])
  useEffect(() => {
    const t = setTimeout(refreshDrafts, 0)
    return () => clearTimeout(t)
  }, [refreshDrafts, open, folder])

  const markReadLocally = useCallback((leadId: string) => {
    setThreads((prev) => (prev ? prev.map((t) => (t.leadId === leadId && t.unread ? { ...t, unread: 0 } : t)) : prev))
  }, [])

  const all = useMemo(() => threads ?? [], [threads])
  const unreadTotal = all.reduce((n, t) => n + t.unread, 0)
  const byLead = useMemo(() => new Map(all.map((t) => [t.leadId, t])), [all])
  const list = useMemo(() => {
    if (q) return all
    if (folder === 'inbox') return all
    if (folder === 'unread') return all.filter((t) => t.unread > 0)
    if (folder === 'sent') return all.filter((t) => t.lastOutAt).sort((a, b) => String(b.lastOutAt).localeCompare(String(a.lastOutAt)))
    return []
  }, [all, folder, q])
  const pickTerm = pick.trim().toLowerCase()
  const pickList = (pickTerm ? all.filter((t) => `${t.from} ${t.participants.join(' ')} ${t.subject} ${t.siteName}`.toLowerCase().includes(pickTerm)) : all).slice(0, 12)

  const openThread = (leadId: string, compose = false) => { setOpen({ leadId, compose }); setPicking(false); setPick('') }
  const clearSearch = () => { setTyped(''); if (q) { setQ(''); setStatus((s) => (s === 'unavailable' ? s : 'loading')) } }

  const TABS: { key: Folder; label: string; count?: number }[] = [
    { key: 'inbox', label: 'Inbox' },
    { key: 'unread', label: 'Unread', count: unreadTotal },
    { key: 'sent', label: 'Sent' },
    { key: 'drafts', label: 'Drafts', count: drafts.length },
  ]
  const showDrafts = status === 'ok' && folder === 'drafts' && !q
  const showRows = status === 'ok' && !showDrafts

  return (
    <>
      {/* ── Conversations ── */}
      <aside className="w-[340px] shrink-0 border-r border-[#d8dcde] flex flex-col bg-[#f8f9f9]" aria-label="Email conversations">
        <div className="px-4 pt-4 pb-2">
          {channelSwitch}
          <div className="flex items-center gap-2">
            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold text-[#2f3941]">Inbox</h1>
              <p className="text-[12px] text-[#68737d]">{status === 'ok' ? (unreadTotal > 0 ? `${unreadTotal} unread` : 'All caught up') : status === 'loading' ? 'Loading…' : ' '}</p>
            </div>
            <button type="button" onClick={() => { setPicking((v) => !v); setPick('') }} aria-expanded={picking} disabled={status !== 'ok'}
              className={`${BTN_PRIMARY} ml-auto`}><PenLine size={14} aria-hidden />New email</button>
          </div>

          {picking && (
            <div className="mt-3 rounded-md border border-[#d8dcde] bg-white">
              <label className="flex items-center gap-2 h-9 px-2.5 border-b border-[#e9ebed]">
                <span className="text-[12px] text-[#68737d]">To</span>
                <input autoFocus value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Name, email or site" aria-label="Who the new email is to"
                  onKeyDown={(e) => { if (e.key === 'Escape') { setPicking(false); setPick('') } }}
                  className="flex-1 min-w-0 bg-transparent outline-none text-[13px] placeholder:text-[#87929d]" />
                <button type="button" onClick={() => { setPicking(false); setPick('') }} aria-label="Cancel the new email" className="w-6 h-6 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed]"><X size={14} aria-hidden /></button>
              </label>
              <ul className="max-h-64 overflow-y-auto [scrollbar-width:thin]">
                {pickList.map((t) => (
                  <li key={t.leadId}>
                    <button type="button" onClick={() => openThread(t.leadId, true)} className="w-full text-left px-2.5 py-1.5 hover:bg-[#edf7ff]">
                      <span className="block truncate text-[13px] font-medium text-[#2f3941]">{t.from || 'No name'}</span>
                      <span className="block truncate text-[11px] text-[#68737d]">{t.siteName} · {t.subject || '(no subject)'}</span>
                    </button>
                  </li>
                ))}
                {pickList.length === 0 && <li className="px-2.5 py-3 text-[12px] text-[#68737d]">No customer here matches that. To email someone new, open their lead and write from there.</li>}
              </ul>
            </div>
          )}

          <div className="mt-3 flex gap-1" role="tablist" aria-label="Mail views">
            {TABS.map((v) => {
              const active = !q && folder === v.key
              return (
                <button key={v.key} type="button" role="tab" aria-selected={active} onClick={() => { setFolder(v.key); clearSearch() }}
                  className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${active ? 'bg-white text-[#1f73b7] shadow-[0_0_0_1px_#d8dcde]' : 'text-[#68737d] hover:bg-[#e9ebed]'}`}>
                  {v.label}{!!v.count && <span className="ml-1 tabular-nums opacity-80">{v.count}</span>}
                </button>
              )
            })}
          </div>

          <label className="mt-3 flex items-center gap-2 h-9 px-2.5 rounded-md bg-white border border-[#d8dcde] focus-within:border-[#1f73b7]">
            <Search size={15} className="text-[#87929d]" aria-hidden />
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search all mail" aria-label="Search all mail"
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] placeholder:text-[#87929d]" />
            {typed && <button type="button" onClick={clearSearch} aria-label="Clear the search" className="w-6 h-6 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed]"><X size={14} aria-hidden /></button>}
          </label>
        </div>

        <GmailBanner gmail={gmail} failed={gmailFailed} returned={returned} connectHref={connectHref}
          onRetry={loadGmail} onDismiss={() => setReturned(null)} />

        <div className="flex-1 overflow-y-auto [scrollbar-width:thin]">
          {status === 'loading' && (
            <div className="px-4 py-3 space-y-3" role="status" aria-label="Loading conversations">
              {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-14 rounded-md bg-[#e9ebed] animate-pulse" />)}
            </div>
          )}
          {status === 'unavailable' && (
            <div className="px-6 py-12 text-center">
              <Mail size={24} className="mx-auto mb-2 text-[#87929d]" aria-hidden />
              <p className="text-[13px] font-medium text-[#2f3941]">Email is not enabled for this workspace</p>
            </div>
          )}
          {status === 'error' && (
            <div className="px-6 py-12 text-center">
              <p role="alert" className="text-[13px] font-medium text-[#2f3941]">The inbox could not be loaded.</p>
              <button type="button" onClick={() => { setStatus('loading'); void load() }} className={`${BTN_PLAIN} mt-3`}><RefreshCw size={13} aria-hidden />Try again</button>
            </div>
          )}
          {status === 'ok' && refreshFailed && (
            <div className="px-4 py-2 border-b border-[#e9ebed] flex items-center gap-2">
              <Notice bad text="The list could not be refreshed, so it may be out of date." />
              <button type="button" onClick={() => void load()} className="ml-auto shrink-0 text-[12px] font-medium text-[#1f73b7] hover:text-[#144a75]">Retry</button>
            </div>
          )}

          {showDrafts && drafts.length === 0 && <p className="px-4 py-6 text-[13px] text-[#68737d]">No drafts. An email you start and leave unsent is kept here on this computer.</p>}
          {showDrafts && drafts.map((d) => {
            const t = byLead.get(d.leadId)
            return (
              <button key={d.leadId} type="button" onClick={() => openThread(d.leadId, true)}
                className={`w-full text-left px-4 py-3 border-b border-[#e9ebed] transition-colors ${open?.leadId === d.leadId ? 'bg-[#edf7ff]' : 'hover:bg-white'}`}>
                <span className="flex items-baseline gap-2">
                  <Chip tone="amber">Draft</Chip>
                  <span className="truncate text-[13px] text-[#2f3941]">{t ? (t.from || 'No name') : 'Unsent email'}</span>
                </span>
                <span className="mt-1 block truncate text-[13px] text-[#2f3941]">{d.subject || '(no subject)'}</span>
                <span className="block truncate text-[12px] text-[#68737d]">{d.body || 'Nothing written yet'}</span>
                {t && <span className="mt-1 block truncate text-[11px] text-[#87929d]">{t.siteName}</span>}
              </button>
            )
          })}

          {showRows && q && list.length > 0 && (
            <p className="px-4 py-2 text-[12px] text-[#68737d] border-b border-[#e9ebed]">{list.length} result{list.length === 1 ? '' : 's'} for <span className="font-semibold text-[#2f3941]">“{q}”</span></p>
          )}
          {showRows && list.length === 0 && (
            <div className="px-5 py-8 text-[13px] text-[#68737d]">
              {q ? (
                <>
                  <p className="font-medium text-[#2f3941]">No mail matches “{q}”.</p>
                  <p className="mt-1.5 text-[12px] leading-5">The inbox holds mail sent or received through ZeeDesk. A customer who was answered straight from Gmail has no conversation here, although their lead can still exist.</p>
                </>
              ) : folder === 'sent' ? 'Nothing sent yet.' : folder === 'unread' ? 'Nothing unread. New replies from customers show up here.' : 'No email conversations yet. A conversation starts when you email a lead.'}
            </div>
          )}
          {showRows && list.map((t) => {
            const unread = t.unread > 0
            const isOpen = open?.leadId === t.leadId
            const when = !q && folder === 'sent' ? t.lastOutAt : t.at
            const who = t.participants.length ? t.participants.join(', ') : (t.from || 'No sender')
            return (
              <button key={t.leadId} type="button" onClick={() => openThread(t.leadId)} aria-current={isOpen ? 'true' : undefined}
                className={`w-full text-left px-4 py-3 border-b border-[#e9ebed] transition-colors ${isOpen ? 'bg-[#edf7ff]' : unread ? 'bg-white hover:bg-[#f3f9ff]' : 'hover:bg-white'}`}>
                <span className="flex items-baseline gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 self-center ${unread ? 'bg-[#1f73b7]' : 'bg-transparent'}`} aria-hidden />
                  <span className={`truncate text-[13px] ${unread ? 'font-semibold text-[#2f3941]' : 'text-[#2f3941]'}`} title={who}>{who}</span>
                  {t.messages > 1 && <span className="shrink-0 text-[11px] text-[#87929d] tabular-nums" aria-label={`${t.messages} messages`}>{t.messages}</span>}
                  <span className={`ml-auto shrink-0 text-[11px] tabular-nums ${unread ? 'font-semibold text-[#2f3941]' : 'text-[#87929d]'}`} title={when ? formatDateTime(when) : undefined}>{listDate(when)}</span>
                </span>
                <span className={`mt-0.5 block truncate pl-4 text-[13px] ${unread ? 'font-semibold text-[#2f3941]' : 'text-[#2f3941]'}`}>{highlight(t.subject || '(no subject)', q)}</span>
                {t.snippet && <span className="block truncate pl-4 text-[12px] text-[#68737d]">{t.direction === 'out' && !q ? 'You: ' : ''}{highlight(t.snippet, q)}</span>}
                <span className="mt-1 pl-4 flex items-center gap-1.5 text-[11px] text-[#87929d]">
                  <span className="truncate">{t.siteName}</span>
                  {unread && <span className="shrink-0 px-1.5 rounded bg-[#dceefb] text-[#144a75] font-medium">{t.unread} unread</span>}
                  {t.lastOutOpened && <span className="shrink-0 px-1.5 rounded bg-[#edf8f4] text-[#038153]" title="The customer opened our latest email">Opened</span>}
                  {t.owner && <span className="shrink-0 px-1.5 rounded bg-[#e9ebed] text-[#49545c]">{t.owner.toLowerCase() === me.email.toLowerCase() ? 'You' : short(t.owner)}</span>}
                </span>
                {t.files.length > 0 && (
                  <span className="mt-1.5 pl-4 flex items-center gap-1.5 flex-wrap">
                    {t.files.slice(0, 2).map((f, i) => (
                      <span key={i} className="inline-flex items-center gap-1 max-w-[130px] px-1.5 py-0.5 rounded border border-[#d8dcde] bg-white text-[11px] text-[#49545c]">
                        <FileIcon mime={f.mime} size={11} /><span className="truncate">{f.name}</span>
                      </span>
                    ))}
                    {t.files.length > 2 && <span className="text-[11px] text-[#68737d]">+{t.files.length - 2} more</span>}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </aside>

      {/* ── Conversation ── */}
      {open ? (
        <ThreadPane key={open.leadId} leadId={open.leadId} thread={byLead.get(open.leadId) ?? null} composeNew={open.compose}
          gmail={gmail} gmailFailed={gmailFailed} ensureGmail={ensureGmail} reloadGmail={loadGmail} connectHref={connectHref}
          showInfo={showInfo} setShowInfo={setShowInfo} openLead={openLead}
          onChanged={load} onRead={markReadLocally} onDraftChange={refreshDrafts} onClose={() => setOpen(null)} />
      ) : (
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center text-center px-6">
          <div className="w-14 h-14 rounded-full bg-[#e9f4f3] flex items-center justify-center mb-4"><Mail size={24} color="#17494d" aria-hidden /></div>
          <p className="text-[16px] font-semibold">Pick a conversation to read it</p>
          <p className="mt-1 text-[13px] text-[#68737d] max-w-sm">Each row on the left is every email with one customer, newest first. Opening one marks its replies as read.</p>
        </main>
      )}
    </>
  )
}

// ── Gmail connection, said once above the list ──────────────────────────────

function GmailBanner({ gmail, failed, returned, connectHref, onRetry, onDismiss }: {
  gmail: GmailStatus | null; failed: boolean; returned: Flash | null; connectHref: string; onRetry: () => void; onDismiss: () => void
}) {
  const rows: ReactNode[] = []
  if (returned) {
    rows.push(
      <div key="returned" className="flex items-start gap-2">
        <Notice text={returned.text} bad={returned.bad} />
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-auto shrink-0 w-5 h-5 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed]"><X size={12} aria-hidden /></button>
      </div>,
    )
  }
  if (failed && !gmail) {
    rows.push(
      <div key="failed" className="flex items-center gap-2">
        <Notice bad text="Your Gmail connection could not be checked." />
        <button type="button" onClick={onRetry} className="ml-auto shrink-0 text-[12px] font-medium text-[#1f73b7] hover:text-[#144a75]">Retry</button>
      </div>,
    )
  }
  if (gmail && gmail.available !== false) {
    if (gmail.configured === false) {
      rows.push(<GmailNote key="setup" title="Gmail is not set up on the server" text={gmail.reason ?? 'An admin needs to add the Google credentials before email can be sent.'} />)
    } else if (!gmail.connected) {
      rows.push(
        <GmailNote key="connect" title={gmail.needsReconnect ? 'Your Gmail connection needs renewing' : 'Connect Gmail to send email'}
          text={gmail.reason ?? 'Email goes out from your own Google account, so the customer sees a normal business email and their reply comes back here.'}
          action={<a href={connectHref} className={BTN_PRIMARY}><Link2 size={14} aria-hidden />{gmail.needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'}</a>} />,
      )
    } else {
      if (gmail.rateLimited) {
        rows.push(<GmailNote key="busy" title="Gmail is busy right now" text={gmail.reason ?? 'Your connection is fine. This passes in a few seconds.'}
          action={<button type="button" onClick={onRetry} className={BTN_PLAIN}><RefreshCw size={13} aria-hidden />Check again</button>} />)
      }
      if (gmail.canReadReplies === false) {
        rows.push(<GmailNote key="replies" title="Customer replies will not show up here"
          text={gmail.replyCaptureReason ?? 'This Gmail connection cannot read replies. Reconnect to switch that on. Sending keeps working either way.'}
          action={<a href={connectHref} className={BTN_PLAIN}><Link2 size={14} aria-hidden />Reconnect Gmail</a>} />)
      }
    }
  }
  if (rows.length === 0) return null
  return <div className="shrink-0 px-4 py-3 space-y-3 border-y border-[#d8dcde] bg-white">{rows}</div>
}

function GmailNote({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div role="status">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2f3941]"><TriangleAlert size={14} className="shrink-0 text-[#ad5918]" aria-hidden />{title}</p>
      <p className="mt-0.5 text-[12px] leading-5 text-[#68737d]">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

// ── One conversation ────────────────────────────────────────────────────────

function ThreadPane({ leadId, thread, composeNew, gmail, gmailFailed, ensureGmail, reloadGmail, connectHref, showInfo, setShowInfo, openLead, onChanged, onRead, onDraftChange, onClose }: {
  leadId: string
  /** The list's row for this lead, when the list has one (a draft may not). */
  thread: Thread | null
  composeNew: boolean
  gmail: GmailStatus | null
  gmailFailed: boolean
  ensureGmail: () => void
  reloadGmail: () => void
  connectHref: string
  showInfo: boolean
  setShowInfo: (next: boolean) => void
  openLead: (recordId: string) => void
  onChanged: () => void
  onRead: (leadId: string) => void
  onDraftChange: () => void
  onClose: () => void
}) {
  const [record, setRecord] = useState<LeadRecord | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [composing, setComposing] = useState(composeNew)
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null)
  const [composeKey, setComposeKey] = useState(0)
  const [flash, setFlash] = useState<Flash | null>(null)
  /** Replies that were unread when this conversation was opened: they keep their "New" label while it stays open. */
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())

  const marked = useRef<Set<string>>(new Set())
  const scroller = useRef<HTMLDivElement | null>(null)

  const loadRecord = useCallback(async () => {
    try {
      const r = await fetch(`/api/leads/${encodeURIComponent(leadId)}`)
      if (!r.ok) throw new Error('failed')
      const d = await r.json()
      setRecord(d.record as LeadRecord)
      setState('ok')
    } catch {
      // A refresh that fails leaves the conversation already on screen alone.
      setState((s) => (s === 'ok' ? 'ok' : 'error'))
    }
  }, [leadId])

  useEffect(() => {
    const t = setTimeout(loadRecord, 0)
    return () => clearTimeout(t)
  }, [loadRecord])

  // The list is polled once a minute. When it shows this conversation has
  // moved (a new reply, a send from elsewhere), read the record again.
  const moved = thread ? `${thread.messages}|${thread.at ?? ''}` : ''
  const lastMoved = useRef(moved)
  useEffect(() => {
    const before = lastMoved.current
    lastMoved.current = moved
    if (!moved || !before || moved === before) return
    const t = setTimeout(loadRecord, 0)
    return () => clearTimeout(t)
  }, [moved, loadRecord])

  // Opening a conversation reads it, exactly as opening the lead's record does.
  useEffect(() => {
    if (!record) return
    const ids = record.timeline
      .filter((e) => e.kind === 'email_in' && e.unread && e.inbound)
      .map((e) => e.inbound!.gmailId)
      .filter((id) => !marked.current.has(id))
    if (ids.length === 0) return
    for (const id of ids) marked.current.add(id)
    fetch(`/api/leads/${encodeURIComponent(record.id)}/email/read`, postJson({ gmailIds: ids }))
      .then((r) => {
        if (!r.ok) throw new Error('failed')
        setFresh((prev) => new Set([...prev, ...ids]))
        onRead(leadId)
        void loadRecord()
        onChanged()
      })
      .catch(() => {
        for (const id of ids) marked.current.delete(id)
        setFlash({ text: 'These replies could not be marked as read. They will still count as unread.', bad: true })
      })
  }, [record, leadId, loadRecord, onChanged, onRead])

  const events = useMemo(() => (record?.timeline ?? [])
    .filter((e) => (e.kind === 'email' && e.email) || (e.kind === 'email_in' && e.inbound))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()), [record])

  // Newest mail is at the bottom, next to the reply box.
  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [events.length, state])

  const latestInbound = [...events].reverse().find((e) => e.kind === 'email_in' && e.inbound)
  const latestSent = [...events].reverse().find((e) => e.kind === 'email' && e.email?.gmailId)

  const startReply = (ctx: ReplyTo | null) => {
    // Reply without choosing a message answers the latest thing the customer said.
    if (!ctx && latestInbound?.inbound) {
      const inb = latestInbound.inbound
      ctx = { replyToGmailId: inb.gmailId, to: inb.from, subject: reSubject(inb.subject) }
    }
    // No customer reply yet: a follow-up on our own last email, in the same Gmail thread.
    if (!ctx && latestSent?.email) {
      const out = latestSent.email
      ctx = { replyToGmailId: out.gmailId, to: out.to, subject: reSubject(out.subject) }
    }
    setReplyTo(ctx); setComposing(true); setComposeKey((k) => k + 1); setFlash(null)
  }
  const startNew = () => { setReplyTo(null); setComposing(true); setComposeKey((k) => k + 1); setFlash(null) }

  const retryFile = async (gmailId: string, name: string) => {
    const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email/attachment`, postJson({ gmailId, name }))
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || 'Could not fetch that file.')
    await loadRecord()
  }

  const subject = thread?.subject || events[events.length - 1]?.email?.subject || events[events.length - 1]?.inbound?.subject || '(no subject)'
  const customer = record ? (record.contact.name || record.contact.email || 'this customer') : (thread?.from || 'Customer')
  const sub = [thread?.participants.length ? thread.participants.join(', ') : '', record?.siteName ?? thread?.siteName ?? ''].filter(Boolean).join(' · ')

  return (
    <>
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="h-[60px] shrink-0 px-5 flex items-center gap-3 border-b border-[#d8dcde]">
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{subject}</h2>
            <p className="text-[12px] text-[#68737d] truncate">{sub || ' '}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => openLead(leadId)} className={BTN_PLAIN}><ExternalLink size={14} aria-hidden />Open the full record</button>
            <button type="button" onClick={() => setShowInfo(!showInfo)} aria-pressed={showInfo} title="Customer details" aria-label="Customer details"
              className={`hidden lg:flex w-8 h-8 rounded-md items-center justify-center border border-[#d8dcde] ${showInfo ? 'bg-[#edf7ff] text-[#1f73b7]' : 'hover:bg-[#f8f9f9]'}`}><UserRound size={16} aria-hidden /></button>
            <button type="button" onClick={onClose} title="Close this conversation" aria-label="Close this conversation"
              className="w-8 h-8 rounded-md flex items-center justify-center border border-[#d8dcde] hover:bg-[#f8f9f9]"><X size={16} aria-hidden /></button>
          </div>
        </header>

        <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-4 bg-[#f8f9f9] [scrollbar-width:thin]">
          {state === 'loading' && (
            <div className="space-y-3" role="status" aria-label="Loading the conversation">
              {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-28 rounded-lg bg-[#e9ebed] animate-pulse" />)}
            </div>
          )}
          {state === 'error' && (
            <div className="py-16 text-center">
              <p role="alert" className="text-[13px] font-medium text-[#2f3941]">This conversation could not be loaded.</p>
              <button type="button" onClick={() => { setState('loading'); void loadRecord() }} className={`${BTN_PLAIN} mt-3`}><RefreshCw size={13} aria-hidden />Try again</button>
            </div>
          )}
          {state === 'ok' && record && events.length === 0 && (
            <div className="py-16 text-center">
              <Mail size={24} className="mx-auto mb-2 text-[#87929d]" aria-hidden />
              <p className="text-[13px] text-[#68737d]">No email with {customer} yet. Write the first one below.</p>
            </div>
          )}
          {state === 'ok' && record && (
            <div className="space-y-3 max-w-[860px] mx-auto">
              {events.map((e) => (
                <MessageCard key={e.id} e={e} isNew={!!e.inbound && (!!e.unread || fresh.has(e.inbound.gmailId))}
                  onReply={startReply} onRetryFile={retryFile} />
              ))}
            </div>
          )}
        </div>

        {state === 'ok' && record && (
          composing ? (
            <Composer key={composeKey} record={record} replyTo={replyTo}
              gmail={gmail} gmailFailed={gmailFailed} ensureGmail={ensureGmail} reloadGmail={reloadGmail} connectHref={connectHref}
              onClose={() => { setComposing(false); setReplyTo(null); onDraftChange() }}
              onSent={(warning) => {
                setFlash(warning ? { text: warning, bad: true } : { text: 'Email sent.' })
                void loadRecord(); onChanged(); onDraftChange()
              }} />
          ) : (
            <footer className="shrink-0 border-t border-[#d8dcde] px-5 py-3 bg-white flex items-center gap-2 flex-wrap">
              <button type="button" onClick={() => startReply(null)} className={BTN_PRIMARY}><CornerUpLeft size={14} aria-hidden />Reply</button>
              <button type="button" onClick={startNew} className={BTN_PLAIN}><PenLine size={14} aria-hidden />New email</button>
              {flash && <Notice text={flash.text} bad={flash.bad} />}
            </footer>
          )
        )}
      </main>

      {showInfo && <CustomerPanel record={record} thread={thread} events={events} openLead={openLead} onHide={() => setShowInfo(false)} />}
    </>
  )
}

// ── One email in the conversation ───────────────────────────────────────────

const BODY_HTML = 'break-words leading-[1.55] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-[#1f73b7] [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[#d8dcde] [&_blockquote]:pl-3 [&_blockquote]:text-[#68737d]'

function MessageCard({ e, isNew, onReply, onRetryFile }: {
  e: TimelineEvent
  isNew: boolean
  onReply: (ctx: ReplyTo) => void
  onRetryFile: (gmailId: string, name: string) => Promise<void>
}) {
  const [full, setFull] = useState(false)
  const inb = e.kind === 'email_in' ? e.inbound : undefined
  const out = e.kind === 'email' ? e.email : undefined
  if (!inb && !out) return null
  const who = inb ? (inb.fromName || inb.from || 'Customer') : (e.actor || short(out!.sentBy) || 'Agent')
  const addr = inb ? inb.from : out!.from
  const subject = inb ? inb.subject : out!.subject
  const quoted = inb ? inb.quoted : out!.quoted
  return (
    <article className={`rounded-lg border bg-white px-4 py-3 ${inb && isNew ? 'border-[#1f73b7] shadow-[0_0_0_1px_#1f73b7]' : 'border-[#d8dcde]'}`}>
      <div className="flex items-start gap-3">
        <Avatar label={who} tone={inb ? 'visitor' : out!.bot ? 'bot' : 'agent'} size={34} />
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-[#2f3941]">{who}</span>
            {addr && addr !== who && <span className="text-[12px] text-[#68737d] break-all">&lt;{addr}&gt;</span>}
            {inb && isNew && <Chip tone="blue">New</Chip>}
            {out?.imported && <span title="Sent straight from Gmail and brought in afterwards, so it has no open tracking"><Chip>Sent from Gmail</Chip></span>}
            {out?.bot && <span title="Written and sent automatically, in this agent's name"><Chip>Sent automatically</Chip></span>}
          </p>
          <p className="text-[12px] text-[#68737d] break-words">
            {inb ? 'to us' : `to ${out!.to || 'the customer'}`}{(inb?.cc || out?.cc) ? ` · cc ${inb?.cc || out?.cc}` : ''}
          </p>
        </div>
        <time className="shrink-0 text-[12px] text-[#87929d] tabular-nums" dateTime={e.at}>{formatDateTime(e.at)}</time>
      </div>

      <div className="mt-3 pl-[46px] text-[14px] text-[#2f3941]">
        <p className="text-[13px] font-semibold break-words">{subject || '(no subject)'}</p>

        {/* Worded carefully: "not opened yet" means no signal, which a mail app that hides images also produces. */}
        {out && !out.imported && (
          <p className={`mt-0.5 text-[12px] ${out.openedAt ? 'font-medium text-[#038153]' : 'text-[#87929d]'}`}
            title={out.openedAt ? `First opened ${formatDateTime(out.openedAt)}${(out.opens ?? 0) > 1 ? `, opened ${out.opens} times` : ''}` : 'No open recorded yet. Some mail apps hide images, so this can stay blank even after it was read.'}>
            {out.openedAt ? `Opened ${timeAgo(out.openedAt)}${(out.opens ?? 0) > 1 ? ` · ${out.opens} times` : ''}` : 'Not opened yet'}
          </p>
        )}

        {inb && (
          // What the customer actually wrote is always shown in full. When there
          // is none (a file on its own) say so, rather than showing the quoted
          // history as though they had written it.
          inb.textless || !inb.body.trim()
            ? <p className="mt-2 italic text-[#68737d]">No message text. See the attachment below.</p>
            : <p className="mt-2 whitespace-pre-wrap break-words leading-[1.55]">{inb.body}</p>
        )}

        {out && (
          <>
            {full ? (
              // The formatted version when there is one, so this shows what the
              // customer received. It is sanitised when sent and again when the
              // record is read (lib/crmemail.ts), which is what makes it safe here.
              out.html
                ? <div className={`mt-2 ${BODY_HTML}`} dangerouslySetInnerHTML={{ __html: out.html }} />
                : <p className="mt-2 whitespace-pre-wrap break-words leading-[1.55]">{out.body}</p>
            ) : (
              <p className="mt-2 break-words leading-[1.55]">{out.snippet}</p>
            )}
            {out.body.trim() !== out.snippet && (
              <button type="button" onClick={() => setFull((v) => !v)} aria-expanded={full}
                className="mt-1.5 inline-flex items-center gap-0.5 text-[12px] font-medium text-[#1f73b7] hover:text-[#144a75]">
                {full ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{full ? 'Show less' : 'Show the full email'}
              </button>
            )}
          </>
        )}

        {quoted && <QuotedFold text={quoted} />}

        <Files files={e.files} skipped={inb?.skippedAttachments} gmailId={inb?.gmailId} onRetryFile={onRetryFile} />

        {inb && (
          <div className="mt-3">
            <button type="button" onClick={() => onReply({ replyToGmailId: inb.gmailId, to: inb.from, subject: reSubject(inb.subject) })}
              className={BTN_PLAIN}><CornerUpLeft size={14} aria-hidden />Reply to this</button>
          </div>
        )}
      </div>
    </article>
  )
}

/** The earlier messages quoted under an email, folded away and shown without the ">" gutters. */
function QuotedFold({ text }: { text: string }) {
  const [show, setShow] = useState(false)
  const clean = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setShow((v) => !v)} aria-expanded={show} title="The earlier messages quoted underneath this one"
        className="inline-flex items-center gap-0.5 text-[12px] font-medium text-[#68737d] hover:text-[#2f3941]">
        {show ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{show ? 'Hide quoted text' : 'Show quoted text'}
      </button>
      {show && <p className="mt-1 border-l-2 border-[#d8dcde] pl-3 text-[13px] text-[#68737d] whitespace-pre-wrap break-words leading-[1.5]">{clean}</p>}
    </div>
  )
}

/** Files carried by an email, either way. The links are signed and expire, so they are minted each time the record is read. */
function Files({ files, skipped, gmailId, onRetryFile }: {
  files?: TimelineEvent['files']
  skipped?: { name: string; why: string }[]
  gmailId?: string
  onRetryFile: (gmailId: string, name: string) => Promise<void>
}) {
  if (!files?.length && !skipped?.length) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {(files ?? []).map((f) => (
        f.url && f.mime.startsWith('image/') && !f.mime.includes('svg') ? (
          <a key={f.name + f.size} href={f.url} target="_blank" rel="noopener noreferrer" title={`${f.name} · ${humanSize(f.size)}`}
            className="block rounded-md border border-[#d8dcde] bg-white overflow-hidden hover:border-[#1f73b7] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={f.url} alt={f.name} loading="lazy" className="h-28 max-w-[220px] object-cover" />
            <span className="block px-2 py-1 text-[11px] text-[#49545c] truncate max-w-[220px]">{f.name} <span className="text-[#87929d] tabular-nums">{humanSize(f.size)}</span></span>
          </a>
        ) : f.url ? (
          <a key={f.name + f.size} href={f.url} target="_blank" rel="noopener noreferrer" title={`${f.name} · ${humanSize(f.size)}`}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[#d8dcde] bg-white text-[12px] text-[#2f3941] hover:bg-[#f8f9f9] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
            <FileIcon mime={f.mime} size={13} /><span className="truncate max-w-[200px]">{f.name}</span><span className="text-[#87929d] tabular-nums">{humanSize(f.size)}</span>
          </a>
        ) : (
          <span key={f.name + f.size} title="This link has expired. Open the conversation again to renew it."
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-[#e9ebed] bg-[#f8f9f9] text-[12px] text-[#87929d]">
            <FileIcon mime={f.mime} size={13} /><span className="truncate max-w-[200px]">{f.name}</span><span className="tabular-nums">{humanSize(f.size)}</span>
          </span>
        )
      ))}
      {(skipped ?? []).map((sk) => <SkippedFile key={sk.name} skip={sk} gmailId={gmailId} onRetry={onRetryFile} />)}
    </div>
  )
}

/** A file that was not saved. The reason is on the chip, with a retry when the refusal may no longer hold. */
function SkippedFile({ skip, gmailId, onRetry }: {
  skip: { name: string; why: string }
  gmailId?: string
  onRetry: (gmailId: string, name: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const canRetry = !!gmailId && isRetryableSkip(skip.why)
  return (
    <span className="inline-flex items-center gap-1.5 min-h-8 px-2.5 py-1 rounded-md border border-[#f0c48a] bg-[#fff3e4] text-[12px] text-[#ad5918] flex-wrap" role={failed ? 'alert' : undefined}>
      <TriangleAlert size={13} className="shrink-0" aria-hidden />
      <span className="font-medium truncate max-w-[180px]">{skip.name}</span>
      <span>not saved: {failed || skip.why}</span>
      {canRetry && (
        <button type="button" disabled={busy}
          onClick={async () => {
            setBusy(true); setFailed('')
            try { await onRetry(gmailId!, skip.name) } catch (err) { setFailed(err instanceof Error ? err.message : 'The retry failed.') } finally { setBusy(false) }
          }}
          className="inline-flex items-center gap-1 font-semibold underline underline-offset-2 disabled:opacity-50">
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}Retry
        </button>
      )}
    </span>
  )
}

// ── The reply box ───────────────────────────────────────────────────────────

function Composer({ record, replyTo, gmail, gmailFailed, ensureGmail, reloadGmail, connectHref, onClose, onSent }: {
  record: LeadRecord
  replyTo: ReplyTo | null
  gmail: GmailStatus | null
  gmailFailed: boolean
  ensureGmail: () => void
  reloadGmail: () => void
  connectHref: string
  onClose: () => void
  /** `warning` is set when the email left but could not be written to the record. */
  onSent: (warning?: string) => void
}) {
  const leadId = record.id
  const draftKey = `${DRAFT_PREFIX}${leadId}`
  // This viewer may not read the customer's address: the To box shows the
  // masked value, the server addresses the email itself, and there is no Cc.
  const contactsHidden = !!record.contactsHidden
  // This viewer's email can only go to the lead; the server would replace anything typed.
  const recipientLocked = !!record.recipientLocked
  const isReply = !!replyTo

  const [draft, setDraft] = useState<Draft>({ from: '', to: replyTo?.to || record.contact.email, cc: '', subject: replyTo?.subject ?? '', body: '', html: '' })
  const [showCc, setShowCc] = useState(false)
  const [files, setFiles] = useState<Attached[]>([])
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [needsReconnect, setNeedsReconnect] = useState(false)
  const [retryable, setRetryable] = useState(false)
  const [sigWho, setSigWho] = useState('')
  const [sigHtml, setSigHtml] = useState('')

  const fileInput = useRef<HTMLInputElement | null>(null)
  const fileCount = useRef(0)

  // The connection is asked about afresh when the box opens: an address
  // removed in Google must be gone from the From list straight away.
  useEffect(() => { const t = setTimeout(ensureGmail, 0); return () => clearTimeout(t) }, [ensureGmail])

  // Bring back a half-written email. On a reply the recipient and the subject
  // are decided by the message being answered, so only the text is restored.
  useEffect(() => {
    let alive = true
    queueMicrotask(() => {
      if (!alive) return
      try {
        const raw = localStorage.getItem(draftKey)
        if (!raw) return
        const d = JSON.parse(raw)
        setDraft((cur) => ({
          from: typeof d.from === 'string' ? d.from : cur.from,
          to: isReply ? cur.to : (typeof d.to === 'string' && d.to ? d.to : cur.to),
          cc: typeof d.cc === 'string' ? d.cc : '',
          subject: isReply ? cur.subject : (typeof d.subject === 'string' ? d.subject : ''),
          body: typeof d.body === 'string' ? d.body : '',
          html: typeof d.html === 'string' ? d.html : (typeof d.body === 'string' ? plainToHtml(d.body) : ''),
        }))
        if (typeof d.cc === 'string' && d.cc.trim()) setShowCc(true)
      } catch { /* a malformed draft: start fresh */ }
    })
    return () => { alive = false }
  }, [draftKey, isReply])

  const aliases = useMemo(() => gmail?.aliases ?? [], [gmail])
  // The address that belongs to this lead's site goes first and is labelled;
  // every other verified address stays available.
  const siteAlias = useMemo(() => (aliases.length ? matchSiteAlias(aliases, record.siteId, record.siteName) : null), [aliases, record.siteId, record.siteName])
  const orderedAliases = useMemo(() => (siteAlias ? [siteAlias, ...aliases.filter((a) => a.email !== siteAlias.email)] : aliases), [aliases, siteAlias])
  const fallbackFrom = (siteAlias ?? aliases.find((a) => a.isDefault) ?? aliases.find((a) => a.isPrimary) ?? aliases[0])?.email ?? ''
  // A remembered From is only used while Google still lists it.
  const from = draft.from && aliases.some((a) => a.email === draft.from) ? draft.from : fallbackFrom

  // The signature is added by the send route, not typed here. This only fetches what will be added, to show it.
  useEffect(() => {
    if (!from) return
    let alive = true
    fetch(`/api/signature?siteId=${encodeURIComponent(record.siteId)}&from=${encodeURIComponent(from)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive) return
        setSigWho([d?.agent?.name, d?.agent?.title].filter(Boolean).join(' · '))
        setSigHtml(typeof d?.signatureHtml === 'string' ? d.signatureHtml : '')
      })
      .catch(() => { /* the preview is a courtesy; the send adds the signature either way */ })
    return () => { alive = false }
  }, [record.siteId, from])

  const set = (patch: Partial<Draft>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    try { localStorage.setItem(draftKey, JSON.stringify(next)) } catch { /* storage full or blocked */ }
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0)

  // A file goes straight from the browser to storage on a one-time signed
  // link; only its path is sent with the email.
  const addFiles = async (picked: File[]) => {
    setError('')
    for (const file of picked) {
      if (fileCount.current >= MAX_EMAIL_ATTACHMENTS) { setError(`You can attach up to ${MAX_EMAIL_ATTACHMENTS} files.`); break }
      if (file.size > MAX_EMAIL_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is ${humanSize(file.size)}. The limit is ${humanSize(MAX_EMAIL_ATTACHMENT_BYTES)} per file, so send a download link instead.`)
        continue
      }
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 7)}`
      const mime = file.type || 'application/octet-stream'
      fileCount.current++
      setFiles((cur) => [...cur, { key, name: file.name, size: file.size, mime, path: null, progress: true }])
      try {
        const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email/upload`, postJson({ name: file.name, mime: file.type, size: file.size }))
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j.error || 'The upload was refused.')
        const put = await fetch(j.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': mime } })
        if (!put.ok) throw new Error('The upload failed.')
        setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, path: j.path, progress: false } : f)))
      } catch (e) {
        fileCount.current--
        setFiles((cur) => cur.filter((f) => f.key !== key))
        setError(e instanceof Error ? e.message : 'That file could not be attached.')
      }
    }
  }
  const removeFile = (key: string) => { fileCount.current = Math.max(0, fileCount.current - 1); setFiles((cur) => cur.filter((f) => f.key !== key)) }

  const missing: string[] = []
  if (!from) missing.push('a From address')
  if (!draft.to.trim()) missing.push('a recipient')
  if (!draft.subject.trim()) missing.push('a subject')
  if (!draft.body.trim()) missing.push('a message')
  if (files.some((f) => f.progress)) missing.push('the uploads to finish')
  if (totalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL) missing.push('smaller attachments')
  const canSend = missing.length === 0 && !sending

  async function send() {
    if (!canSend) return
    setError(''); setRetryable(false); setSending(true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email`, postJson({
        ...draft, from,
        replyToGmailId: replyTo?.replyToGmailId,
        attachments: files.filter((f) => f.path).map((f) => ({ path: f.path, name: f.name, mime: f.mime, size: f.size })),
      }))
      const j = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (j.needsReconnect) { setNeedsReconnect(true); reloadGmail() }
        if (j.retryable) setRetryable(true)
        throw new Error(j.error || 'The email could not be sent.')
      }
      // Only now is the draft safe to discard.
      try { localStorage.removeItem(draftKey) } catch { /* ignore */ }
      onSent(j.recorded === false ? (j.warning || 'The email was sent, but it could not be added to this conversation.') : undefined)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The email could not be sent.')
    } finally {
      setSending(false)
    }
  }

  const customer = record.contact.name || record.contact.email || 'this customer'
  const head = (
    <div className="flex items-center gap-2">
      {replyTo ? <CornerUpLeft size={15} className="text-[#68737d]" aria-hidden /> : <PenLine size={15} className="text-[#68737d]" aria-hidden />}
      <h3 className="text-[13px] font-semibold truncate">{replyTo ? 'Reply' : 'New email'} <span className="font-normal text-[#68737d]">to {customer}</span></h3>
      <button type="button" onClick={onClose} disabled={sending} title="Close. What you wrote is kept as a draft." aria-label="Close the reply box"
        className="ml-auto w-7 h-7 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed] disabled:opacity-40"><X size={15} aria-hidden /></button>
    </div>
  )
  const shell = 'shrink-0 border-t border-[#d8dcde] bg-white px-5 py-3 max-h-[64vh] overflow-y-auto [scrollbar-width:thin]'

  if (!gmail) {
    return (
      <section className={shell} aria-label="Write an email">
        {head}
        {gmailFailed ? (
          <div className="mt-2 flex items-center gap-2">
            <Notice bad text="Your Gmail connection could not be checked." />
            <button type="button" onClick={reloadGmail} className={BTN_PLAIN}><RefreshCw size={13} aria-hidden />Try again</button>
          </div>
        ) : <p role="status" className="mt-2 text-[13px] text-[#68737d]">Checking your Gmail connection…</p>}
      </section>
    )
  }
  if (gmail.available === false || gmail.configured === false || !gmail.connected) {
    const reconnect = !!gmail.needsReconnect || needsReconnect
    return (
      <section className={shell} aria-label="Write an email">
        {head}
        {gmail.available === false ? (
          <p className="mt-2 text-[13px] text-[#68737d]">Email is not enabled for this workspace.</p>
        ) : gmail.configured === false ? (
          <GmailNoteInline title="Gmail is not set up on the server" text={gmail.reason ?? 'An admin needs to add the Google credentials before email can be sent.'} />
        ) : (
          <GmailNoteInline title={reconnect ? 'Your Gmail connection needs renewing' : 'Connect Gmail to send email'}
            text={gmail.reason ?? 'Email goes out from your own Google account, so the customer sees a normal business email and their reply comes back here.'}
            action={<a href={connectHref} className={BTN_PRIMARY}><Link2 size={14} aria-hidden />{reconnect ? 'Reconnect Gmail' : 'Connect Gmail'}</a>} />
        )}
      </section>
    )
  }

  const ROW = 'flex items-center gap-2 px-3 min-h-9 border-b border-[#e9ebed]'
  const ROW_LABEL = 'w-14 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[#68737d]'
  const FIELD = 'flex-1 min-w-0 bg-transparent outline-none text-[13px] text-[#2f3941] placeholder:text-[#87929d]'

  return (
    <section className={shell} aria-label={replyTo ? 'Reply by email' : 'Write a new email'}
      onKeyDown={(e) => {
        // Ctrl or Cmd with Enter sends from anywhere in the box; Esc closes it and the draft stays saved.
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() }
        if (e.key === 'Escape' && !sending) { e.preventDefault(); onClose() }
      }}>
      {head}

      {gmail.rateLimited && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Notice bad text={`Gmail is busy right now, so your From addresses could not be listed. ${gmail.reason ?? 'Your connection is fine and this passes in a few seconds.'}`} />
          <button type="button" onClick={reloadGmail} className={BTN_PLAIN}><RefreshCw size={13} aria-hidden />Check again</button>
        </div>
      )}
      {gmail.canReadReplies === false && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Notice bad text={`Replies to this email will not show up here. ${gmail.replyCaptureReason ?? 'This Gmail connection cannot read replies.'}`} />
          <a href={connectHref} className={BTN_PLAIN}><Link2 size={14} aria-hidden />Reconnect Gmail</a>
        </div>
      )}

      <div className={`mt-2 rounded-md border bg-white ${dragging ? 'border-[#1f73b7] bg-[#edf7ff]' : 'border-[#d8dcde] focus-within:border-[#1f73b7]'}`}>
        <label className={ROW}>
          <span className={ROW_LABEL}>From</span>
          <select value={from} onChange={(e) => set({ from: e.target.value })} aria-label="Send from" className={`${FIELD} cursor-pointer`}>
            {orderedAliases.length === 0 && <option value="">No address available</option>}
            {orderedAliases.map((a) => (
              <option key={a.email} value={a.email}>
                {(a.displayName ? `${a.displayName} <${a.email}>` : a.email) + (a.email === siteAlias?.email ? ' (this lead’s site)' : '')}
              </option>
            ))}
          </select>
        </label>
        <div className={ROW}>
          <label className="flex items-center gap-2 flex-1 min-w-0">
            <span className={ROW_LABEL}>To</span>
            <input value={draft.to} onChange={(e) => set({ to: e.target.value })} aria-label="To" readOnly={contactsHidden || recipientLocked}
              title={contactsHidden ? 'This customer’s address is hidden. The email still goes to them.' : recipientLocked ? 'Email from here goes to this lead. To email anyone else, ask an admin.' : undefined}
              className={`${FIELD} ${contactsHidden || recipientLocked ? 'text-[#68737d]' : ''}`} />
          </label>
          {!showCc && !contactsHidden && <button type="button" onClick={() => setShowCc(true)} className="shrink-0 text-[12px] font-medium text-[#1f73b7] hover:text-[#144a75]">Add Cc</button>}
        </div>
        {showCc && !contactsHidden && (
          <label className={ROW}>
            <span className={ROW_LABEL}>Cc</span>
            <input autoFocus value={draft.cc} onChange={(e) => set({ cc: e.target.value })} aria-label="Cc" placeholder="name@example.com" className={FIELD} />
          </label>
        )}
        <label className={ROW}>
          <span className={ROW_LABEL}>Subject</span>
          <input value={draft.subject} onChange={(e) => set({ subject: e.target.value })} aria-label="Subject" required aria-required="true"
            placeholder="What is this about?" className={`${FIELD} font-semibold placeholder:font-normal`} />
        </label>

        <RichEditor html={draft.html} onChange={(html, text) => set({ html, body: text })} onDropFiles={(f) => void addFiles(f)} onDragStateChange={setDragging} />

        {files.length > 0 && (
          <ul className="border-t border-[#e9ebed] px-3 py-2 space-y-1" aria-label="Attached files">
            {files.map((f) => (
              <li key={f.key} className="flex items-center gap-2 text-[12px]">
                {f.progress ? <Loader2 size={13} className="shrink-0 animate-spin text-[#68737d]" aria-label="Uploading" /> : <FileIcon mime={f.mime} size={13} />}
                <span className="truncate font-medium text-[#2f3941]">{f.name}</span>
                <span className="shrink-0 text-[#87929d] tabular-nums">{humanSize(f.size)}</span>
                <button type="button" onClick={() => removeFile(f.key)} aria-label={`Remove ${f.name}`} className="ml-auto shrink-0 w-6 h-6 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed] hover:text-[#cc3340]"><X size={13} aria-hidden /></button>
              </li>
            ))}
            <li className={`text-[11px] tabular-nums ${totalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL ? 'text-[#cc3340]' : 'text-[#87929d]'}`}>{humanSize(totalBytes)} of {humanSize(MAX_EMAIL_ATTACHMENTS_TOTAL)}</li>
          </ul>
        )}

        {/* The signature is shown, not edited: the send route adds it from stored details. */}
        {sigHtml && (
          <details className="border-t border-[#e9ebed] px-3 py-2">
            <summary className="cursor-pointer text-[12px] text-[#68737d]">Signature, added when this is sent{sigWho ? `: ${sigWho}` : ''}</summary>
            <div className="mt-2 pointer-events-none select-none overflow-x-auto" aria-label="Your signature" dangerouslySetInnerHTML={{ __html: sigHtml }} />
          </details>
        )}
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Notice bad text={error} />
          {retryable && <button type="button" onClick={() => void send()} disabled={sending} className={BTN_PLAIN}><RefreshCw size={13} aria-hidden />Try again</button>}
          {needsReconnect && !retryable && <a href={connectHref} className={BTN_PLAIN}><Link2 size={14} aria-hidden />Reconnect Gmail</a>}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => void send()} disabled={!canSend} title={canSend ? 'Send (Ctrl or Cmd + Enter)' : `Still needs ${missing.join(', ')}`} className={BTN_PRIMARY}>
          {sending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}{sending ? 'Sending…' : 'Send'}
        </button>
        <input ref={fileInput} type="file" multiple className="hidden" aria-hidden tabIndex={-1}
          onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={sending}
          title={`Attach a file, up to ${humanSize(MAX_EMAIL_ATTACHMENT_BYTES)} each, or drop one on the message`} className={BTN_PLAIN}><Paperclip size={14} aria-hidden />Attach</button>
        {missing.length > 0 && !sending && <span className="text-[12px] text-[#ad5918]">Needs {missing.join(', ')}</span>}
        <span className="ml-auto text-[11px] text-[#87929d]">{!sigHtml && !sigWho ? 'No signature set up yet · ' : ''}Ctrl or Cmd + Enter sends · Draft saved</span>
      </div>
    </section>
  )
}

function GmailNoteInline({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="mt-2" role="status">
      <p className="text-[13px] font-semibold text-[#2f3941]">{title}</p>
      <p className="mt-0.5 text-[12px] leading-5 text-[#68737d] max-w-xl">{text}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

// ── The customer ────────────────────────────────────────────────────────────

function CustomerPanel({ record, thread, events, openLead, onHide }: {
  record: LeadRecord | null
  thread: Thread | null
  events: TimelineEvent[]
  openLead: (recordId: string) => void
  onHide: () => void
}) {
  const files = events.flatMap((e) => (e.files ?? []).map((f) => ({ ...f, at: e.at })))
  const inbound = events.filter((e) => e.kind === 'email_in').length
  return (
    <aside className="hidden lg:flex w-[300px] shrink-0 border-l border-[#d8dcde] flex-col bg-[#f8f9f9] overflow-y-auto [scrollbar-width:thin]" aria-label="Customer">
      <div className="h-[60px] shrink-0 px-4 flex items-center border-b border-[#d8dcde]">
        <p className="font-semibold">Customer</p>
        <button type="button" onClick={onHide} className="ml-auto w-7 h-7 rounded flex items-center justify-center hover:bg-[#e9ebed]" aria-label="Hide customer details"><X size={15} aria-hidden /></button>
      </div>
      {!record ? (
        <p className="p-4 text-[13px] text-[#68737d]">{thread?.from || 'Loading the customer…'}</p>
      ) : (
        <div className="p-4 space-y-5">
          <section>
            <div className="flex items-center gap-3">
              <Avatar label={record.contact.name || record.contact.email || 'Customer'} size={40} />
              <div className="min-w-0">
                <p className="text-[15px] font-semibold truncate">{record.contact.name || 'No name given'}</p>
                <p className="text-[12px] text-[#68737d] truncate">{record.sourceLabel}</p>
              </div>
            </div>
            <dl className="mt-3 space-y-1.5 text-[13px]">
              <Fact label="Email" value={record.contact.email || 'Not given'} />
              <Fact label="Phone" value={record.contact.phone || 'Not given'} />
              <Fact label="Site" value={record.siteName} />
              <Fact label="Stage" value={String(record.stage).replace(/_/g, ' ')} capitalize />
              <Fact label="Owner" value={short(record.owner) || 'Unassigned'} />
              {record.country && <Fact label="Country" value={record.country} />}
            </dl>
            {record.contactsHidden && <p className="mt-2 text-[12px] text-[#68737d]">Contact details are hidden for your account. Email you send still reaches this customer.</p>}
            <button type="button" onClick={() => openLead(record.id)} className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-[#1f73b7] hover:text-[#144a75]">Open the full record <ChevronRight size={14} aria-hidden /></button>
          </section>

          <section>
            <h3 className={LABEL}>This conversation</h3>
            <dl className="space-y-1.5 text-[13px]">
              <Fact label="Emails" value={`${events.length} in total, ${inbound} from the customer`} />
              <Fact label="Last reply" value={record.lastReplyAt ? formatDateTime(record.lastReplyAt) : 'No reply yet'} />
              <Fact label="Last sent" value={thread?.lastOutAt ? formatDateTime(thread.lastOutAt) : 'Nothing sent yet'} />
              {thread?.lastOutAt && <Fact label="Opened" value={thread.lastOutOpened ? 'Yes, our latest email' : 'Not recorded yet'} />}
            </dl>
          </section>

          {files.length > 0 && (
            <section>
              <h3 className={LABEL}>Files</h3>
              <ul className="space-y-1.5 text-[13px]">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 min-w-0">
                    <FileIcon mime={f.mime} size={13} />
                    {f.url
                      ? <a href={f.url} target="_blank" rel="noopener noreferrer" className="truncate text-[#1f73b7] hover:text-[#144a75]" title={`${f.name} · ${formatDateTime(f.at)}`}>{f.name}</a>
                      : <span className="truncate text-[#87929d]" title="This link has expired. Open the conversation again to renew it.">{f.name}</span>}
                    <span className="ml-auto shrink-0 text-[11px] text-[#87929d] tabular-nums">{humanSize(f.size)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </aside>
  )
}

function Fact({ label, value, capitalize }: { label: string; value: string; capitalize?: boolean }) {
  return <div className="flex gap-2"><dt className="w-[68px] shrink-0 text-[#68737d]">{label}</dt><dd className={`min-w-0 break-words ${capitalize ? 'capitalize' : ''}`}>{value}</dd></div>
}

// ── WhatsApp ────────────────────────────────────────────────────────────────
//
// The second channel of the same inbox. The list is /api/inbox/whatsapp, a
// conversation is the lead's own record (its wa_in / wa_out events), and a
// reply goes through that record's WhatsApp route. The server picks the
// recipient and the line; this screen never sends a number.

/** One row of GET /api/inbox/whatsapp. `unanswered` counts the customer's messages since our last reply. */
interface WaThread {
  leadId: string; siteId: string; siteName: string
  name: string; phone: string; body: string
  at: string | null; direction: 'in' | 'out'
  messages: number; unanswered: number; hasMedia: boolean
  agents: string[]; lastOutAt: string | null; failed: boolean; owner: string | null
}

type Channel = 'email' | 'whatsapp'
type ListStatus = 'loading' | 'ok' | 'unavailable' | 'error'

const DAY_MS = 24 * 60 * 60 * 1000
const soundOn = () => { try { return localStorage.getItem('zd-sound') !== 'off' } catch { return true } }
const waName = (t: WaThread) => t.name || t.phone || 'No name'

/** Why WhatsApp did not deliver one of our messages, in words for a team that has no templates. */
function waFailureHint(code: number | undefined): string {
  if (code === 63016 || code === 63024 || code === 131047) {
    return 'WhatsApp only delivers a free reply within 24 hours of the customer’s last message, so this one did not arrive. Wait for them to write again, or email them.'
  }
  if (code === 63015) return 'That number has not joined the WhatsApp test line, so the message was not delivered.'
  return waErrorHint(code) || 'WhatsApp could not deliver this message.'
}

export default function InboxScreen({ me, openLead }: ZdScreenProps) {
  const ws = me.workspace as Parameters<typeof hasFeature>[0]
  const emailOn = hasFeature(ws, 'email')
  const waOn = hasFeature(ws, 'whatsapp')

  const [channel, setChannel] = useState<Channel>(emailOn || !waOn ? 'email' : 'whatsapp')
  /** A lead to open in the mail view with a new email started: "Email instead" from a WhatsApp conversation. */
  const [mailStart, setMailStart] = useState<string | null>(null)
  const [waThreads, setWaThreads] = useState<WaThread[] | null>(null)
  const [waStatus, setWaStatus] = useState<ListStatus>('loading')
  const [waStale, setWaStale] = useState(false)

  const lastIn = useRef<Record<string, string>>({})
  const seeded = useRef(false)

  const loadWa = useCallback(async () => {
    try {
      const r = await fetch('/api/inbox/whatsapp')
      if (r.status === 403) { setWaStatus('unavailable'); return }
      if (!r.ok) throw new Error('failed')
      const d = await r.json()
      const list: WaThread[] = d.threads ?? []
      // A conversation whose newest message is the customer's, at a time not
      // seen before, is a new message. Arriving to ones already waiting is not.
      let fresh = false
      const next: Record<string, string> = {}
      for (const t of list) {
        if (t.direction !== 'in' || !t.at) continue
        next[t.leadId] = t.at
        if (seeded.current && lastIn.current[t.leadId] !== t.at) fresh = true
      }
      lastIn.current = next
      if (fresh && soundOn()) chatDing()
      seeded.current = true
      setWaThreads(list)
      setWaStatus('ok')
      setWaStale(false)
    } catch {
      setWaStatus((s) => (s === 'ok' ? 'ok' : 'error'))
      setWaStale(true)
    }
  }, [])

  // The WhatsApp list is read once a minute for as long as the inbox is open,
  // whichever channel is showing: it feeds the count on the switch and the sound.
  useEffect(() => {
    if (!waOn) return
    const first = setTimeout(loadWa, 0)
    const iv = setInterval(loadWa, POLL_MS)
    return () => { clearTimeout(first); clearInterval(iv) }
  }, [waOn, loadWa])

  const waiting = (waThreads ?? []).filter((t) => t.unanswered > 0).length
  const tab = (key: Channel, label: string, icon: ReactNode, count?: number) => (
    <button type="button" role="tab" aria-selected={channel === key}
      onClick={() => { setChannel(key); if (key === 'email') setMailStart(null) }}
      className={`flex-1 h-8 rounded text-[13px] font-medium inline-flex items-center justify-center gap-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${channel === key ? 'bg-[#1f73b7] text-white' : 'text-[#49545c] hover:bg-[#e9ebed]'}`}>
      {icon}{label}
      {!!count && <span className={`min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold leading-[18px] tabular-nums ${channel === key ? 'bg-white text-[#1f73b7]' : 'bg-[#e34f32] text-white'}`} aria-label={`${count} waiting on a reply`}>{count > 99 ? '99+' : count}</span>}
    </button>
  )
  const channelSwitch = emailOn && waOn ? (
    <div className="mb-3 flex gap-0.5 p-0.5 rounded-md border border-[#d8dcde] bg-white" role="tablist" aria-label="Channel">
      {tab('email', 'Email', <Mail size={14} aria-hidden />)}
      {tab('whatsapp', 'WhatsApp', <MessageCircle size={14} aria-hidden />, waiting)}
    </div>
  ) : null

  if (waOn && channel === 'whatsapp') {
    return (
      <WhatsAppInbox me={me} openLead={openLead} channelSwitch={channelSwitch}
        threads={waThreads ?? []} status={waStatus} stale={waStale} reload={loadWa}
        onEmail={emailOn ? (leadId) => { setMailStart(leadId); setChannel('email') } : undefined} />
    )
  }
  return <MailInbox key={mailStart ?? 'mail'} me={me} openLead={openLead} channelSwitch={channelSwitch} startWith={mailStart} />
}

function WhatsAppInbox({ me, openLead, channelSwitch, threads, status, stale, reload, onEmail }: {
  me: ZdScreenProps['me']
  openLead: (recordId: string) => void
  channelSwitch: ReactNode
  threads: WaThread[]
  status: ListStatus
  stale: boolean
  reload: () => Promise<void>
  onEmail?: (leadId: string) => void
}) {
  const [view, setView] = useState<'all' | 'waiting'>('all')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [showInfo, setShowInfo] = useState(true)

  const waiting = threads.filter((t) => t.unanswered > 0)
  const term = query.trim().toLowerCase()
  const base = view === 'waiting' ? waiting : threads
  const list = term ? base.filter((t) => `${t.name} ${t.siteName} ${t.body}`.toLowerCase().includes(term)) : base
  const open = openId ? threads.find((t) => t.leadId === openId) ?? null : null

  return (
    <>
      <aside className="w-[340px] shrink-0 border-r border-[#d8dcde] flex flex-col bg-[#f8f9f9]" aria-label="WhatsApp conversations">
        <div className="px-4 pt-4 pb-2">
          {channelSwitch}
          <h1 className="text-[18px] font-semibold text-[#2f3941]">WhatsApp</h1>
          <p className="text-[12px] text-[#68737d]">{status === 'ok' ? (waiting.length > 0 ? `${waiting.length} waiting on a reply` : 'Nobody is waiting') : status === 'loading' ? 'Loading…' : ' '}</p>
          <div className="mt-3 flex gap-1" role="tablist" aria-label="WhatsApp views">
            {([['all', 'All', threads.length], ['waiting', 'Waiting on us', waiting.length]] as const).map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}
                className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${view === key ? 'bg-white text-[#1f73b7] shadow-[0_0_0_1px_#d8dcde]' : 'text-[#68737d] hover:bg-[#e9ebed]'}`}>
                {label}{status === 'ok' && <span className="ml-1 tabular-nums opacity-80">{count}</span>}
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 h-9 px-2.5 rounded-md bg-white border border-[#d8dcde] focus-within:border-[#1f73b7]">
            <Search size={15} className="text-[#87929d]" aria-hidden />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, site or message" aria-label="Search WhatsApp conversations"
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] placeholder:text-[#87929d]" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear the search" className="w-6 h-6 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed]"><X size={14} aria-hidden /></button>}
          </label>
        </div>

        <div className="flex-1 overflow-y-auto [scrollbar-width:thin]">
          {status === 'loading' && (
            <div className="px-4 py-3 space-y-3" role="status" aria-label="Loading conversations">
              {Array.from({ length: 7 }).map((_, i) => <div key={i} className="h-14 rounded-md bg-[#e9ebed] animate-pulse" />)}
            </div>
          )}
          {status === 'unavailable' && (
            <div className="px-6 py-12 text-center">
              <MessageCircle size={24} className="mx-auto mb-2 text-[#87929d]" aria-hidden />
              <p className="text-[13px] font-medium text-[#2f3941]">WhatsApp is not enabled for this workspace</p>
            </div>
          )}
          {status === 'error' && (
            <div className="px-6 py-12 text-center">
              <p role="alert" className="text-[13px] font-medium text-[#2f3941]">The WhatsApp conversations could not be loaded.</p>
              <button type="button" onClick={() => void reload()} className={`${BTN_PLAIN} mt-3`}><RefreshCw size={13} aria-hidden />Try again</button>
            </div>
          )}
          {status === 'ok' && stale && (
            <div className="px-4 py-2 border-b border-[#e9ebed] flex items-center gap-2">
              <Notice bad text="The list could not be refreshed, so it may be out of date." />
              <button type="button" onClick={() => void reload()} className="ml-auto shrink-0 text-[12px] font-medium text-[#1f73b7] hover:text-[#144a75]">Retry</button>
            </div>
          )}
          {status === 'ok' && list.length === 0 && (
            <p className="px-5 py-8 text-[13px] text-[#68737d]">
              {term ? 'No WhatsApp conversation matches that search.' : view === 'waiting' ? 'Nobody is waiting on WhatsApp. A customer whose message has no reply yet shows up here.' : 'No WhatsApp conversations yet. One starts when a customer writes to your WhatsApp number.'}
            </p>
          )}
          {status === 'ok' && list.map((t) => {
            const needs = t.unanswered > 0
            const isOpen = t.leadId === openId
            return (
              <button key={t.leadId} type="button" onClick={() => setOpenId(t.leadId)} aria-current={isOpen ? 'true' : undefined}
                className={`w-full text-left px-4 py-3 flex gap-3 border-b border-[#e9ebed] transition-colors ${isOpen ? 'bg-[#edf7ff]' : needs ? 'bg-white hover:bg-[#f3f9ff]' : 'hover:bg-white'}`}>
                <Avatar label={t.name || 'Customer'} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`truncate text-[13px] ${needs ? 'font-semibold' : ''} text-[#2f3941]`}>{waName(t)}</span>
                    {t.messages > 1 && <span className="shrink-0 text-[11px] text-[#87929d] tabular-nums" aria-label={`${t.messages} messages`}>{t.messages}</span>}
                    <span className={`ml-auto shrink-0 text-[11px] tabular-nums ${needs ? 'font-semibold text-[#2f3941]' : 'text-[#87929d]'}`} title={t.at ? formatDateTime(t.at) : undefined}>{listDate(t.at)}</span>
                  </span>
                  <span className={`block truncate text-[12px] ${needs ? 'font-medium text-[#2f3941]' : 'text-[#68737d]'}`}>
                    {t.direction === 'out' ? 'You: ' : ''}{t.body || (t.hasMedia ? 'Attachment' : 'No text')}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-[#87929d]">
                    <span className="truncate">{t.siteName}</span>
                    {needs && <span className="shrink-0 px-1.5 rounded bg-[#fff3e4] text-[#ad5918] font-medium" title="The customer wrote last and nobody has replied">Waiting{t.unanswered > 1 ? ` · ${t.unanswered}` : ''}</span>}
                    {t.failed && <span className="shrink-0 px-1.5 rounded bg-[#fff0f1] text-[#cc3340] font-medium" title="Our latest WhatsApp message was not delivered">Not delivered</span>}
                    {t.owner && <span className="shrink-0 px-1.5 rounded bg-[#e9ebed] text-[#49545c]">{t.owner.toLowerCase() === me.email.toLowerCase() ? 'You' : short(t.owner)}</span>}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      {openId ? (
        <WaThreadPane key={openId} leadId={openId} thread={open} openLead={openLead} onChanged={reload} onEmail={onEmail}
          showInfo={showInfo} setShowInfo={setShowInfo} onClose={() => setOpenId(null)} />
      ) : (
        <main className="flex-1 min-w-0 flex flex-col items-center justify-center text-center px-6">
          <div className="w-14 h-14 rounded-full bg-[#e9f4f3] flex items-center justify-center mb-4"><MessageCircle size={24} color="#17494d" aria-hidden /></div>
          <p className="text-[16px] font-semibold">Pick a conversation to read it</p>
          <p className="mt-1 text-[13px] text-[#68737d] max-w-sm">Customers whose message has no reply yet are marked Waiting. Replying from here, or from the phone, clears it.</p>
        </main>
      )}
    </>
  )
}

function WaStatus({ status }: { status?: string }) {
  if (status === 'read') return <span className="inline-flex items-center gap-1 text-[#1f73b7]"><CheckCheck size={13} aria-hidden />Read</span>
  if (status === 'delivered') return <span className="inline-flex items-center gap-1"><CheckCheck size={13} aria-hidden />Delivered</span>
  if (status === 'failed' || status === 'undelivered') return <span className="inline-flex items-center gap-1 font-medium text-[#cc3340]"><TriangleAlert size={13} aria-hidden />Not delivered</span>
  return <span className="inline-flex items-center gap-1"><Check size={13} aria-hidden />Sent</span>
}

function WaThreadPane({ leadId, thread, openLead, onChanged, onEmail, showInfo, setShowInfo, onClose }: {
  leadId: string
  thread: WaThread | null
  openLead: (recordId: string) => void
  onChanged: () => Promise<void>
  onEmail?: (leadId: string) => void
  showInfo: boolean
  setShowInfo: (next: boolean) => void
  onClose: () => void
}) {
  const [record, setRecord] = useState<LeadRecord | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<Flash | null>(null)

  const scroller = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const loadRecord = useCallback(async () => {
    try {
      const r = await fetch(`/api/leads/${encodeURIComponent(leadId)}`)
      if (!r.ok) throw new Error('failed')
      const d = await r.json()
      setRecord(d.record as LeadRecord)
      setState('ok')
    } catch {
      setState((s) => (s === 'ok' ? 'ok' : 'error'))
    }
  }, [leadId])

  // Read on open, then once a minute while it stays open: that is how a
  // "Sent" turns into "Delivered" or "Read", and how the 24-hour clock moves.
  useEffect(() => {
    const first = setTimeout(loadRecord, 0)
    const iv = setInterval(() => { setNow(Date.now()); if (!document.hidden) void loadRecord() }, POLL_MS)
    return () => { clearTimeout(first); clearInterval(iv) }
  }, [loadRecord])

  // The list noticed this conversation move (a new customer message): read it now.
  const moved = thread ? `${thread.messages}|${thread.at ?? ''}` : ''
  const lastMoved = useRef(moved)
  useEffect(() => {
    const before = lastMoved.current
    lastMoved.current = moved
    if (!moved || !before || moved === before) return
    const t = setTimeout(loadRecord, 0)
    return () => clearTimeout(t)
  }, [moved, loadRecord])

  const msgs = useMemo(() => (record?.timeline ?? [])
    .filter((e) => (e.kind === 'wa_in' || e.kind === 'wa_out') && e.wa)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()), [record])

  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [msgs.length, state])

  // WhatsApp's own rule, worked out from the conversation before anyone types:
  // a free reply is delivered only within 24 hours of the customer's last message.
  const lastInbound = msgs.reduce((m, e) => (e.kind === 'wa_in' ? Math.max(m, new Date(e.at).getTime()) : m), 0)
  const closesAt = lastInbound ? lastInbound + DAY_MS : 0
  const windowOpen = !!closesAt && now < closesAt
  const left = closesAt - now
  const leftLabel = left >= 3600000 ? `${Math.floor(left / 3600000)} h left` : `${Math.max(1, Math.round(left / 60000))} min left`
  const fallback = onEmail && record?.contact.email ? 'or email them instead' : 'or reach them by email'
  const rule = !lastInbound
    ? `This customer has not written on WhatsApp yet. WhatsApp only delivers a free reply within 24 hours of the customer's last message, and ZeeDesk has no approved templates yet, so a message sent now will be refused. Wait for them to write first, ${fallback}.`
    : !windowOpen
      ? `Their last message was more than 24 hours ago, so WhatsApp will refuse a free reply. ZeeDesk has no approved templates yet: wait for the customer to write again, ${fallback}.`
      : ''

  const hasPhone = !!record?.contact.phone
  const name = record?.contact.name || thread?.name || thread?.phone || 'Customer'

  async function send() {
    const body = text.trim()
    if (busy || (!body && !file)) return
    setBusy(true); setFlash(null)
    try {
      let media: { mediaPath: string; mediaName: string; mediaType: string } | null = null
      if (file) {
        const prep = await fetch(`/api/leads/${encodeURIComponent(leadId)}/whatsapp/upload`, postJson({ name: file.name, mime: file.type, size: file.size }))
        const pd = await prep.json().catch(() => ({}))
        if (!prep.ok) throw new Error(pd.error || 'That file could not be sent.')
        const put = await fetch(pd.uploadUrl, { method: 'PUT', body: file, headers: file.type ? { 'Content-Type': file.type } : undefined })
        if (!put.ok) throw new Error('The file could not be uploaded.')
        media = { mediaPath: pd.path, mediaName: file.name, mediaType: file.type || '' }
      }
      // No recipient is sent: the server addresses the message from the lead's own record.
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/whatsapp`, postJson({ body, ...(media ?? {}) }))
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'The message could not be sent.')
      setText(''); setFile(null)
      if (d.recorded === false) setFlash({ text: d.warning || 'The message was sent, but it could not be added to this conversation.', bad: true })
      await loadRecord()
      void onChanged()
    } catch (e) {
      setFlash({ text: e instanceof Error && e.name !== 'TypeError' ? e.message : 'The message could not be sent. Check your connection and try again.', bad: true })
    } finally {
      setBusy(false)
    }
  }

  async function refresh() {
    setRefreshing(true)
    await Promise.all([loadRecord(), onChanged()])
    setNow(Date.now())
    setRefreshing(false)
  }

  return (
    <>
      <main className="flex-1 min-w-0 flex flex-col">
        <header className="h-[60px] shrink-0 px-5 flex items-center gap-3 border-b border-[#d8dcde]">
          <Avatar label={record?.contact.name || thread?.name || 'Customer'} size={36} />
          <div className="min-w-0">
            <h2 className="font-semibold truncate">{name}</h2>
            <p className="text-[12px] text-[#68737d] truncate">WhatsApp · {record?.siteName ?? thread?.siteName ?? ''}{thread?.agents.length ? ` · answered by ${thread.agents.join(', ')}` : ''}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {state === 'ok' && !!closesAt && (
              <span title={windowOpen ? 'WhatsApp delivers a free reply for 24 hours after the customer’s last message' : 'More than 24 hours since the customer’s last message, so WhatsApp will refuse a free reply'}>
                <Chip tone={windowOpen ? 'green' : 'amber'}>{windowOpen ? `Reply window open · ${leftLabel}` : 'Reply window closed'}</Chip>
              </span>
            )}
            <button type="button" onClick={() => void refresh()} disabled={refreshing} title="Check for new messages" aria-label="Check for new messages"
              className="w-8 h-8 rounded-md flex items-center justify-center border border-[#d8dcde] hover:bg-[#f8f9f9] disabled:opacity-40"><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} aria-hidden /></button>
            <button type="button" onClick={() => openLead(leadId)} className={BTN_PLAIN}><ExternalLink size={14} aria-hidden />Open the full record</button>
            <button type="button" onClick={() => setShowInfo(!showInfo)} aria-pressed={showInfo} title="Customer details" aria-label="Customer details"
              className={`hidden lg:flex w-8 h-8 rounded-md items-center justify-center border border-[#d8dcde] ${showInfo ? 'bg-[#edf7ff] text-[#1f73b7]' : 'hover:bg-[#f8f9f9]'}`}><UserRound size={16} aria-hidden /></button>
            <button type="button" onClick={onClose} title="Close this conversation" aria-label="Close this conversation"
              className="w-8 h-8 rounded-md flex items-center justify-center border border-[#d8dcde] hover:bg-[#f8f9f9]"><X size={16} aria-hidden /></button>
          </div>
        </header>

        <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-4 bg-[#f8f9f9] [scrollbar-width:thin]">
          {state === 'loading' && (
            <div className="space-y-3" role="status" aria-label="Loading the conversation">
              {[0, 1, 2].map((i) => <div key={i} className={`h-12 w-1/2 rounded-lg bg-[#e9ebed] animate-pulse ${i === 1 ? 'ml-auto' : ''}`} />)}
            </div>
          )}
          {state === 'error' && (
            <div className="py-16 text-center">
              <p role="alert" className="text-[13px] font-medium text-[#2f3941]">This conversation could not be loaded.</p>
              <button type="button" onClick={() => { setState('loading'); void loadRecord() }} className={`${BTN_PLAIN} mt-3`}><RefreshCw size={13} aria-hidden />Try again</button>
            </div>
          )}
          {state === 'ok' && msgs.length === 0 && (
            <p className="py-16 text-center text-[13px] text-[#68737d]">No WhatsApp messages with {name} yet.</p>
          )}
          {state === 'ok' && (
            <div className="max-w-[860px] mx-auto space-y-2">
              {msgs.map((e, i) => {
                const w = e.wa!
                const mine = e.kind === 'wa_out'
                const prev = msgs[i - 1]
                const newDay = !prev || pktDayKey(prev.at) !== pktDayKey(e.at)
                const failed = mine && (w.status === 'failed' || w.status === 'undelivered')
                return (
                  <div key={e.id}>
                    {newDay && <p className="my-3 text-center"><span className="inline-block px-2.5 py-0.5 rounded-full bg-white border border-[#d8dcde] text-[11px] text-[#68737d]">{dateDividerLabel(e.at)}</span></p>}
                    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                      <div className={`max-w-[72%] rounded-lg px-3 py-2 ${mine ? (failed ? 'bg-white border border-[#cc3340] text-[#2f3941]' : 'bg-[#1f73b7] text-white') : 'bg-white border border-[#d8dcde] text-[#2f3941]'}`}>
                        {mine && (w.bot || w.template) && <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">{w.bot ? 'Sent automatically' : 'Template'}</p>}
                        {/* Photos, voice notes and files come through our own route, which checks this member may see this lead. */}
                        {(w.media ?? []).map((m, k) => {
                          const src = `/api/leads/${encodeURIComponent(leadId)}/whatsapp/media?${m.path ? `path=${encodeURIComponent(m.path)}` : `url=${encodeURIComponent(m.url ?? '')}`}`
                          const type = (m.type || '').toLowerCase()
                          if (type.startsWith('audio/')) return <audio key={k} controls preload="none" src={src} className="mb-1 w-60 h-9 max-w-full" aria-label={m.name || 'Voice message'} />
                          if (type.startsWith('image/')) {
                            return (
                              <a key={k} href={src} target="_blank" rel="noopener noreferrer" className="block mb-1">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={src} alt={m.name || 'Photo'} loading="lazy" className="max-h-48 max-w-full rounded" />
                              </a>
                            )
                          }
                          if (type.startsWith('video/')) return <video key={k} controls preload="none" src={src} className="mb-1 w-60 max-w-full rounded" aria-label={m.name || 'Video'} />
                          return (
                            <a key={k} href={src} target="_blank" rel="noopener noreferrer"
                              className={`mb-1 inline-flex items-center gap-1.5 max-w-full px-2 py-1 rounded border text-[12px] ${mine && !failed ? 'border-white/50 text-white hover:bg-white/10' : 'border-[#d8dcde] text-[#1f73b7] hover:bg-[#f8f9f9]'}`}>
                              <FileText size={13} className="shrink-0" aria-hidden /><span className="truncate">{m.name || 'File'}</span>
                            </a>
                          )
                        })}
                        {e.body && <p className="whitespace-pre-wrap break-words leading-[1.45]">{e.body}</p>}
                      </div>
                      <p className="mt-0.5 flex items-center gap-2 text-[11px] text-[#87929d]">
                        <time dateTime={e.at} title={formatDateTime(e.at)} className="tabular-nums">{formatTime(e.at)}</time>
                        {mine && w.sentBy && <span>{short(w.sentBy)}</span>}
                        {mine && <WaStatus status={w.status} />}
                      </p>
                      {failed && <p role="note" className="mt-0.5 max-w-[72%] text-right text-[12px] text-[#cc3340]">{waFailureHint(w.errorCode)}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {state === 'ok' && record && (
          <footer className="shrink-0 border-t border-[#d8dcde] px-5 py-3 bg-white">
            {!hasPhone ? (
              <Notice text="This lead has no phone number on file, so it cannot be messaged on WhatsApp." />
            ) : (
              <>
                {rule && (
                  <div role="note" className="mb-2 flex items-start gap-2 rounded-md border border-[#f0c48a] bg-[#fff3e4] px-3 py-2 text-[12px] leading-5 text-[#703815]">
                    <TriangleAlert size={14} className="shrink-0 mt-0.5 text-[#ad5918]" aria-hidden />
                    <span className="min-w-0 flex-1">{rule}</span>
                    {onEmail && record.contact.email && <button type="button" onClick={() => onEmail(leadId)} className={`${BTN_PLAIN} shrink-0`}><Mail size={14} aria-hidden />Email instead</button>}
                  </div>
                )}
                {flash && <div className="mb-2"><Notice text={flash.text} bad={flash.bad} /></div>}
                {file && (
                  <p className="mb-2 flex items-center gap-2 text-[12px]">
                    <FileIcon mime={file.type} size={13} />
                    <span className="truncate font-medium text-[#2f3941]">{file.name}</span>
                    <span className="shrink-0 text-[#87929d] tabular-nums">{humanSize(file.size)}</span>
                    <button type="button" onClick={() => setFile(null)} disabled={busy} aria-label={`Remove ${file.name}`} className="w-6 h-6 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed] hover:text-[#cc3340] disabled:opacity-40"><X size={13} aria-hidden /></button>
                  </p>
                )}
                <div className="flex items-end gap-2 rounded-lg border border-[#d8dcde] bg-white px-2 py-2 focus-within:border-[#1f73b7]">
                  <input ref={fileInput} type="file" className="hidden" aria-hidden tabIndex={-1}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setFlash(null) } e.target.value = '' }} />
                  <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} title="Attach a photo, PDF, audio or video file" aria-label="Attach a file"
                    className="w-9 h-9 rounded-md flex items-center justify-center text-[#68737d] hover:bg-[#f8f9f9] disabled:opacity-40"><Paperclip size={17} aria-hidden /></button>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000} aria-label="WhatsApp reply"
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
                    placeholder="Write a WhatsApp reply. Enter sends, Shift+Enter adds a line."
                    className="flex-1 resize-none bg-transparent outline-none text-[14px] leading-5 py-1.5 placeholder:text-[#87929d]" />
                  <button type="button" onClick={() => void send()} disabled={busy || (!text.trim() && !file)} className={`${BTN_PRIMARY} h-9 px-4`}>
                    {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Send size={15} aria-hidden />}{busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </footer>
        )}
      </main>

      {showInfo && (
        <aside className="hidden lg:flex w-[300px] shrink-0 border-l border-[#d8dcde] flex-col bg-[#f8f9f9] overflow-y-auto [scrollbar-width:thin]" aria-label="Customer">
          <div className="h-[60px] shrink-0 px-4 flex items-center border-b border-[#d8dcde]">
            <p className="font-semibold">Customer</p>
            <button type="button" onClick={() => setShowInfo(false)} className="ml-auto w-7 h-7 rounded flex items-center justify-center hover:bg-[#e9ebed]" aria-label="Hide customer details"><X size={15} aria-hidden /></button>
          </div>
          {!record ? (
            <p className="p-4 text-[13px] text-[#68737d]">{state === 'error' ? 'The customer could not be loaded.' : 'Loading the customer…'}</p>
          ) : (
            <div className="p-4 space-y-5">
              <section>
                <div className="flex items-center gap-3">
                  <Avatar label={record.contact.name || 'Customer'} size={40} />
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold truncate">{record.contact.name || 'No name given'}</p>
                    <p className="text-[12px] text-[#68737d] truncate">{record.sourceLabel}</p>
                  </div>
                </div>
                <dl className="mt-3 space-y-1.5 text-[13px]">
                  <Fact label="Phone" value={record.contact.phone || 'Not given'} />
                  <Fact label="Email" value={record.contact.email || 'Not given'} />
                  <Fact label="Site" value={record.siteName} />
                  <Fact label="Stage" value={String(record.stage).replace(/_/g, ' ')} capitalize />
                  <Fact label="Owner" value={short(record.owner) || 'Unassigned'} />
                  {record.country && <Fact label="Country" value={record.country} />}
                </dl>
                {record.contactsHidden && <p className="mt-2 text-[12px] text-[#68737d]">Contact details are hidden for your account. A message you send still reaches this customer.</p>}
                <button type="button" onClick={() => openLead(record.id)} className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-[#1f73b7] hover:text-[#144a75]">Open the full record <ChevronRight size={14} aria-hidden /></button>
              </section>
              <section>
                <h3 className={LABEL}>This conversation</h3>
                <dl className="space-y-1.5 text-[13px]">
                  <Fact label="Messages" value={`${msgs.length} in total, ${msgs.filter((e) => e.kind === 'wa_in').length} from the customer`} />
                  <Fact label="They wrote" value={lastInbound ? timeAgo(new Date(lastInbound).toISOString()) : 'Not yet'} />
                  <Fact label="We wrote" value={thread?.lastOutAt ? formatDateTime(thread.lastOutAt) : 'Not yet'} />
                  <Fact label="Waiting" value={thread && thread.unanswered > 0 ? `Yes, ${thread.unanswered} message${thread.unanswered === 1 ? '' : 's'} unanswered` : 'No'} />
                </dl>
              </section>
            </div>
          )}
        </aside>
      )}
    </>
  )
}
