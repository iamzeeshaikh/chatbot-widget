'use client'

// Full-page lead record — /leads/[id].
//
// [id] is the same conversation id the rest of the dashboard uses, so links
// that already exist keep working; email-only leads (custom quote / checkout)
// use the synthetic `quote-<leadId>` id the Billing tab already gives them.
//
// All state written here is a chat_logs control row (see lib/crm.ts) — no DDL,
// no new tables. Access is decided server-side by /api/leads/[id]; this page
// simply renders whatever that endpoint is willing to return.
//
// LAYOUT: sticky header, then 3 columns on desktop (identity / work / context),
// 2 on tablet, stacked on mobile. Authored in the dashboard's light Tailwind
// utilities so globals.css can remap them for dark mode — see ui.tsx.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  ArrowLeft, MessagesSquare, StickyNote, ListTodo, Mail, Phone, Target,
  Paperclip, Link2, Activity, FileText, Lock, Search, TriangleAlert,
  Repeat, Building2, Globe, Tag, Inbox, ChevronRight, MessageCircle, X,
} from 'lucide-react'
import { formatDateTime, formatShortDateTime, timeAgo } from '@/lib/datetime'
import {
  CRM_STAGES, CRM_STAGE_LABEL, CRM_STAGE_STYLE, CRM_STAGE_DOT, CRM_CURRENCIES,
  CURRENCY_SYMBOL, isDeadStage, type CrmStage, type CrmCurrency,
} from '@/lib/crm'
import { isImageMime } from '@/lib/attachment'
import type { LeadRecord, TimelineEvent } from '@/lib/leadrecord'
import type { CrmTaskEntry } from '@/lib/tasks'
import Timeline from './Timeline'
import Tasks, { type TaskDraft } from './Tasks'
import EmailComposer, { type ReplyTo } from './EmailComposer'
import { Card, EmptyLine, EmptyState, InlineField, Prop, PropGroup, QuickAction, Skeleton } from './ui'
import GlobalSearch from '@/app/components/GlobalSearch'
import { useLiveVersion } from '@/app/components/useLiveVersion'

export default function LeadRecordPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''

  const [record, setRecord] = useState<LeadRecord | null>(null)
  const [markingRead, setMarkingRead] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ok' | 'forbidden' | 'missing' | 'error'>('loading')
  const [me, setMe] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [stageError, setStageError] = useState('')
  // Tasks mid-write. Keyed by task id so completing one doesn't grey out the
  // rest of the list.
  const [taskBusy, setTaskBusy] = useState<Set<string>>(new Set())
  const [taskError, setTaskError] = useState('')
  const [composing, setComposing] = useState(false)
  const [waOpen, setWaOpen] = useState(false)
  const [waText, setWaText] = useState('')
  const [waSending, setWaSending] = useState(false)
  const [waError, setWaError] = useState('')
  // Set when the composer was opened by Reply on an inbound message; cleared on
  // close so the next plain "Email" click is a fresh message, not a stale reply.
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null)
  // Whether THIS agent's Gmail consent can read replies. Only consulted on a
  // record that has actually sent an email — a lead with no email thread has no
  // reply to miss, and warning there would be noise on every record.
  const [replyCaptureOk, setReplyCaptureOk] = useState<boolean | null>(null)

  // The theme is a `dark` class on <html>, persisted by the dashboard header
  // toggle. A hard load of this route has to re-apply it or the page opens
  // light while the rest of the app is dark.
  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark')
    } catch { /* private mode — default light */ }
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.email) setMe(String(d.email)) })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // Never flips the status back to `loading` — the skeleton is shown from the
  // initial state and from the derived id mismatch below, so a background
  // refresh can't blank out a record the agent is looking at.
  // Marking read is explicit rather than "seen on load": an agent who opens a
  // record to check the phone number has not dealt with the reply, and having
  // the badge vanish underneath them would lose the one signal that says this
  // lead still needs an answer.
  const markRepliesRead = useCallback(async () => {
    if (!record) return
    const ids = record.timeline
      .filter((e) => e.kind === 'email_in' && e.unread && e.inbound)
      .map((e) => e.inbound!.gmailId)
    if (ids.length === 0) return
    setMarkingRead(true)
    try {
      await fetch(`/api/leads/${encodeURIComponent(record.id)}/email/read`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gmailIds: ids }),
      })
      await load()
    } finally {
      setMarkingRead(false)
    }
    // `load` is defined below; referencing it here is fine because both are
    // stable callbacks created before first render completes.
  }, [record])   // eslint-disable-line react-hooks/exhaustive-deps

  const hasSentEmail = !!record?.timeline.some((e) => e.kind === 'email')

  useEffect(() => {
    if (!hasSentEmail || replyCaptureOk !== null) return
    fetch('/api/google/gmail/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.connected) setReplyCaptureOk(d.canReadReplies !== false) })
      .catch(() => { /* the banner is an extra, never a blocker */ })
  }, [hasSentEmail, replyCaptureOk])

  const load = useCallback((): Promise<void> => {
    if (!id) return Promise.resolve()
    return fetch(`/api/leads/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 401) { window.location.href = '/login'; return }
        if (res.status === 403) { setStatus('forbidden'); return }
        if (res.status === 404) { setStatus('missing'); return }
        if (!res.ok) { setStatus('error'); return }
        const data = await res.json()
        setRecord(data.record as LeadRecord)
        setStatus('ok')
      })
      .catch(() => setStatus('error'))
  }, [id])

  useEffect(() => { load() }, [load])

  // ── live updates ──────────────────────────────────────────────────────────
  // 20s matches the detail-poll cadence the dashboard already uses, and each
  // tick is one index-backed row — the record itself is only refetched when
  // something actually changed.
  //
  // Refreshing is DEFERRED, never cancelled, while the agent is mid-edit: an
  // open composer, a half-typed note or an open note editor would all be
  // clobbered by a re-render, and losing typed text to a background poll is far
  // worse than seeing a reply twenty seconds later. The deferred refresh lands
  // the moment they finish.
  // Timeline's own note editor keeps its draft in local state, which survives a
  // re-render, so it does not need guarding here. These two do: the composer is
  // a modal the agent is working inside, and the note box is uncommitted text.
  const busyEditing = composing || !!noteDraft.trim()
  useLiveVersion({
    leadId: id, watch: 'lead', intervalMs: 20_000, paused: busyEditing,
    onChange: () => { load() },
  })

  // ── Mutations ─────────────────────────────────────────────────────────────
  const post = useCallback(async (path: string, body: unknown, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') => {
    const res = await fetch(`/api/leads/${encodeURIComponent(id)}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Request failed')
    return res.json()
  }, [id])

  // Optimistic: the pill moves the instant it's clicked and rolls back to the
  // previous stage if the write fails, so the page never shows a stage the
  // database doesn't have.
  async function changeStage(next: CrmStage) {
    if (!record || next === record.stage) return
    const previous = record.stage
    setStageError('')
    setRecord({ ...record, stage: next, stageBy: me, stageAt: new Date().toISOString() })
    try {
      await post('/stage', { stage: next, previous })
      load()
    } catch (err) {
      setRecord((r) => (r ? { ...r, stage: previous } : r))
      setStageError(err instanceof Error ? err.message : 'Could not save the stage')
    }
  }

  async function sendWhatsApp() {
    const text = waText.trim()
    if (!text) return
    setWaSending(true); setWaError('')
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(id)}/whatsapp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setWaError(d.error || 'The message could not be sent.'); return }
      // Only cleared on success: a failed send must not lose what was typed —
      // the 24-hour rule refuses often enough that retyping would be the norm.
      setWaText(''); setWaOpen(false)
      load()
    } catch {
      setWaError('The message could not be sent.')
    } finally {
      setWaSending(false)
    }
  }

  async function saveField(field: 'name' | 'email' | 'phone', value: string) {
    if (!record) return
    setRecord({ ...record, contact: { ...record.contact, [field]: value }, overriddenFields: Array.from(new Set([...record.overriddenFields, field])) })
    try { await post('/field', { field, value }); load() } catch { load() }
  }

  async function saveValue(next: { estimated: number | null; won: number | null; currency: CrmCurrency }) {
    if (!record) return
    setRecord({ ...record, value: next })
    try { await post('/value', next); load() } catch { load() }
  }

  async function saveOwner(email: string) {
    if (!record) return
    const prev = record.owner
    setRecord({ ...record, owner: email || null })
    try { await post('/owner', { email }); load() } catch { setRecord((r) => (r ? { ...r, owner: prev } : r)) }
  }

  async function addNote() {
    const body = noteDraft.trim()
    if (!body) return
    setAddingNote(true)
    try {
      await post('/notes', { body })
      setNoteDraft('')
      await load()
    } finally {
      setAddingNote(false)
    }
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const markBusy = useCallback((taskId: string, busy: boolean) => {
    setTaskBusy((prev) => {
      const next = new Set(prev)
      if (busy) next.add(taskId); else next.delete(taskId)
      return next
    })
  }, [])

  const createTask = useCallback(async (draft: TaskDraft) => {
    setTaskError('')
    try {
      await post('/tasks', {
        title: draft.title, type: draft.type,
        dueDate: draft.dueDate, dueTime: draft.dueTime, assignee: draft.assignee,
      })
      await load()
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : 'Could not add the task')
    }
  }, [post, load])

  // Optimistic: the task moves to done (or back) the instant the circle is
  // clicked. On failure the previous list is restored so the page never shows a
  // completion the database rejected.
  const toggleTask = useCallback(async (task: CrmTaskEntry, done: boolean) => {
    setTaskError('')
    markBusy(task.id, true)
    let rolledBack: LeadRecord | null = null
    setRecord((r) => {
      if (!r) return r
      rolledBack = r
      const moved: CrmTaskEntry = {
        ...task,
        status: done ? 'done' : 'open',
        completed_at: done ? new Date().toISOString() : undefined,
        completed_by: done ? me : undefined,
      }
      return done
        ? { ...r, openTasks: r.openTasks.filter((t) => t.id !== task.id), doneTasks: [moved, ...r.doneTasks] }
        : { ...r, doneTasks: r.doneTasks.filter((t) => t.id !== task.id), openTasks: [...r.openTasks, moved] }
    })
    try {
      await post('/tasks', { taskId: task.id, status: done ? 'done' : 'open' }, 'PATCH')
      await load()
    } catch (err) {
      if (rolledBack) setRecord(rolledBack)
      setTaskError(err instanceof Error ? err.message : 'Could not update the task — it was put back')
    } finally {
      markBusy(task.id, false)
    }
  }, [post, load, markBusy, me])

  const reassignTask = useCallback(async (task: CrmTaskEntry, assignee: string) => {
    setTaskError('')
    markBusy(task.id, true)
    try {
      await post('/tasks', { taskId: task.id, assignee }, 'PATCH')
      await load()
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : 'Could not reassign the task')
    } finally {
      markBusy(task.id, false)
    }
  }, [post, load, markBusy])

  const deleteTask = useCallback(async (task: CrmTaskEntry) => {
    setTaskError('')
    markBusy(task.id, true)
    try {
      await post('/tasks', { taskId: task.id }, 'DELETE')
      await load()
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : 'Could not delete the task')
    } finally {
      markBusy(task.id, false)
    }
  }, [post, load, markBusy])

  const editNote = useCallback(async (noteId: string, body: string) => {
    await post('/notes', { noteId, body }, 'PATCH')
    await load()
  }, [post, load])

  const deleteNote = useCallback(async (noteId: string) => {
    await post('/notes', { noteId }, 'DELETE')
    await load()
  }, [post, load])

  // A note can be edited or deleted by the agent who wrote it. The timeline
  // only carries the short actor label, so compare on that.
  const canManageNote = useCallback(
    (e: TimelineEvent) => !!e.noteId && (!me || e.actor === me.split('@')[0]),
    [me],
  )

  const conversationHref = useMemo(
    () => (record ? `/?tab=conversations&session=${encodeURIComponent(record.id)}&site=${encodeURIComponent(record.siteId)}` : '/'),
    [record],
  )

  // Derived, not stored: while the fetch for a NEW id is in flight the record
  // in state still belongs to the previous one, so keep showing the skeleton.
  if (status === 'loading' || (status === 'ok' && record?.id !== id)) return <LoadingSkeleton />
  // `ok` with no record can only mean a malformed response — treat it as an error.
  if (status !== 'ok' || !record) return <NotAvailable status={status === 'ok' ? 'error' : status} />

  const followUpLabel = record.followUps.count === 0
    ? 'No follow-ups'
    : `${record.followUps.count} follow-up${record.followUps.count === 1 ? '' : 's'}${record.followUps.lastAt ? ` · last ${timeAgo(record.followUps.lastAt)}` : ''}`

  const displayName = record.contact.name || record.contact.email || record.contact.phone || 'Unnamed lead'

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      {/* ══ Sticky header — anchors the page while the timeline scrolls ══ */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3 flex-wrap">
          <Link href="/" title="Back to the dashboard" aria-label="Back to the dashboard"
            className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 transition-colors">
            <ArrowLeft size={16} strokeWidth={2} aria-hidden />
          </Link>

          <span className="w-9 h-9 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-bold shrink-0" aria-hidden>
            {(displayName[0] ?? '?').toUpperCase()}
          </span>

          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <h1 className="text-xl font-bold text-gray-900 leading-tight break-words tracking-tight">{displayName}</h1>
              <StagePill stage={record.stage} />
            </div>
            <p className="text-[10px] text-gray-500 flex items-center gap-1.5 flex-wrap leading-tight mt-0.5">
              <Building2 size={10} strokeWidth={2} aria-hidden />{record.siteName}
              <span className="text-gray-300" aria-hidden>·</span>
              {record.sourceLabel}
              <span className="text-gray-300" aria-hidden>·</span>
              <span className="tabular-nums" title={formatDateTime(record.createdAt)}>
                created {formatShortDateTime(record.createdAt)}
              </span>
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {/* The one badge that means "this lead is waiting on YOU". Clicking
                it marks the replies read; it then disappears from here and from
                the pipeline. */}
            {record.unreadReplies > 0 && (
              <button onClick={markRepliesRead} disabled={markingRead}
                title={`${record.unreadReplies} unread email repl${record.unreadReplies === 1 ? 'y' : 'ies'} — click to mark read`}
                className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full bg-violet-600 text-white border border-violet-700 hover:bg-violet-700 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <Inbox size={11} strokeWidth={2.5} aria-hidden />
                {markingRead ? 'Marking…' : `${record.unreadReplies} new repl${record.unreadReplies === 1 ? 'y' : 'ies'}`}
              </button>
            )}
            <GlobalSearch compact />
            <span className="hidden lg:inline-flex items-center gap-1 text-[10px] font-medium text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5"
              title="Counted automatically from agent replies — a burst of replies in one sitting counts as one follow-up">
              <Repeat size={11} strokeWidth={2} aria-hidden />{followUpLabel}
            </span>
            {record.hasConversation ? (
              <Link href={conversationHref}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                <MessagesSquare size={13} strokeWidth={2} aria-hidden />
                <span className="hidden sm:inline">Conversation</span>
              </Link>
            ) : (
              <span title="This lead arrived by email — there is no chat transcript"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed">
                <MessagesSquare size={13} strokeWidth={2} aria-hidden />
                <span className="hidden sm:inline">No chat</span>
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1500px] mx-auto px-3 sm:px-5 py-3 grid grid-cols-1 lg:grid-cols-[290px_minmax(0,1fr)_265px] xl:grid-cols-[320px_minmax(0,1fr)_300px] 2xl:grid-cols-[340px_minmax(0,1fr)_320px] gap-3 items-start animate-in">

        {/* ══ LEFT — identity ══
            Pinned on desktop alongside the right column, so only the activity
            timeline scrolls. The timeline is several times taller than either
            side on a real lead; without this both gutters go dead as soon as
            you scroll. Falls back to its own scrollbar if a lead ever has
            enough tags/values to outgrow the viewport. */}
        <div className="space-y-3 min-w-0 lg:sticky lg:top-[60px] lg:max-h-[calc(100vh-72px)] lg:overflow-y-auto">
          <Card>
            <div className="divide-y divide-gray-100">
              <InlineField label="Name" value={record.contact.name} placeholder="Add a name"
                overridden={record.overriddenFields.includes('name')} onSave={(v) => saveField('name', v)} />
              {/* Masked for a viewer who may not see contacts: no mailto/tel
                  link (there is nothing to open) and not editable. Emailing
                  still works — the server addresses it from its own rows. */}
              <InlineField label="Email" value={record.contact.email} placeholder="Add an email"
                href={record.contact.email && !record.contactsHidden ? `mailto:${record.contact.email}` : undefined}
                readOnly={record.contactsHidden}
                overridden={record.overriddenFields.includes('email')} onSave={(v) => saveField('email', v)} />
              <InlineField label="Phone" value={record.contact.phone} placeholder="Add a phone number"
                href={record.contact.phone && !record.contactsHidden ? `tel:${record.contact.phone.replace(/[^\d+]/g, '')}` : undefined}
                readOnly={record.contactsHidden}
                overridden={record.overriddenFields.includes('phone')} onSave={(v) => saveField('phone', v)} />
            </div>

            <div className="flex items-center gap-1 px-2 py-2 border-t border-gray-100">
              <QuickAction icon={StickyNote} label="Note" onClick={() => {
                const el = document.getElementById('note-composer')
                el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                el?.focus()
              }} />
              <QuickAction icon={ListTodo} label="Task" hint="Add a task or follow-up" onClick={() => {
                const btn = document.getElementById('task-composer-open')
                btn?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                btn?.click()
              }} />
              <QuickAction icon={Mail} label="Email"
                hint={record.contact.email ? 'Email this lead from your Gmail' : 'Add an email address first'}
                disabled={!record.contact.email}
                onClick={() => setComposing(true)} />
              {/* WhatsApp: the customer's number is never shown, and the server
                  addresses the message from its own rows — the same rule the
                  email send follows. */}
              <QuickAction icon={MessageCircle} label="WhatsApp"
                hint={record.contact.phone ? 'Message this lead on WhatsApp' : 'Add a phone number first'}
                disabled={!record.contact.phone}
                onClick={() => setWaOpen(true)} />
              <QuickAction icon={Phone} label="Call" disabled hint="Coming soon" />
            </div>
          </Card>

          {/* Properties list — quiet labels, strong values, grouped. */}
          <Card title="Details" icon={FileText} bodyClass="py-1">
            {/* Stage deliberately does NOT appear here — the header pill is the
                authoritative place for it, and the Deal card carries who changed
                it and when. Repeating it in three places was noise. */}
            <PropGroup label="Ownership">
              <Prop label="Owner">
                {/* No negative margin and real right padding: the native chevron
                    was being clipped by the card edge. w-full keeps it inside
                    the value column at every breakpoint. */}
                <select value={record.owner ?? ''} onChange={(e) => saveOwner(e.target.value)}
                  aria-label="Lead owner"
                  className="w-full bg-transparent border border-transparent hover:border-gray-300 focus:border-gray-400 rounded pl-1 pr-1 py-0.5 text-xs font-medium text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 cursor-pointer transition-colors">
                  <option value="">Unassigned</option>
                  {record.assignableMembers.map((m) => (
                    <option key={m} value={m} className="bg-white text-gray-800">{m.split('@')[0]}</option>
                  ))}
                </select>
              </Prop>
            </PropGroup>

            <PropGroup label="Source">
              <Prop label="Channel">
                <span className="font-medium text-gray-900">{record.sourceLabel}</span>
              </Prop>
              <Prop label="Site" title={record.siteName}>
                <span className="font-medium text-gray-900">{record.siteName}</span>
              </Prop>
              {(record.country || record.referrer) && (
                <Prop label="Origin" title={[record.country, record.referrer].filter(Boolean).join(' · ')}>
                  {/* Plain inline flow, not inline-flex: a flex row defaults to
                      nowrap, which is what clipped "search.nortonsafese…". The
                      host truncates with the full URL on hover if it still can't
                      fit. */}
                  <Globe size={11} strokeWidth={2} className="text-gray-400 shrink-0 inline align-[-1px] mr-1" aria-hidden />
                  <span className="inline">{record.country}</span>
                  {record.country && record.referrer && <span className="text-gray-400" aria-hidden> · </span>}
                  {record.referrer && (
                    <span className="inline-block max-w-full align-bottom truncate" title={record.referrer}>
                      {hostOf(record.referrer)}
                    </span>
                  )}
                </Prop>
              )}
              {record.tags.length > 0 && (
                <Prop label="Tags">
                  <span className="inline-flex items-center gap-1 flex-wrap">
                    <Tag size={11} strokeWidth={2} className="text-gray-400 shrink-0" aria-hidden />
                    {record.tags.map((t) => (
                      <span key={t} className="text-[10px] px-1.5 rounded-full bg-gray-200 border border-gray-300 text-gray-700">{t}</span>
                    ))}
                  </span>
                </Prop>
              )}
            </PropGroup>

            <PropGroup label="Timeline">
              <Prop label="First seen" title={formatDateTime(record.firstSeenAt)}>
                <span className="tabular-nums">{formatShortDateTime(record.firstSeenAt)}</span>
              </Prop>
              <Prop label="Created" title={formatDateTime(record.createdAt)}>
                <span className="tabular-nums">{formatShortDateTime(record.createdAt)}</span>
              </Prop>
              <Prop label="Last contact" title={record.lastContactedAt ? formatDateTime(record.lastContactedAt) : 'Never contacted'}>
                {record.lastContactedAt
                  ? <span className="tabular-nums">{formatShortDateTime(record.lastContactedAt)}</span>
                  : <span className="text-gray-400">Never</span>}
              </Prop>
              <Prop label="Last activity" title={formatDateTime(record.lastActivityAt)}>
                <span className="tabular-nums">{record.lastActivityAt ? timeAgo(record.lastActivityAt) : '—'}</span>
              </Prop>
            </PropGroup>
          </Card>
        </div>

        {/* ══ CENTER — what to do, then what happened ══ */}
        <div className="space-y-3 min-w-0">
          {/* Tasks sit above the deal on purpose: what has to happen next
              matters more at a glance than what the deal is worth. */}
          <Tasks
            openTasks={record.openTasks}
            doneTasks={record.doneTasks}
            members={record.assignableMembers}
            me={me}
            busyIds={taskBusy}
            error={taskError}
            onCreate={createTask}
            onToggle={toggleTask}
            onDelete={deleteTask}
            onReassign={reassignTask}
          />

          <Card title="Deal" icon={Target}>
            <div className="px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <label htmlFor="stage-select" className="sr-only">Stage</label>
                <select id="stage-select" value={record.stage} onChange={(e) => changeStage(e.target.value as CrmStage)}
                  style={{ boxShadow: `inset 3px 0 0 ${CRM_STAGE_DOT[record.stage]}` }}
                  className={`text-xs font-bold px-2.5 py-1.5 rounded-lg border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${CRM_STAGE_STYLE[record.stage]}`}>
                  {/* Each option previews its own stage colour. */}
                  {CRM_STAGES.map((s) => (
                    <option key={s} value={s} className="bg-white font-semibold" style={{ color: CRM_STAGE_DOT[s] }}>
                      {CRM_STAGE_LABEL[s]}
                    </option>
                  ))}
                </select>
                {/* Who changed it and when lives here, since the Details list
                    no longer repeats the stage. */}
                <span className="text-[11px] text-gray-500">
                  {record.stageAt ? `changed ${timeAgo(record.stageAt)}` : 'never changed'}
                  {record.stageBy && ` by ${record.stageBy.split('@')[0]}`}
                </span>
              </div>

              <StageRail stage={record.stage} />
              <div className="border-t border-gray-100 pt-2" />

              {stageError && (
                <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1">
                  <TriangleAlert size={12} strokeWidth={2} aria-hidden />
                  {stageError} — the stage was put back.
                </p>
              )}

              {/* Keyed on the saved value so a change made elsewhere (or a
                  rolled-back save) re-seeds the inputs without an effect. */}
              <DealValue key={`${record.value.estimated}|${record.value.won}|${record.value.currency}`}
                record={record} onSave={saveValue} />
            </div>
          </Card>

          <Card title="Activity" icon={Activity} tone="primary"
            action={<span className="text-[10px] text-gray-500 tabular-nums">{record.messageCount} message{record.messageCount === 1 ? '' : 's'}</span>}>
            <div className="px-3 pt-2.5">
              <label htmlFor="note-composer" className="sr-only">Add an internal note</label>
              <textarea id="note-composer" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote() } }}
                rows={noteDraft ? 3 : 1} placeholder="Add an internal note… (only your team can see this)"
                className="w-full bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500 resize-y transition-colors" />
              {noteDraft.trim() && (
                <div className="flex items-center gap-2 mt-1.5 mb-1">
                  <button onClick={addNote} disabled={addingNote}
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                    {addingNote ? 'Saving…' : 'Add note'}
                  </button>
                  <span className="text-[10px] text-gray-400">⌘/Ctrl + Enter</span>
                </div>
              )}
              {!noteDraft.trim() && <div className="h-2" />}
            </div>
            {/* This record has an email thread but the connection cannot read
                replies, so any answer is arriving in Gmail and nowhere here. */}
            {replyCaptureOk === false && (
              <div className="mb-2 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 flex items-start gap-1.5">
                <TriangleAlert size={12} strokeWidth={2} className="shrink-0 mt-px text-amber-700" aria-hidden />
                <p className="text-[11px] text-amber-900">
                  <b>Replies to this lead will not appear below.</b> Your Gmail connection was made before
                  reply capture existed. Sending still works.{' '}
                  <a href={`/api/google/gmail/connect?back=${encodeURIComponent(`/leads/${record.id}`)}`}
                    className="underline font-semibold hover:text-amber-950">Reconnect Gmail</a> to switch it on.
                </p>
              </div>
            )}
            <Timeline events={record.timeline} currency={record.value.currency}
              onReply={(ctx) => { setReplyTo(ctx); setComposing(true) }}
              onRetryFile={async (gmailId, name) => {
                const res = await fetch(`/api/leads/${encodeURIComponent(record.id)}/email/attachment`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ gmailId, name }),
                })
                const j = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(j.error || 'Could not fetch that file.')
                await load()
              }}
              onEditNote={editNote} onDeleteNote={deleteNote} canManageNote={canManageNote} />
          </Card>
        </div>

        {/* ══ RIGHT — context ══
            Sticky on desktop: the activity timeline is far taller than this
            column on any real lead, so pinning it keeps the right-hand side
            useful instead of leaving a tall empty gutter while you scroll. */}
        <div className="space-y-3 min-w-0 lg:sticky lg:top-[60px] lg:max-h-[calc(100vh-72px)] lg:overflow-y-auto">
          <Card title="Attachments" icon={Paperclip} tone="muted"
            action={<span className="text-[10px] text-gray-500 tabular-nums">{record.attachments.length}</span>}>
            {record.attachments.length === 0 ? (
              <EmptyLine icon={Paperclip} text="No files shared" />
            ) : (
              <ul className="divide-y divide-gray-100">
                {record.attachments.map((f) => (
                  <li key={f.url}>
                    <a href={f.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                      {isImageMime(f.mime)
                        /* eslint-disable-next-line @next/next/no-img-element */
                        ? <img src={f.url} alt="" className="w-7 h-7 rounded object-cover shrink-0 border border-gray-200" />
                        : <span className="w-7 h-7 rounded bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0" aria-hidden>
                            <FileText size={12} strokeWidth={2} className="text-gray-500" />
                          </span>}
                      <span className="min-w-0">
                        <span className="block text-xs text-blue-700 truncate" title={f.name}>{f.name}</span>
                        <span className="block text-[10px] text-gray-500 tabular-nums" title={formatDateTime(f.at)}>
                          {f.by} · {formatShortDateTime(f.at)}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Related leads" icon={Link2} tone="muted"
            action={<span className="text-[10px] text-gray-500 tabular-nums">{record.related.length}</span>}>
            {record.related.length === 0 ? (
              <EmptyLine icon={Link2} text="No other leads from this person" />
            ) : (
              <ul className="divide-y divide-gray-100">
                {record.related.map((r) => (
                  <li key={r.id}>
                    <Link href={`/leads/${encodeURIComponent(r.id)}`}
                      className="group/rel flex items-center gap-2 px-3 py-1.5 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-gray-900 truncate">{r.name || r.email || r.phone || 'Lead'}</span>
                          <span className="text-[9px] px-1 rounded bg-gray-200 border border-gray-300 text-gray-600 shrink-0">
                            {r.kind === 'chat' ? 'chat' : r.kind === 'quote' ? 'quote' : 'order'}
                          </span>
                        </span>
                        <span className="block text-[10px] text-gray-500 truncate tabular-nums" title={`${r.siteName} · ${formatDateTime(r.at)}`}>
                          {r.siteName} · {formatShortDateTime(r.at)}
                        </span>
                      </span>
                      <ChevronRight size={13} strokeWidth={2}
                        className="text-gray-400 shrink-0 group-hover/rel:text-gray-600 transition-colors" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {record.quoteMessage && (
            <Card title={record.kind === 'checkout' ? 'Order email' : 'Quote request'} icon={Inbox}>
              <p className="px-3 py-2 text-[11px] text-gray-700 whitespace-pre-wrap break-words max-h-60 overflow-y-auto leading-snug">
                {record.quoteMessage}
              </p>
            </Card>
          )}

          <Card>
            <div className="px-3 py-2">
              {record.hasConversation ? (
                <Link href={conversationHref}
                  className="inline-flex items-center gap-1.5 text-xs text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                  <MessagesSquare size={12} strokeWidth={2} aria-hidden />
                  Open the full conversation
                </Link>
              ) : (
                <p className="text-[11px] text-gray-500">Arrived by email — no chat transcript.</p>
              )}
              <p className="text-[10px] text-gray-400 mt-1 font-mono break-all" title={record.id}>{record.id}</p>
            </div>
          </Card>
        </div>
      </main>

      {waOpen && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-gray-900/40 p-3" onClick={() => setWaOpen(false)}>
          <div className="w-full max-w-lg bg-white border border-gray-200 rounded-2xl shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
              <span className="w-7 h-7 rounded-lg bg-green-100 text-green-700 flex items-center justify-center">
                <MessageCircle size={15} strokeWidth={2} aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">WhatsApp</p>
                <p className="text-[11px] text-gray-500 truncate">to {record.contact.name || 'this lead'}</p>
              </div>
              <button onClick={() => setWaOpen(false)} aria-label="Close"
                className="ml-auto p-1.5 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg"><X size={15} strokeWidth={2} aria-hidden /></button>
            </div>
            <div className="p-4">
              <textarea value={waText} onChange={(e) => setWaText(e.target.value)} rows={5} autoFocus
                placeholder="Write your message…"
                className="w-full text-sm text-gray-900 bg-white border border-gray-300 rounded-xl px-3 py-2 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none" />
              {waError && <p role="alert" className="mt-2 text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">{waError}</p>}
              {/* Said before it bites, not after: WhatsApp refuses a free-form
                  message more than 24 hours after the customer's last one. */}
              <p className="mt-2 text-[11px] text-gray-500">WhatsApp only allows a free reply within 24 hours of the customer&rsquo;s last message.</p>
            </div>
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100">
              <button onClick={sendWhatsApp} disabled={waSending || !waText.trim()}
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                {waSending ? 'Sending…' : 'Send'}
              </button>
              <button onClick={() => setWaOpen(false)} className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1.5">Cancel</button>
            </div>
          </div>
        </div>
      )}

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
          onSent={() => load()}
        />
      )}
    </div>
  )
}

// A referrer's host, without the scheme or the www. A full URL has no spaces to
// break on, so it either overflows the column or splits mid-word ("google.c /
// om") — the host is the part that carries the meaning, and the whole URL stays
// available on hover.
function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || url
  }
}

// ── Stage ────────────────────────────────────────────────────────────────────
// The most important element on the page, so it carries real colour: the pill
// is tinted with the stage's own palette and rimmed with its accent.
function StagePill({ stage }: { stage: CrmStage }) {
  return (
    <span
      style={{ boxShadow: `inset 2px 0 0 ${CRM_STAGE_DOT[stage]}` }}
      className={`inline-flex items-center text-[11px] font-bold px-2.5 py-0.5 rounded-full border shrink-0 ${CRM_STAGE_STYLE[stage]}`}>
      {CRM_STAGE_LABEL[stage]}
    </span>
  )
}

// Progress rail. Completed segments are filled with THEIR OWN stage colour, so
// the bar reads as a journey rather than a single-colour meter; the current
// segment is brighter and ringed. The dead-end stages sit outside the funnel and
// grey the whole rail, which is the honest picture of a dead deal.
function StageRail({ stage }: { stage: CrmStage }) {
  // findIndex rather than indexOf: `funnel` is narrowed to exclude the dead-end
  // stages, and `stage` may BE one — which is exactly the case handled below.
  const funnel = CRM_STAGES.filter((s) => !isDeadStage(s))
  const currentIdx = funnel.findIndex((s) => s === stage)
  const isDead = isDeadStage(stage)

  return (
    <div className="flex items-center gap-1" role="img"
      aria-label={`Stage ${isDead ? CRM_STAGE_LABEL[stage] : `${currentIdx + 1} of ${funnel.length}`}: ${CRM_STAGE_LABEL[stage]}`}>
      {funnel.map((s, i) => {
        const done = !isDead && i <= currentIdx
        const current = !isDead && i === currentIdx
        return (
          <span key={s} title={CRM_STAGE_LABEL[s]}
            className={`flex-1 rounded-full transition-all ${current ? 'h-2' : 'h-1.5'}`}
            style={{
              backgroundColor: done ? CRM_STAGE_DOT[s] : 'rgba(148,163,184,0.25)',
              opacity: done && !current ? 0.55 : 1,
            }} />
        )
      })}
      {isDead && (
        <span className="text-[10px] font-semibold text-red-700 ml-1 shrink-0 whitespace-nowrap">
          {CRM_STAGE_LABEL[stage]}
        </span>
      )}
    </div>
  )
}

// ── Deal value ───────────────────────────────────────────────────────────────
// The number is the point: it gets the size and the weight. Currency is a small
// inline selector beside it, and the "won revenue" note is plainly helper text.
function DealValue({ record, onSave }: {
  record: LeadRecord
  onSave: (v: { estimated: number | null; won: number | null; currency: CrmCurrency }) => Promise<void>
}) {
  const [estimated, setEstimated] = useState(record.value.estimated?.toString() ?? '')
  const [won, setWon] = useState(record.value.won?.toString() ?? '')
  const [currency, setCurrency] = useState<CrmCurrency>(record.value.currency)

  const num = (v: string) => {
    const n = Number(v.replace(/[^0-9.]/g, ''))
    return v.trim() === '' || !isFinite(n) ? null : n
  }

  const commit = (next?: Partial<{ estimated: string; won: string; currency: CrmCurrency }>) =>
    onSave({
      estimated: num(next?.estimated ?? estimated),
      won: num(next?.won ?? won),
      currency: next?.currency ?? currency,
    })

  return (
    <div className="flex items-end gap-4 flex-wrap">
      <div className="min-w-0">
        <label htmlFor="deal-estimated" className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-0.5">
          Estimated value
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-xl font-bold text-gray-400 tabular-nums" aria-hidden>{CURRENCY_SYMBOL[currency]}</span>
          <input id="deal-estimated" inputMode="decimal" value={estimated} placeholder="0"
            onChange={(e) => setEstimated(e.target.value)} onBlur={() => commit()}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className="w-28 bg-transparent border-0 border-b border-transparent hover:border-gray-300 focus:border-blue-500 px-0 py-0 text-2xl font-bold text-gray-900 tabular-nums focus:outline-none transition-colors" />
          <label htmlFor="deal-currency" className="sr-only">Currency</label>
          <select id="deal-currency" value={currency}
            onChange={(e) => { const c = e.target.value as CrmCurrency; setCurrency(c); commit({ currency: c }) }}
            className="bg-gray-100 border border-gray-300 rounded-md px-1 py-0.5 text-[10px] font-semibold text-gray-600 focus:outline-none focus:border-blue-500 cursor-pointer self-center">
            {CRM_CURRENCIES.map((c) => <option key={c} value={c} className="bg-white text-gray-800">{c}</option>)}
          </select>
        </div>
      </div>

      {record.stage === 'won' ? (
        <div className="min-w-0">
          <label htmlFor="deal-won" className="block text-[10px] font-semibold uppercase tracking-wider text-green-700 mb-0.5">
            Won revenue
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-xl font-bold text-green-600 tabular-nums" aria-hidden>{CURRENCY_SYMBOL[currency]}</span>
            <input id="deal-won" inputMode="decimal" value={won} placeholder="0"
              onChange={(e) => setWon(e.target.value)} onBlur={() => commit()}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="w-28 bg-transparent border-0 border-b border-green-300 focus:border-green-600 px-0 py-0 text-2xl font-bold text-green-700 tabular-nums focus:outline-none transition-colors" />
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-gray-400 pb-1.5">Won revenue appears once the stage is Won.</p>
      )}
    </div>
  )
}

// ── Loading / failure states ─────────────────────────────────────────────────
// Mirrors the real three-column layout at the same widths and gaps, so nothing
// jumps when the record lands.
function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-20 bg-white/95 border-b border-gray-200">
        <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3">
          <Skeleton className="w-7 h-7 rounded-lg" />
          <Skeleton className="w-9 h-9 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-2.5 w-60" />
          </div>
        </div>
      </header>
      <main className="max-w-[1500px] mx-auto px-3 sm:px-5 py-3 grid grid-cols-1 lg:grid-cols-[290px_minmax(0,1fr)_265px] xl:grid-cols-[320px_minmax(0,1fr)_300px] 2xl:grid-cols-[340px_minmax(0,1fr)_320px] gap-3 items-start">
        {[0, 1, 2].map((col) => (
          <div key={col} className="space-y-3 w-full">
            <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 space-y-2.5">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-7 w-full rounded-lg" />
              <Skeleton className="h-7 w-full rounded-lg" />
              <Skeleton className="h-7 w-2/3 rounded-lg" />
            </div>
            {col === 1 && (
              <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-3 space-y-2.5">
                <Skeleton className="h-2.5 w-16" />
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-2.5">
                    <Skeleton className="w-5 h-5 rounded-full shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-2.5 w-1/3" />
                      <Skeleton className="h-2.5 w-3/4" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </main>
      <span className="sr-only" role="status">Loading lead record…</span>
    </div>
  )
}

function NotAvailable({ status }: { status: 'forbidden' | 'missing' | 'error' | 'loading' }) {
  const copy = status === 'forbidden'
    // 403 covers two different refusals — a site outside this member's scope,
    // and a workspace that does not carry lead records at all (see
    // WORKSPACE_FEATURES). The hint names both rather than asserting the wrong one.
    ? { icon: Lock, title: 'You don’t have access to this lead', hint: 'Either it belongs to a site outside your assigned sites, or lead records are not enabled for your workspace. Ask an admin if you need it.' }
    : status === 'missing'
      ? { icon: Search, title: 'Lead not found', hint: 'The record may have been deleted, or the link is wrong.' }
      : { icon: TriangleAlert, title: 'Could not load this lead', hint: 'Something went wrong on our side. Try again in a moment.' }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm max-w-sm w-full py-6 animate-in">
        <EmptyState icon={copy.icon} title={copy.title} hint={copy.hint} />
        <div className="flex justify-center pb-1">
          <Link href="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
            <ArrowLeft size={12} strokeWidth={2} aria-hidden />
            Back to the dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}
