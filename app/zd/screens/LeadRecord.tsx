'use client'

// ZeeDesk: one lead as a ticket. The customer and the lead's properties sit on
// the left, the whole history runs down the middle with the reply box under
// it, and the work still to do (tasks), the visit and the files are on the
// right. Every request goes to the same /api/leads/[id] routes the other
// dashboard uses, and those routes decide access; this screen only draws what
// they return and never navigates by URL (it asks the shell).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, Banknote, Check, ChevronDown, ChevronRight, CircleCheck, FileText, Globe, History,
  Image as ImageIcon, Inbox, Link2, Loader2, Lock, Mail, MapPin, MessageCircle, MessageSquare, Monitor, Paperclip, Pencil,
  Plus, RefreshCw, Reply, Search, Send, Sparkles, StickyNote, Target, Trash2, TriangleAlert, UserCheck, X,
} from 'lucide-react'
import { dateDividerLabel, formatDateTime, formatDueLabel, formatShortDateTime, formatTime, timeAgo } from '@/lib/datetime'
import { hasFeature, type Workspace } from '@/lib/workspaces'
import {
  CRM_CURRENCIES, CRM_STAGE_LABEL, CURRENCY_SYMBOL, formatMoney, isDeadStage, stagesForWorkspace,
  type CrmCurrency, type CrmStage,
} from '@/lib/crm'
import {
  DEFAULT_DUE_TIME, MAX_TASK_TITLE, TASK_TYPES, TASK_TYPE_LABEL, defaultDueDate, taskBucket,
  type CrmTaskEntry, type TaskType,
} from '@/lib/tasks'
import { LOST_REASONS, MAX_LOST_NOTE, type LostReason } from '@/lib/lostreasons'
import { isImageMime } from '@/lib/attachment'
import {
  MAX_EMAIL_ATTACHMENT_BYTES, MAX_EMAIL_ATTACHMENTS, MAX_EMAIL_ATTACHMENTS_TOTAL, humanSize, isRetryableSkip,
} from '@/lib/emailattach'
import { matchSiteAlias } from '@/lib/sitealias'
import { waErrorHint } from '@/lib/whatsapp'
import type { LeadRecord as LeadData, TimelineEvent } from '@/lib/leadrecord'
import {
  Avatar, BTN_DANGER, BTN_PLAIN, BTN_PRIMARY, CARD, Chip, Empty, INPUT, LABEL, Notice, TEXTAREA, postJson, short,
  type ZdScreenProps,
} from '../ui'

type Field = 'name' | 'email' | 'phone'
type Status = 'loading' | 'ok' | 'forbidden' | 'missing' | 'error'
type Method = 'POST' | 'PATCH' | 'DELETE'
type Call = (path: string, body: unknown, method?: Method) => Promise<Record<string, unknown>>
type ComposerTab = 'email' | 'whatsapp' | 'note'
type FilterKey = 'all' | 'messages' | 'notes' | 'tasks' | 'updates'
interface ReplyTo { replyToGmailId: string; to: string; subject: string }
interface Alias { email: string; displayName: string; isPrimary: boolean; isDefault: boolean }
interface GmailStatus {
  connected: boolean
  available?: boolean
  configured?: boolean
  aliases?: Alias[]
  reason?: string | null
  needsReconnect?: boolean
  canReadReplies?: boolean
  replyCaptureReason?: string | null
  rateLimited?: boolean
}
interface TaskDraft { title: string; type: TaskType; dueDate: string; dueTime: string; assignee: string }
interface Attached { key: string; name: string; size: number; mime: string; path: string | null; progress: boolean }
interface Visit {
  path?: { url: string | null; title: string | null }[]
  technical?: { country: string | null; city: string | null; browser: string | null; os: string | null; device_type: string | null }
  stats?: { visits: number; chats: number }
}

const SECTION = 'text-[11px] font-semibold uppercase tracking-wide text-[#68737d]'
const SELECT = `${INPUT} cursor-pointer disabled:opacity-50`
const LINK = 'text-[#1f73b7] hover:text-[#144a75] hover:underline outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded'
const ICON_BTN = 'w-7 h-7 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed] hover:text-[#2f3941] disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40'

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || url }
}

function stageTone(stage: CrmStage): 'grey' | 'blue' | 'green' | 'red' | 'amber' {
  if (stage === 'won') return 'green'
  if (isDeadStage(stage)) return 'red'
  if (stage === 'on_hold') return 'amber'
  return stage === 'new' ? 'grey' : 'blue'
}

export default function LeadRecord({ me, openLead, openChat, recordId, onBack }: ZdScreenProps & { recordId: string; onBack: () => void }) {
  // Keyed on the id, so opening another lead starts from a clean screen: no
  // half-written note, reply or open form carries over to the wrong customer.
  return <RecordView key={recordId} me={me} openLead={openLead} openChat={openChat} id={recordId} onBack={onBack} />
}

function RecordView({ me, openLead, openChat, id, onBack }: ZdScreenProps & { id: string; onBack: () => void }) {
  const ws = me.workspace as Workspace
  const canTasks = hasFeature(ws, 'tasks')
  const canEmail = hasFeature(ws, 'email')
  const canWa = hasFeature(ws, 'whatsapp')
  // A reason is asked for only where the server demands one for a move to Lost.
  const lostNeedsReason = hasFeature(ws, 'lost')

  const [record, setRecord] = useState<LeadData | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [filter, setFilter] = useState<FilterKey>('all')
  // Until a tab is picked, a lead that can be emailed opens on Email.
  const [pickedTab, setPickedTab] = useState<ComposerTab | null>(null)
  const [emailOpened, setEmailOpened] = useState(false)
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null)
  const [gmail, setGmail] = useState<GmailStatus | null>(null)
  const [visit, setVisit] = useState<Visit | null>(null)
  const [lostAsk, setLostAsk] = useState<{ busy: boolean; err: string } | null>(null)
  const [stageErr, setStageErr] = useState('')
  const [ownerErr, setOwnerErr] = useState('')
  const [siteErr, setSiteErr] = useState('')
  const [siteBusy, setSiteBusy] = useState(false)
  const [valueErr, setValueErr] = useState('')
  const [markErr, setMarkErr] = useState('')
  const [markBusy, setMarkBusy] = useState(false)
  const [readErr, setReadErr] = useState('')
  const [readBusy, setReadBusy] = useState(false)
  const [taskErr, setTaskErr] = useState('')
  const [taskBusy, setTaskBusy] = useState<Set<string>>(new Set())
  const [backPath] = useState(() => (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search))

  const pane = useRef<HTMLDivElement | null>(null)
  // True when the history should jump to its newest entry on the next paint:
  // on first load and after the agent adds something themselves. A background
  // refresh never moves what they are reading.
  const stick = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(id)}`)
      if (res.status === 401) { window.location.href = '/login'; return }
      if (res.status === 403) { setStatus('forbidden'); return }
      if (res.status === 404) { setStatus('missing'); return }
      const data = res.ok ? await res.json().catch(() => null) : null
      if (!data?.record) { setStatus((s) => (s === 'ok' ? s : 'error')); return }
      setRecord(data.record as LeadData)
      setStatus('ok')
    } catch {
      // A refresh that fails leaves the record on screen; only a first load
      // that fails becomes the error state.
      setStatus((s) => (s === 'ok' ? s : 'error'))
    }
  }, [id])

  useEffect(() => {
    const first = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(first)
  }, [load])

  // Live updates: one small request every 20 seconds, and the record itself is
  // fetched again only when something on this lead has changed.
  useEffect(() => {
    let alive = true
    let seen: string | null = null
    const check = async () => {
      if (!alive || document.hidden) return
      try {
        const res = await fetch(`/api/crm/version?lead=${encodeURIComponent(id)}`)
        if (!res.ok || !alive) return
        const d = await res.json()
        const v = typeof d?.lead === 'string' ? d.lead : null
        if (v === null) return
        if (seen === null) { seen = v; return }
        if (v !== seen) { seen = v; void load() }
      } catch { /* a missed check is harmless; the next one catches up */ }
    }
    void check()
    const timer = setInterval(check, 20000)
    const onVisible = () => { if (!document.hidden) void check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [id, load])

  const hasSentEmail = !!record?.timeline.some((e) => e.kind === 'email')
  // WhatsApp needs a number on the lead; without one the tab is off and a
  // stale pick falls back. A customer waiting on WhatsApp opens on WhatsApp.
  const waReady = canWa && !!record?.contact.phone
  const defaultTab: ComposerTab = waReady && record?.waAwaitingReply ? 'whatsapp' : canEmail && record?.contact.email ? 'email' : 'note'
  const tab: ComposerTab = pickedTab && (pickedTab !== 'whatsapp' || waReady) ? pickedTab : defaultTab
  const emailMounted = canEmail && (emailOpened || tab === 'email')
  const wantGmail = canEmail && !!record && (emailMounted || hasSentEmail)
  useEffect(() => {
    if (!wantGmail) return
    let alive = true
    fetch('/api/google/gmail/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: GmailStatus | null) => { if (alive) setGmail(d ?? { connected: false, configured: true, reason: 'Could not check your Gmail connection. Reload the page to try again.' }) })
      .catch(() => { if (alive) setGmail({ connected: false, configured: true, reason: 'Could not check your Gmail connection. Reload the page to try again.' }) })
    return () => { alive = false }
  }, [wantGmail])

  // Extra visit detail exists only for a lead that came in through the chat.
  const hasChat = !!record?.hasConversation
  useEffect(() => {
    if (!hasChat) return
    let alive = true
    fetch(`/api/admin/visitor?sessionId=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { const v = d?.detail ?? d; if (alive && v?.technical) setVisit(v as Visit) })
      .catch(() => { /* the visit card simply shows less */ })
    return () => { alive = false }
  }, [hasChat, id])

  const timelineSize = record?.timeline.length ?? 0
  useEffect(() => {
    const el = pane.current
    if (!el || !stick.current || timelineSize === 0) return
    el.scrollTop = el.scrollHeight
    stick.current = false
  }, [timelineSize, filter])

  const call: Call = useCallback(async (path, body, method = 'POST') => {
    let res: Response
    try {
      res = await fetch(`/api/leads/${encodeURIComponent(id)}${path}`, postJson(body, method))
    } catch {
      throw new Error('Could not reach the server. Check your connection and try again.')
    }
    const j = await res.json().catch(() => ({}))
    if (res.status === 401) { window.location.href = '/login'; throw new Error('You have been signed out. Sign in again.') }
    if (!res.ok) throw new Error(j.error === 'Not allowed' ? 'You do not have permission to do that.' : (typeof j.error === 'string' && j.error) || 'That did not save. Try again.')
    return j
  }, [id])

  // ── Properties ────────────────────────────────────────────────────────────
  async function changeStage(next: CrmStage, lost?: { reason: LostReason; note: string }) {
    if (!record || next === record.stage) return
    if (next === 'lost' && lostNeedsReason && !lost) { setLostAsk({ busy: false, err: '' }); return }
    const before = { stage: record.stage, stageBy: record.stageBy, stageAt: record.stageAt }
    setStageErr('')
    if (lost) {
      // Not moved until the server agrees: a refusal belongs next to the reason.
      setLostAsk({ busy: true, err: '' })
      try {
        await call('/stage', { stage: next, previous: before.stage, lostReason: lost.reason, lostNote: lost.note })
        setLostAsk(null)
        void load()
      } catch (e) {
        setLostAsk({ busy: false, err: errText(e, 'Could not move this lead to Lost.') })
      }
      return
    }
    setRecord({ ...record, stage: next, stageBy: me.email, stageAt: new Date().toISOString() })
    try {
      await call('/stage', { stage: next, previous: before.stage })
      void load()
    } catch (e) {
      setRecord((r) => (r ? { ...r, ...before } : r))
      setStageErr(`${errText(e, 'Could not save the stage.')} The stage was put back.`)
    }
  }

  async function saveOwner(email: string) {
    if (!record) return
    const before = record.owner
    setOwnerErr('')
    setRecord({ ...record, owner: email || null })
    try { await call('/owner', { email }); void load() } catch (e) {
      setRecord((r) => (r ? { ...r, owner: before } : r))
      setOwnerErr(`${errText(e, 'Could not change the owner.')} The owner was put back.`)
    }
  }

  // Not optimistic: the sending address and signature both follow the site, so
  // the screen waits for the server and then loads the record again.
  async function saveSite(siteId: string) {
    if (!record || !siteId || siteId === record.siteId) return
    setSiteErr(''); setSiteBusy(true)
    try { await call('/site', { siteId }); await load() } catch (e) { setSiteErr(errText(e, 'Could not move this lead to that site.')) } finally { setSiteBusy(false) }
  }

  async function saveValue(next: { estimated: number | null; won: number | null; currency: CrmCurrency }) {
    if (!record) return
    const before = record.value
    setValueErr('')
    setRecord({ ...record, value: next })
    try { await call('/value', next); void load() } catch (e) {
      setRecord((r) => (r ? { ...r, value: before } : r))
      setValueErr(`${errText(e, 'Could not save the value.')} The old figures were put back.`)
    }
  }

  async function saveField(field: Field, value: string) {
    if (!record) return
    const before = { contact: record.contact, overriddenFields: record.overriddenFields }
    setRecord({ ...record, contact: { ...record.contact, [field]: value }, overriddenFields: Array.from(new Set([...record.overriddenFields, field])) })
    try { await call('/field', { field, value }); void load() } catch (e) {
      setRecord((r) => (r ? { ...r, ...before } : r))
      throw e
    }
  }

  // A mark, not a delete: the lead stays readable and pressing again undoes it.
  async function toggleNotALead() {
    if (!record || markBusy) return
    const before = record.notALead
    const marking = !before
    setMarkErr(''); setMarkBusy(true)
    setRecord({ ...record, notALead: marking ? { spam: true, by: me.email, at: new Date().toISOString() } : undefined })
    try { await call('/not-a-lead', { spam: marking }); void load() } catch (e) {
      setRecord((r) => (r ? { ...r, notALead: before } : r))
      setMarkErr(errText(e, 'Could not save that.'))
    } finally { setMarkBusy(false) }
  }

  async function markRepliesRead() {
    if (!record || readBusy) return
    const gmailIds = record.timeline.filter((e) => e.kind === 'email_in' && e.unread && e.inbound).map((e) => e.inbound!.gmailId)
    if (gmailIds.length === 0) return
    setReadErr(''); setReadBusy(true)
    try { await call('/email/read', { gmailIds }); await load() } catch (e) { setReadErr(errText(e, 'Could not mark the replies as read.')) } finally { setReadBusy(false) }
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  async function addNote(body: string) {
    await call('/notes', { body })
    stick.current = true
    setFilter((f) => (f === 'all' || f === 'notes' ? f : 'all'))
    await load()
  }
  const editNote = useCallback(async (noteId: string, body: string) => { await call('/notes', { noteId, body }, 'PATCH'); await load() }, [call, load])
  const deleteNote = useCallback(async (noteId: string) => { await call('/notes', { noteId }, 'DELETE'); await load() }, [call, load])
  const retryFile = useCallback(async (gmailId: string, name: string) => { await call('/email/attachment', { gmailId, name }); await load() }, [call, load])

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const flagTask = (taskId: string, busy: boolean) => setTaskBusy((prev) => {
    const next = new Set(prev)
    if (busy) next.add(taskId); else next.delete(taskId)
    return next
  })

  async function createTask(draft: TaskDraft) {
    setTaskErr('')
    await call('/tasks', draft)
    await load()
  }

  async function toggleTask(task: CrmTaskEntry, done: boolean) {
    if (!record) return
    const before = { openTasks: record.openTasks, doneTasks: record.doneTasks }
    const moved: CrmTaskEntry = { ...task, status: done ? 'done' : 'open', completed_at: done ? new Date().toISOString() : undefined, completed_by: done ? me.email : undefined }
    setTaskErr(''); flagTask(task.id, true)
    setRecord(done
      ? { ...record, openTasks: record.openTasks.filter((t) => t.id !== task.id), doneTasks: [moved, ...record.doneTasks] }
      : { ...record, doneTasks: record.doneTasks.filter((t) => t.id !== task.id), openTasks: [...record.openTasks, moved] })
    try { await call('/tasks', { taskId: task.id, status: done ? 'done' : 'open' }, 'PATCH'); await load() } catch (e) {
      setRecord((r) => (r ? { ...r, ...before } : r))
      setTaskErr(`${errText(e, 'Could not update the task.')} It was put back.`)
    } finally { flagTask(task.id, false) }
  }

  async function reassignTask(task: CrmTaskEntry, assignee: string) {
    setTaskErr(''); flagTask(task.id, true)
    try { await call('/tasks', { taskId: task.id, assignee }, 'PATCH'); await load() } catch (e) { setTaskErr(errText(e, 'Could not reassign the task.')) } finally { flagTask(task.id, false) }
  }

  async function deleteTask(task: CrmTaskEntry) {
    setTaskErr(''); flagTask(task.id, true)
    try { await call('/tasks', { taskId: task.id }, 'DELETE'); await load() } catch (e) { setTaskErr(errText(e, 'Could not delete the task.')) } finally { flagTask(task.id, false) }
  }

  // ── Composer ──────────────────────────────────────────────────────────────
  // Once shown, the email form stays mounted so a half-written message
  // survives a look at the Note tab.
  function pickTab(next: ComposerTab) { if (tab === 'email' || next === 'email') setEmailOpened(true); setPickedTab(next) }
  function showEmailTab() { pickTab('email') }
  function waSent() {
    stick.current = true
    setFilter((f) => (f === 'all' || f === 'messages' ? f : 'all'))
    void load()
  }
  function startReply(ctx: ReplyTo) { setReplyTo(ctx); showEmailTab() }
  function emailSent() {
    setReplyTo(null)
    stick.current = true
    setFilter((f) => (f === 'all' || f === 'messages' ? f : 'all'))
    void load()
  }

  const connectHref = `/api/google/gmail/connect?back=${encodeURIComponent(backPath)}`

  if (status === 'loading') return <Loading onBack={onBack} />
  if (status !== 'ok' || !record) return <NotAvailable status={status} onBack={onBack} onRetry={() => { setStatus('loading'); void load() }} />

  const name = record.contact.name || record.contact.email || record.contact.phone || 'Unnamed lead'
  const stages = stagesForWorkspace(ws)
  const isAdmin = me.role === 'admin'
  const myLabel = me.email.split('@')[0]
  const unread = record.unreadReplies
  const overdue = record.openTasks.filter((t) => taskBucket(t.due_at) === 'overdue').length

  return (
    <main className="flex-1 min-w-0 min-h-0 h-full flex flex-col bg-white text-[13px] text-[#2f3941]">
      {/* ── Header strip ── */}
      <header className="shrink-0 min-h-[60px] px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#d8dcde]">
        <button type="button" onClick={onBack} className={BTN_PLAIN}><ArrowLeft size={15} aria-hidden />Back</button>
        <Avatar label={name} size={34} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[16px] font-semibold break-words">{name}</h1>
            <Chip tone={stageTone(record.stage)}>{CRM_STAGE_LABEL[record.stage]}</Chip>
            {record.notALead && <span title={`Marked by ${short(record.notALead.by)}`}><Chip tone="amber">Not a lead</Chip></span>}
            {canWa && record.waAwaitingReply && <span title="The customer wrote last on WhatsApp and nobody has answered yet"><Chip tone="green">WhatsApp waiting</Chip></span>}
            {overdue > 0 && canTasks && <Chip tone="red">{plural(overdue, 'task overdue', 'tasks overdue')}</Chip>}
          </div>
          <p className="text-[12px] text-[#68737d] truncate">
            {record.siteName} · {record.sourceLabel} · <span title={formatDateTime(record.createdAt)}>received {formatShortDateTime(record.createdAt)}</span>
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {unread > 0 && (
            <button type="button" onClick={markRepliesRead} disabled={readBusy} className={BTN_PLAIN}
              title="The customer has replied by email. Press to mark the replies as read.">
              <Inbox size={15} className="text-[#1f73b7]" aria-hidden />
              {readBusy ? 'Marking…' : `${plural(unread, 'new reply', 'new replies')} · Mark read`}
            </button>
          )}
          <span className="hidden md:inline text-[12px] text-[#68737d]" title="Counted from replies sent to this lead. Several replies in one sitting count once.">
            {record.followUps.count === 0 ? 'No follow-ups yet' : `${plural(record.followUps.count, 'follow-up', 'follow-ups')}${record.followUps.lastAt ? `, last ${timeAgo(record.followUps.lastAt)}` : ''}`}
          </span>
          {record.hasConversation && (
            <button type="button" onClick={() => openChat(record.id)} className={BTN_PLAIN}><MessageSquare size={15} aria-hidden />Open chat</button>
          )}
        </div>
        {readErr && <div className="basis-full"><Notice text={readErr} bad /></div>}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col min-[1100px]:flex-row min-[1100px]:overflow-hidden [scrollbar-width:thin]">
        {/* ── Left: customer and properties ── */}
        <aside aria-label="Customer and properties" className="min-[1100px]:w-[300px] min-[1100px]:shrink-0 min-[1100px]:overflow-y-auto border-b min-[1100px]:border-b-0 min-[1100px]:border-r border-[#d8dcde] bg-[#f8f9f9] p-4 space-y-5 [scrollbar-width:thin]">
          <section aria-label="Customer">
            <h2 className={SECTION}>Customer</h2>
            <div className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
              <EditableField label="Name" value={record.contact.name} placeholder="Add a name"
                edited={record.overriddenFields.includes('name')} captured={record.captured.name} onSave={(v) => saveField('name', v)} />
              <EditableField label="Email" value={record.contact.email} placeholder="Add an email address" inputType="email"
                href={record.contact.email && !record.contactsHidden ? `mailto:${record.contact.email}` : undefined}
                locked={!!record.contactsHidden}
                edited={record.overriddenFields.includes('email')} captured={record.captured.email} onSave={(v) => saveField('email', v)} />
              <EditableField label="Phone" value={record.contact.phone} placeholder="Add a phone number" inputType="tel"
                href={record.contact.phone && !record.contactsHidden ? `tel:${record.contact.phone.replace(/[^\d+]/g, '')}` : undefined}
                locked={!!record.contactsHidden}
                edited={record.overriddenFields.includes('phone')} captured={record.captured.phone} onSave={(v) => saveField('phone', v)} />
            </div>
          </section>

          <section aria-label="Properties" className="space-y-3">
            <h2 className={SECTION}>Properties</h2>
            <div>
              <label htmlFor="zd-stage" className={LABEL}>Stage</label>
              <select id="zd-stage" value={record.stage} onChange={(e) => changeStage(e.target.value as CrmStage)} className={SELECT}>
                {!stages.includes(record.stage) && <option value={record.stage}>{CRM_STAGE_LABEL[record.stage]}</option>}
                {stages.map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-[#87929d]">
                {record.stageAt ? `Changed ${timeAgo(record.stageAt)}` : 'Not changed yet'}
                {record.stageAt && record.stageBy ? ` by ${record.stageBy.includes('@') ? short(record.stageBy) : 'the assistant'}` : ''}
              </p>
              <Notice text={stageErr} bad />
            </div>
            <div>
              <label htmlFor="zd-owner" className={LABEL}>Owner</label>
              <select id="zd-owner" value={record.owner ?? ''} onChange={(e) => saveOwner(e.target.value)} className={SELECT}>
                <option value="">Unassigned</option>
                {record.owner && !record.assignableMembers.includes(record.owner) && <option value={record.owner}>{short(record.owner)}</option>}
                {record.assignableMembers.map((m) => <option key={m} value={m}>{short(m)}{m === me.email ? ' (you)' : ''}</option>)}
              </select>
              <Notice text={ownerErr} bad />
            </div>
            <div>
              <label htmlFor="zd-site" className={LABEL}>Site</label>
              {record.siteChoices.length > 1 ? (
                <select id="zd-site" value={record.siteId} onChange={(e) => saveSite(e.target.value)} disabled={siteBusy} className={SELECT}>
                  {!record.siteChoices.some((c) => c.id === record.siteId) && <option value={record.siteId}>{record.siteName}</option>}
                  {record.siteChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : (
                <p id="zd-site" className="h-9 px-2.5 rounded-md border border-[#e9ebed] bg-white flex items-center truncate">{record.siteName}</p>
              )}
              <Notice text={siteBusy ? 'Moving this lead…' : siteErr} bad={!siteBusy} />
            </div>
            <div>
              <p className={LABEL}>Source</p>
              <p className="h-9 px-2.5 rounded-md border border-[#e9ebed] bg-white flex items-center truncate">{record.sourceLabel}</p>
            </div>
            <DealValue key={`${record.value.estimated}|${record.value.won}|${record.value.currency}`} value={record.value} won={record.stage === 'won'} onSave={saveValue} />
            <Notice text={valueErr} bad />
          </section>

          <section aria-label="Dates">
            <h2 className={SECTION}>Dates</h2>
            <dl className="mt-2 space-y-1.5">
              <Fact label="Received" value={formatShortDateTime(record.createdAt)} title={formatDateTime(record.createdAt)} />
              <Fact label="First seen" value={formatShortDateTime(record.firstSeenAt)} title={formatDateTime(record.firstSeenAt)} />
              <Fact label="Last contacted" value={record.lastContactedAt ? formatShortDateTime(record.lastContactedAt) : 'Never'} title={record.lastContactedAt ? formatDateTime(record.lastContactedAt) : undefined} />
              <Fact label="Last reply" value={record.lastReplyAt ? formatShortDateTime(record.lastReplyAt) : 'None yet'} title={record.lastReplyAt ? formatDateTime(record.lastReplyAt) : undefined} />
              <Fact label="Last activity" value={record.lastActivityAt ? timeAgo(record.lastActivityAt) : 'None yet'} title={record.lastActivityAt ? formatDateTime(record.lastActivityAt) : undefined} />
            </dl>
          </section>

          <section aria-label="Counting">
            <h2 className={SECTION}>Counting</h2>
            <p className="mt-2 text-[12px] text-[#68737d]">
              {record.notALead
                ? 'This is marked as not a lead, so it is left out of the totals and reports. Nothing was deleted.'
                : 'A sales pitch, a duplicate or a mistake? Mark it and it stops counting in the totals and reports. Nothing is deleted.'}
            </p>
            <button type="button" onClick={toggleNotALead} disabled={markBusy} className={`${BTN_PLAIN} mt-2`}>
              {markBusy ? 'Saving…' : record.notALead ? 'Count it as a lead again' : 'Mark as not a lead'}
            </button>
            <div className="mt-1"><Notice text={markErr} bad /></div>
          </section>
        </aside>

        {/* ── Center: history and reply ── */}
        <section aria-label="Conversation and history" className="order-first min-[1100px]:order-none min-w-0 flex flex-col min-[1100px]:flex-1 min-[1100px]:min-h-0 border-b min-[1100px]:border-b-0 border-[#d8dcde]">
          <HistoryPane
            paneRef={pane} events={record.timeline} filter={filter} onFilter={setFilter} leadId={record.id} customer={name}
            currency={record.value.currency} myLabel={myLabel} isAdmin={isAdmin} canEmail={canEmail}
            onReply={startReply} onRetryFile={retryFile} onEditNote={editNote} onDeleteNote={deleteNote}
            banner={canEmail && hasSentEmail && gmail?.connected && gmail.canReadReplies === false ? (
              <div className="mx-5 mt-3 rounded-md border border-[#f1dfb4] bg-[#fff8e6] px-3 py-2 text-[12px] text-[#703815]">
                <b>Replies to this lead will not appear here.</b> Your Gmail connection cannot read replies yet. Sending still works.{' '}
                <a href={connectHref} className="font-semibold underline">Reconnect Gmail</a> to switch it on.
              </div>
            ) : null}
          />

          <div className="shrink-0 border-t border-[#d8dcde] bg-[#f8f9f9]">
            <div role="tablist" aria-label="Write" className="px-5 pt-2 flex gap-1">
              {canEmail && (
                <button type="button" role="tab" id="zd-tab-email" aria-selected={tab === 'email'} aria-controls="zd-panel-email" onClick={showEmailTab}
                  className={`h-8 px-3 rounded-t-md text-[13px] font-medium inline-flex items-center gap-1.5 border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${tab === 'email' ? 'border-[#1f73b7] text-[#1f73b7]' : 'border-transparent text-[#68737d] hover:text-[#2f3941]'}`}>
                  <Mail size={14} aria-hidden />Email
                </button>
              )}
              {canWa && (
                <button type="button" role="tab" id="zd-tab-wa" aria-selected={tab === 'whatsapp'} aria-controls="zd-panel-wa" onClick={() => pickTab('whatsapp')}
                  disabled={!waReady} aria-describedby={waReady ? undefined : 'zd-wa-off'}
                  className={`h-8 px-3 rounded-t-md text-[13px] font-medium inline-flex items-center gap-1.5 border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 disabled:opacity-50 disabled:cursor-not-allowed ${tab === 'whatsapp' ? 'border-[#038153] text-[#038153]' : 'border-transparent text-[#68737d] enabled:hover:text-[#2f3941]'}`}>
                  <MessageCircle size={14} aria-hidden />WhatsApp
                </button>
              )}
              <button type="button" role="tab" id="zd-tab-note" aria-selected={tab === 'note'} aria-controls="zd-panel-note" onClick={() => pickTab('note')}
                className={`h-8 px-3 rounded-t-md text-[13px] font-medium inline-flex items-center gap-1.5 border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${tab === 'note' ? 'border-[#ad5918] text-[#ad5918]' : 'border-transparent text-[#68737d] hover:text-[#2f3941]'}`}>
                <StickyNote size={14} aria-hidden />Note
              </button>
            </div>
            {canWa && !waReady && <p id="zd-wa-off" className="px-5 pt-1 text-[12px] text-[#68737d]">WhatsApp is off for this lead because it has no phone number. Add one under Customer.</p>}
            {waReady && (
              <div id="zd-panel-wa" role="tabpanel" aria-labelledby="zd-tab-wa" hidden={tab !== 'whatsapp'} className="px-5 pb-3 pt-2">
                <WhatsAppBox leadId={record.id} events={record.timeline} canEmail={canEmail && !!record.contact.email} onSent={waSent} />
              </div>
            )}
            <div id="zd-panel-note" role="tabpanel" aria-labelledby="zd-tab-note" hidden={tab !== 'note'} className="px-5 pb-3 pt-2">
              <NoteBox onAdd={addNote} />
            </div>
            {emailMounted && (
              <div id="zd-panel-email" role="tabpanel" aria-labelledby="zd-tab-email" hidden={tab !== 'email'} className="px-5 pb-3 pt-2">
                <EmailBox leadId={record.id} leadEmail={record.contact.email} siteId={record.siteId} siteName={record.siteName}
                  contactsHidden={!!record.contactsHidden} recipientLocked={!!record.recipientLocked}
                  gmail={gmail} connectHref={connectHref} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSent={emailSent} />
              </div>
            )}
          </div>
        </section>

        {/* ── Right: tasks, visit, files ── */}
        <aside aria-label="Tasks and details" className="min-[1100px]:w-[300px] min-[1100px]:shrink-0 min-[1100px]:overflow-y-auto min-[1100px]:border-l border-[#d8dcde] bg-[#f8f9f9] p-4 space-y-5 [scrollbar-width:thin]">
          {canTasks && (
            <TasksPanel openTasks={record.openTasks} doneTasks={record.doneTasks} members={record.assignableMembers} me={me.email} isAdmin={isAdmin}
              busyIds={taskBusy} error={taskErr} onCreate={createTask} onToggle={toggleTask} onReassign={reassignTask} onDelete={deleteTask} />
          )}

          <section aria-label="Visit details">
            <h2 className={SECTION}>Visit details</h2>
            <ul className="mt-2 space-y-1.5">
              <IconFact icon={<MapPin size={14} />} text={[visit?.technical?.city, visit?.technical?.country || record.country].filter(Boolean).join(', ') || 'Location not known'} />
              {visit?.technical && <IconFact icon={<Monitor size={14} />} text={[visit.technical.browser, visit.technical.os, visit.technical.device_type].filter(Boolean).join(' · ') || 'Device not known'} />}
              <IconFact icon={<Globe size={14} />} text={record.referrer ? `Came from ${hostOf(record.referrer)}` : 'No referring site recorded'} title={record.referrer ?? undefined} />
              {visit?.stats && <IconFact icon={<History size={14} />} text={`${plural(visit.stats.visits, 'visit', 'visits')} · ${plural(visit.stats.chats, 'chat', 'chats')}`} />}
              <IconFact icon={<MessageSquare size={14} />} text={record.hasConversation ? plural(record.messageCount, 'chat message', 'chat messages') : 'Arrived by email or form, so there is no chat'} />
            </ul>
            {record.tags.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-1" aria-label="Tags">{record.tags.map((t) => <Chip key={t}>{t}</Chip>)}</p>
            )}
            {!!visit?.path?.length && (
              <>
                <h3 className="mt-3 text-[12px] font-semibold text-[#49545c]">Pages viewed</h3>
                <ol className="mt-1 space-y-1 text-[12px]">
                  {visit.path.slice(-8).map((p, i) => (
                    <li key={i} className="truncate" title={p.url ?? ''}>{p.title || (p.url ?? '').replace(/^https?:\/\/[^/]+/, '') || 'Page'}</li>
                  ))}
                </ol>
              </>
            )}
          </section>

          {record.quoteMessage && (
            <section aria-label="Original request">
              <h2 className={SECTION}>{record.kind === 'checkout' ? 'Order email' : record.kind === 'call' ? 'Phone call' : record.kind === 'whatsapp' ? 'First message' : 'Original request'}</h2>
              <LongText text={record.quoteMessage} />
            </section>
          )}

          <section aria-label="Files">
            <h2 className={SECTION}>Files <span className="tabular-nums font-normal">({record.attachments.length})</span></h2>
            {record.attachments.length === 0 ? <p className="mt-2 text-[12px] text-[#68737d]">No files have been shared in the chat.</p> : (
              <ul className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
                {record.attachments.map((f) => (
                  <li key={f.url}>
                    <a href={f.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-3 py-2 hover:bg-[#f8f9f9] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
                      {isImageMime(f.mime)
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={f.url} alt="" className="w-8 h-8 rounded object-cover shrink-0 border border-[#d8dcde]" />
                        : <span className="w-8 h-8 rounded bg-[#e9ebed] flex items-center justify-center shrink-0" aria-hidden><FileText size={14} /></span>}
                      <span className="min-w-0">
                        <span className="block truncate text-[#1f73b7]" title={f.name}>{f.name}</span>
                        <span className="block text-[11px] text-[#87929d]" title={formatDateTime(f.at)}>{f.by} · {formatShortDateTime(f.at)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Other leads from this customer">
            <h2 className={SECTION}>Other leads from this customer <span className="tabular-nums font-normal">({record.related.length})</span></h2>
            {record.related.length === 0 ? <p className="mt-2 text-[12px] text-[#68737d]">No other lead shares this email address or phone number.</p> : (
              <ul className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
                {record.related.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => openLead(r.id)} className="w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-[#f8f9f9] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium">{r.name || r.email || r.phone || 'Lead'}</span>
                          <Chip>{r.kind === 'chat' ? 'Chat' : r.kind === 'call' ? 'Call' : r.kind === 'whatsapp' ? 'WhatsApp' : r.kind === 'quote' ? 'Quote' : r.kind === 'reorder' ? 'Reorder' : 'Order'}</Chip>
                        </span>
                        <span className="block truncate text-[11px] text-[#87929d]" title={formatDateTime(r.at)}>{r.siteName} · {formatShortDateTime(r.at)}</span>
                      </span>
                      <ChevronRight size={14} className="shrink-0 text-[#87929d]" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-[11px] text-[#87929d] break-all" title="Record reference">Reference: {record.id}</p>
        </aside>
      </div>

      {lostAsk && (
        <LostDialog busy={lostAsk.busy} error={lostAsk.err} onCancel={() => setLostAsk(null)}
          onConfirm={(reason, note) => changeStage('lost', { reason, note })} />
      )}
    </main>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return <div className="flex gap-2 text-[12px]"><dt className="w-[92px] shrink-0 text-[#68737d]">{label}</dt><dd className="min-w-0 break-words tabular-nums" title={title}>{value}</dd></div>
}

function IconFact({ icon, text, title }: { icon: React.ReactNode; text: string; title?: string }) {
  return <li className="flex items-start gap-2 text-[12px]" title={title}><span className="mt-0.5 text-[#68737d]" aria-hidden>{icon}</span><span className="min-w-0 break-words">{text}</span></li>
}

function LongText({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const clean = text.trim()
  const long = clean.length > 420 || clean.split('\n').length > 9
  return (
    <div className={`${CARD} mt-2 px-3 py-2`}>
      <p className={`text-[12px] leading-5 whitespace-pre-wrap break-words ${long && !open ? 'line-clamp-[9]' : ''}`}>{clean}</p>
      {long && <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${LINK} mt-1 text-[12px] font-medium`}>{open ? 'Show less' : 'Show all of it'}</button>}
    </div>
  )
}

function Loading({ onBack }: { onBack: () => void }) {
  const bar = 'rounded bg-[#e9ebed] animate-pulse'
  return (
    <main className="flex-1 min-w-0 min-h-0 h-full flex flex-col bg-white text-[13px] text-[#2f3941]" aria-busy="true">
      <header className="shrink-0 h-[60px] px-4 flex items-center gap-3 border-b border-[#d8dcde]">
        <button type="button" onClick={onBack} className={BTN_PLAIN}><ArrowLeft size={15} aria-hidden />Back</button>
        <span className={`${bar} w-9 h-9 rounded-full`} />
        <span className="space-y-1.5"><span className={`${bar} block h-3.5 w-44`} /><span className={`${bar} block h-2.5 w-64`} /></span>
      </header>
      <div className="flex-1 min-h-0 overflow-hidden min-[1100px]:flex">
        <div className="min-[1100px]:w-[300px] p-4 space-y-3 bg-[#f8f9f9] border-r border-[#d8dcde]">{[0, 1, 2, 3, 4].map((i) => <span key={i} className={`${bar} block h-9`} />)}</div>
        <div className="flex-1 p-5 space-y-4">{[0, 1, 2, 3].map((i) => <div key={i} className="flex gap-3"><span className={`${bar} w-7 h-7 rounded-full shrink-0`} /><span className="flex-1 space-y-1.5"><span className={`${bar} block h-3 w-1/3`} /><span className={`${bar} block h-12`} /></span></div>)}</div>
        <div className="hidden min-[1100px]:block w-[300px] p-4 space-y-3 bg-[#f8f9f9] border-l border-[#d8dcde]">{[0, 1, 2].map((i) => <span key={i} className={`${bar} block h-14`} />)}</div>
      </div>
      <span className="sr-only" role="status">Loading this lead…</span>
    </main>
  )
}

function NotAvailable({ status, onBack, onRetry }: { status: Status; onBack: () => void; onRetry: () => void }) {
  const copy = status === 'forbidden'
    ? { icon: <Lock size={22} aria-hidden />, title: 'You do not have access to this lead', hint: 'It belongs to a site outside the ones assigned to you, or lead records are not switched on for your team. Ask an admin if you need it.' }
    : status === 'missing'
      ? { icon: <Search size={22} aria-hidden />, title: 'This lead could not be found', hint: 'It may have been removed, or the link that brought you here is wrong.' }
      : { icon: <TriangleAlert size={22} aria-hidden />, title: 'This lead did not load', hint: 'Something went wrong while fetching it. Try again in a moment.' }
  return (
    <main className="flex-1 min-w-0 h-full flex flex-col items-center justify-center text-center px-6 bg-white text-[13px] text-[#2f3941]">
      <div className="w-14 h-14 rounded-full bg-[#e9ebed] text-[#49545c] flex items-center justify-center mb-4">{copy.icon}</div>
      <h1 className="text-[16px] font-semibold">{copy.title}</h1>
      <p role={status === 'error' ? 'alert' : undefined} className="mt-1 text-[#68737d] max-w-sm">{copy.hint}</p>
      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onBack} className={BTN_PLAIN}><ArrowLeft size={15} aria-hidden />Back</button>
        {status === 'error' && <button type="button" onClick={onRetry} className={BTN_PRIMARY}><RefreshCw size={14} aria-hidden />Try again</button>}
      </div>
    </main>
  )
}

// One contact detail. Reads as text until Edit is pressed; a refused save
// stays open with the reason under it, and the value on the card goes back.
function EditableField({ label, value, placeholder, href, locked, edited, captured, inputType = 'text', onSave }: {
  label: string; value: string; placeholder: string; href?: string; locked?: boolean; edited: boolean; captured: string
  inputType?: 'text' | 'email' | 'tel'; onSave: (value: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fieldId = `zd-contact-${label.toLowerCase()}`

  async function save() {
    const next = draft.trim()
    if (busy) return
    if (next === value) { setEditing(false); return }
    setBusy(true); setErr('')
    try { await onSave(next); setEditing(false) } catch (e) { setErr(errText(e, 'That did not save.')) } finally { setBusy(false) }
  }

  if (editing) {
    return (
      <div className="px-3 py-2">
        <label htmlFor={fieldId} className={LABEL}>{label}</label>
        <input id={fieldId} type={inputType} value={draft} autoFocus maxLength={200} placeholder={placeholder} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save() } if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setErr('') } }}
          className={INPUT} />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={save} disabled={busy} className={BTN_PRIMARY}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => { setEditing(false); setErr('') }} disabled={busy} className={BTN_PLAIN}>Cancel</button>
        </div>
        <div className="mt-1"><Notice text={err} bad /></div>
      </div>
    )
  }
  return (
    <div className="px-3 py-2 flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">
          {label}
          {edited && <span className="ml-1.5 normal-case tracking-normal font-normal text-[#87929d]" title={captured ? `The customer first gave: ${captured}` : 'Changed by your team'}>edited</span>}
        </p>
        {value
          ? href ? <a href={href} className={`${LINK} break-all`}>{value}</a> : <p className="break-words">{value}</p>
          : <p className="text-[#87929d]">Not given</p>}
      </div>
      {locked
        ? <span className="mt-1 text-[#87929d]" title="Contact details are hidden for your account. Emails you send still reach the customer."><Lock size={14} aria-label="Hidden for your account" /></span>
        : <button type="button" onClick={() => { setDraft(value); setErr(''); setEditing(true) }} className={ICON_BTN} aria-label={`Edit ${label.toLowerCase()}`} title={`Edit ${label.toLowerCase()}`}><Pencil size={14} /></button>}
    </div>
  )
}

// What the deal is worth. Saved when a box is left, and only if it changed.
function DealValue({ value, won, onSave }: {
  value: { estimated: number | null; won: number | null; currency: CrmCurrency }; won: boolean
  onSave: (v: { estimated: number | null; won: number | null; currency: CrmCurrency }) => Promise<void>
}) {
  const [estimated, setEstimated] = useState(value.estimated?.toString() ?? '')
  const [wonText, setWonText] = useState(value.won?.toString() ?? '')
  const [currency, setCurrency] = useState<CrmCurrency>(value.currency)
  const num = (v: string) => {
    const n = Number(v.replace(/[^0-9.]/g, ''))
    return v.trim() === '' || !isFinite(n) ? null : n
  }
  function commit(cur: CrmCurrency = currency) {
    const next = { estimated: num(estimated), won: num(wonText), currency: cur }
    if (next.estimated === value.estimated && next.won === value.won && next.currency === value.currency) return
    void onSave(next)
  }
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur() }
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="zd-estimated" className={LABEL}>Estimated value</label>
        <div className="flex gap-2">
          <div className="flex-1 flex items-center h-9 rounded-md bg-white border border-[#d8dcde] focus-within:border-[#1f73b7]">
            <span className="pl-2.5 text-[#68737d]" aria-hidden>{CURRENCY_SYMBOL[currency]}</span>
            <input id="zd-estimated" inputMode="decimal" value={estimated} placeholder="0" onChange={(e) => setEstimated(e.target.value)} onBlur={() => commit()} onKeyDown={blurOnEnter}
              className="flex-1 min-w-0 h-full px-1.5 bg-transparent outline-none tabular-nums placeholder:text-[#87929d]" />
          </div>
          <select aria-label="Currency" value={currency} onChange={(e) => { const c = e.target.value as CrmCurrency; setCurrency(c); commit(c) }} className={`${SELECT} !w-[76px]`}>
            {CRM_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      {won ? (
        <div>
          <label htmlFor="zd-won" className={LABEL}>Won amount</label>
          <div className="flex items-center h-9 rounded-md bg-white border border-[#d8dcde] focus-within:border-[#038153]">
            <span className="pl-2.5 text-[#038153]" aria-hidden>{CURRENCY_SYMBOL[currency]}</span>
            <input id="zd-won" inputMode="decimal" value={wonText} placeholder="0" onChange={(e) => setWonText(e.target.value)} onBlur={() => commit()} onKeyDown={blurOnEnter}
              className="flex-1 min-w-0 h-full px-1.5 bg-transparent outline-none tabular-nums placeholder:text-[#87929d]" />
          </div>
        </div>
      ) : <p className="text-[11px] text-[#87929d]">The won amount can be entered once the stage is Won.</p>}
    </div>
  )
}

function LostDialog({ busy, error, onCancel, onConfirm }: { busy: boolean; error: string; onCancel: () => void; onConfirm: (reason: LostReason, note: string) => void }) {
  const [reason, setReason] = useState<LostReason | ''>('')
  const [note, setNote] = useState('')
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="zd-lost-title"
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel() }}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-[#2f3941]/30 cursor-default" onClick={() => { if (!busy) onCancel() }} />
      <div className="relative w-full max-w-md rounded-lg bg-white border border-[#d8dcde] shadow-xl">
        <div className="px-5 py-4 border-b border-[#d8dcde]">
          <h2 id="zd-lost-title" className="text-[15px] font-semibold">Why was this lead lost?</h2>
          <p className="mt-0.5 text-[12px] text-[#68737d]">Pick the closest reason. The stage changes once you confirm.</p>
        </div>
        <fieldset className="px-5 py-3 space-y-1.5">
          <legend className="sr-only">Reason</legend>
          {LOST_REASONS.map((r, i) => (
            <label key={r.key} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="zd-lost-reason" value={r.key} checked={reason === r.key} autoFocus={i === 0} onChange={() => setReason(r.key)} className="accent-[#1f73b7]" />
              {r.label}
            </label>
          ))}
          <label htmlFor="zd-lost-note" className={`${LABEL} !mt-3`}>Anything to add (optional)</label>
          <textarea id="zd-lost-note" rows={2} value={note} maxLength={MAX_LOST_NOTE} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
          <Notice text={error} bad />
        </fieldset>
        <div className="px-5 py-3 border-t border-[#d8dcde] bg-[#f8f9f9] rounded-b-lg flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className={BTN_PLAIN}>Cancel</button>
          <button type="button" onClick={() => { if (reason) onConfirm(reason, note.trim()) }} disabled={busy || !reason} className={BTN_PRIMARY}>{busy ? 'Saving…' : 'Move to Lost'}</button>
        </div>
      </div>
    </div>
  )
}

// ── History ──────────────────────────────────────────────────────────────────
// Everything that happened on the lead, oldest at the top and newest next to
// the reply box. Messages, emails and notes are full entries; stage moves,
// assignments and task changes are single quiet lines between them.

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'messages', label: 'Conversation' },
  { key: 'notes', label: 'Notes' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'updates', label: 'Updates' },
]
const filterOf = (e: TimelineEvent): FilterKey => (e.group === 'messages' ? 'messages' : e.group === 'notes' ? 'notes' : e.group === 'tasks' ? 'tasks' : 'updates')

function HistoryPane({ paneRef, events, filter, onFilter, leadId, customer, currency, myLabel, isAdmin, canEmail, banner, onReply, onRetryFile, onEditNote, onDeleteNote }: {
  paneRef: React.RefObject<HTMLDivElement | null>
  events: TimelineEvent[]; filter: FilterKey; onFilter: (f: FilterKey) => void; leadId: string; customer: string; currency: CrmCurrency
  myLabel: string; isAdmin: boolean; canEmail: boolean; banner: React.ReactNode
  onReply: (ctx: ReplyTo) => void
  onRetryFile: (gmailId: string, name: string) => Promise<void>
  onEditNote: (noteId: string, body: string) => Promise<void>
  onDeleteNote: (noteId: string) => Promise<void>
}) {
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: events.length, messages: 0, notes: 0, tasks: 0, updates: 0 }
    for (const e of events) c[filterOf(e)]++
    return c
  }, [events])

  // The server sends newest first; a ticket reads top to bottom.
  const rows = useMemo(() => {
    const shown = (filter === 'all' ? events : events.filter((e) => filterOf(e) === filter)).slice().reverse()
    const labels = shown.map((event) => dateDividerLabel(event.at))
    return shown.map((event, i) => ({ event, day: i > 0 && labels[i] === labels[i - 1] ? null : labels[i] }))
  }, [events, filter])

  return (
    <>
      <div className="shrink-0 px-5 py-2 flex flex-wrap items-center gap-1 border-b border-[#e9ebed]" role="tablist" aria-label="Show in the history">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} onClick={() => onFilter(f.key)}
            className={`h-7 px-2.5 rounded-md text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${filter === f.key ? 'bg-[#edf7ff] text-[#1f73b7]' : 'text-[#68737d] hover:bg-[#f8f9f9]'}`}>
            {f.label} <span className="tabular-nums opacity-80">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {banner}
      <div ref={paneRef} className="px-5 py-3 max-h-[70vh] overflow-y-auto min-[1100px]:max-h-none min-[1100px]:flex-1 min-[1100px]:min-h-0 [scrollbar-width:thin]">
        {rows.length === 0 ? (
          <Empty text={filter === 'all' ? 'Nothing has happened on this lead yet. Messages, emails, notes and changes appear here.' : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} on this lead yet.`} />
        ) : (
          <ol>
            {rows.map(({ event: e, day }) => (
              <li key={e.id}>
                {day && (
                  <div className="flex items-center gap-3 py-2">
                    <span className="flex-1 h-px bg-[#e9ebed]" />
                    <span className="text-[11px] font-medium text-[#68737d]">{day}</span>
                    <span className="flex-1 h-px bg-[#e9ebed]" />
                  </div>
                )}
                <EventRow e={e} leadId={leadId} customer={customer} currency={currency} canEmail={canEmail}
                  canEditNote={!!e.noteId && e.actor === myLabel} canDeleteNote={!!e.noteId && isAdmin}
                  onReply={onReply} onRetryFile={onRetryFile} onEditNote={onEditNote} onDeleteNote={onDeleteNote} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  )
}

const QUIET_ICON: Partial<Record<TimelineEvent['kind'], React.ReactNode>> = {
  created: <Sparkles size={13} />, stage: <Target size={13} />, assign: <UserCheck size={13} />, field: <Pencil size={13} />,
  value: <Banknote size={13} />, task: <CircleCheck size={13} />, note: <StickyNote size={13} />,
}

function describeValue(body: string, fallback: CrmCurrency): string {
  try {
    const o = JSON.parse(body)
    const cur = (o.currency ?? fallback) as CrmCurrency
    const parts: string[] = []
    if (o.estimated !== null && o.estimated !== undefined) parts.push(`estimated ${formatMoney(o.estimated, cur)}`)
    if (o.won !== null && o.won !== undefined) parts.push(`won ${formatMoney(o.won, cur)}`)
    return parts.length ? parts.join(' · ') : 'cleared'
  } catch { return body }
}

function EventRow({ e, leadId, customer, currency, canEmail, canEditNote, canDeleteNote, onReply, onRetryFile, onEditNote, onDeleteNote }: {
  e: TimelineEvent; leadId: string; customer: string; currency: CrmCurrency; canEmail: boolean; canEditNote: boolean; canDeleteNote: boolean
  onReply: (ctx: ReplyTo) => void
  onRetryFile: (gmailId: string, name: string) => Promise<void>
  onEditNote: (noteId: string, body: string) => Promise<void>
  onDeleteNote: (noteId: string) => Promise<void>
}) {
  const time = <time className="ml-auto shrink-0 text-[11px] text-[#87929d] tabular-nums" title={formatDateTime(e.at)}>{formatTime(e.at)}</time>
  const actor = e.actor === 'Visitor' || e.actor === 'Customer' ? customer : short(e.actor) || e.actor

  // ── Quiet lines: a change, not something anyone said ──
  const quiet = e.kind === 'created' || e.kind === 'stage' || e.kind === 'assign' || e.kind === 'field' || e.kind === 'value' || e.kind === 'task' || (e.kind === 'note' && !e.body)
  if (quiet) {
    const prev = e.kind === 'stage' && e.body ? (CRM_STAGE_LABEL[e.body as CrmStage] ?? e.body) : ''
    return (
      <div className="flex items-start gap-2 py-1.5 text-[12px] text-[#68737d]">
        <span className="mt-0.5 shrink-0" aria-hidden>{QUIET_ICON[e.kind]}</span>
        <p className="min-w-0 break-words">
          <span className="font-medium text-[#49545c]">{e.title}</span>
          {e.kind === 'stage' && e.stage && <> to <Chip tone={stageTone(e.stage)}>{CRM_STAGE_LABEL[e.stage]}</Chip>{prev ? ` from ${prev}` : ''}</>}
          {e.kind === 'task' && e.body && <>: <span className={e.taskDone ? 'line-through' : 'text-[#2f3941]'}>{e.body}</span>{e.taskType ? ` (${TASK_TYPE_LABEL[e.taskType]})` : ''}</>}
          {e.kind === 'value' && e.body && <>: <span className="tabular-nums">{describeValue(e.body, currency)}</span></>}
          {(e.kind === 'field' || e.kind === 'created') && e.body && <>: {e.body}</>}
          {e.kind !== 'created' && <> · {actor}</>}
        </p>
        {time}
      </div>
    )
  }

  const fromCustomer = e.kind === 'email_in' || e.kind === 'wa_in' || e.actor === 'Visitor' || e.actor === 'Customer'
  const fromBot = (e.kind === 'message' && e.title === 'Bot replied') || (e.kind === 'wa_out' && !!e.wa?.bot)
  const waFailed = e.kind === 'wa_out' && (e.wa?.status === 'failed' || e.wa?.status === 'undelivered')
  const who = e.kind === 'email_in' && e.inbound ? (e.inbound.fromName || customer)
    : e.kind === 'email' && e.email ? (short(e.email.sentBy) || actor)
    : fromBot ? 'Assistant' : actor
  const channel = e.kind === 'message' ? 'Chat'
    : e.kind === 'note' ? 'Internal note'
    : e.kind === 'email' ? 'Email sent'
    : e.kind === 'email_in' ? 'Email received'
    : e.kind === 'wa_out' || e.kind === 'wa_in' ? 'WhatsApp'
    : e.kind === 'call' ? 'Phone call'
    : 'File'
  const box = e.kind === 'note' ? 'bg-[#fff8e6] border-[#f1dfb4]'
    : e.kind === 'email_in' && e.unread ? 'bg-[#edf7ff] border-[#1f73b7]'
    : waFailed ? 'bg-[#fff0f1] border-[#cc3340]'
    : fromCustomer ? 'bg-[#f8f9f9] border-[#e9ebed]' : 'bg-white border-[#d8dcde]'

  return (
    <article className="flex gap-3 py-2.5">
      <Avatar label={who} tone={fromBot ? 'bot' : fromCustomer ? 'visitor' : 'agent'} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold truncate">{who}</span>
          <span className="text-[12px] text-[#68737d] shrink-0">{channel}</span>
          {e.kind === 'email_in' && e.unread && <Chip tone="blue">New</Chip>}
          {time}
        </div>
        <div className={`mt-1 rounded-md border px-3 py-2 ${box}`}>
          {e.kind === 'note' ? (
            <NoteBody e={e} canEdit={canEditNote} canDelete={canDeleteNote} onEdit={onEditNote} onDelete={onDeleteNote} />
          ) : e.kind === 'email' && e.email ? (
            <SentEmail entry={e.email} files={e.files} />
          ) : e.kind === 'email_in' && e.inbound ? (
            <ReceivedEmail entry={e.inbound} files={e.files} canReply={canEmail} onReply={onReply} onRetryFile={onRetryFile} />
          ) : e.kind === 'attachment' && e.attachment ? (
            <a href={e.attachment.url} target="_blank" rel="noopener noreferrer" className={`${LINK} inline-flex items-center gap-2 max-w-full`}>
              {isImageMime(e.attachment.mime)
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={e.attachment.url} alt="" className="w-9 h-9 rounded object-cover shrink-0" />
                : <Paperclip size={14} className="shrink-0" aria-hidden />}
              <span className="truncate">{e.attachment.name}</span>
            </a>
          ) : e.kind === 'wa_in' || e.kind === 'wa_out' ? (
            <WhatsAppMessage e={e} leadId={leadId} />
          ) : e.kind === 'call' ? (
            <>
              <p>{e.title}</p>
              {e.call?.recordingSid && (
                <audio controls preload="none" className="mt-1.5 w-full max-w-sm h-9" aria-label="Call recording"
                  src={`/api/leads/${encodeURIComponent(e.callLeadId ?? leadId)}/call/recording?sid=${encodeURIComponent(e.call.recordingSid)}`} />
              )}
            </>
          ) : (
            <p className="whitespace-pre-wrap break-words leading-5">{e.body || e.title}</p>
          )}
        </div>
      </div>
    </article>
  )
}

function NoteBody({ e, canEdit, canDelete, onEdit, onDelete }: {
  e: TimelineEvent; canEdit: boolean; canDelete: boolean
  onEdit: (noteId: string, body: string) => Promise<void>; onDelete: (noteId: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'read' | 'edit' | 'confirm'>('read')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true); setErr('')
    try { await action(); setMode('read') } catch (x) { setErr(errText(x, fallback)) } finally { setBusy(false) }
  }

  if (mode === 'edit') {
    return (
      <div>
        <textarea value={draft} rows={3} autoFocus aria-label="Edit note" onChange={(ev) => setDraft(ev.target.value)} className={`${TEXTAREA} resize-y`} />
        <div className="mt-2 flex items-center gap-2">
          <button type="button" disabled={busy || !draft.trim()} className={BTN_PRIMARY}
            onClick={() => { if (e.noteId) void run(() => onEdit(e.noteId!, draft.trim()), 'The note did not save.') }}>{busy ? 'Saving…' : 'Save note'}</button>
          <button type="button" disabled={busy} onClick={() => { setMode('read'); setErr('') }} className={BTN_PLAIN}>Cancel</button>
        </div>
        <div className="mt-1"><Notice text={err} bad /></div>
      </div>
    )
  }
  return (
    <div>
      <p className="whitespace-pre-wrap break-words leading-5">{e.body}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[12px]">
        <span className="text-[#87929d]">Only your team sees this{e.editedAt ? ` · edited ${timeAgo(e.editedAt)}` : ''}</span>
        {mode === 'read' && (canEdit || canDelete) && (
          <span className="ml-auto flex items-center gap-3">
            {canEdit && <button type="button" onClick={() => { setDraft(e.body ?? ''); setErr(''); setMode('edit') }} className={LINK}>Edit</button>}
            {canDelete && <button type="button" onClick={() => { setErr(''); setMode('confirm') }} className="text-[#cc3340] hover:underline outline-none focus-visible:ring-2 focus-visible:ring-[#cc3340]/40 rounded">Delete</button>}
          </span>
        )}
      </div>
      {mode === 'confirm' && (
        <div className="mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Confirm deleting this note">
          <span className="text-[12px]">Delete this note? The history keeps a line saying it was removed.</span>
          <button type="button" disabled={busy} className={BTN_DANGER}
            onClick={() => { if (e.noteId) void run(() => onDelete(e.noteId!), 'The note was not deleted.') }}><Trash2 size={14} aria-hidden />{busy ? 'Deleting…' : 'Delete note'}</button>
          <button type="button" disabled={busy} onClick={() => setMode('read')} className={BTN_PLAIN}>Keep it</button>
        </div>
      )}
      <div className="mt-1"><Notice text={err} bad /></div>
    </div>
  )
}

function QuotedFold({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const clean = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  return (
    <div className="mt-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${LINK} inline-flex items-center gap-1 text-[12px]`}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{open ? 'Hide earlier messages' : 'Show earlier messages'}
      </button>
      {open && <p className="mt-1 pl-2.5 border-l-2 border-[#d8dcde] text-[12px] text-[#68737d] whitespace-pre-wrap break-words leading-5">{clean}</p>}
    </div>
  )
}

function SentEmail({ entry, files }: { entry: NonNullable<TimelineEvent['email']>; files: TimelineEvent['files'] }) {
  const [open, setOpen] = useState(false)
  const hasMore = entry.body.trim() !== entry.snippet
  return (
    <div>
      <p className="font-semibold break-words">{entry.subject || '(no subject)'}</p>
      <p className="mt-0.5 text-[12px] text-[#68737d] break-words">
        From {entry.from} to {entry.to}{entry.cc ? `, cc ${entry.cc}` : ''}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
        {entry.imported
          ? <span title="Sent straight from Gmail and brought in afterward, so it has no open tracking"><Chip>Sent from Gmail</Chip></span>
          : entry.openedAt
            ? <span title={`First opened ${formatDateTime(entry.openedAt)}`}><Chip tone="green">Opened {timeAgo(entry.openedAt)}{(entry.opens ?? 0) > 1 ? ` · ${entry.opens} times` : ''}</Chip></span>
            : <span className="text-[#87929d]" title="Some mail apps hide images, so this can stay blank even after the email is read">Not opened yet</span>}
        {entry.bot && <span title="Written and sent automatically, in this agent's name"><Chip>Sent automatically</Chip></span>}
      </p>
      {open ? (
        // Sanitized by the server when it was sent and again when it is read.
        entry.html
          ? <div className="mt-1.5 break-words leading-5 overflow-x-auto [&_a]:text-[#1f73b7] [&_a]:underline [&_p]:my-1 [&_img]:max-w-full" dangerouslySetInnerHTML={{ __html: entry.html }} />
          : <p className="mt-1.5 whitespace-pre-wrap break-words leading-5">{entry.body}</p>
      ) : <p className="mt-1.5 break-words leading-5">{entry.snippet}</p>}
      {hasMore && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${LINK} mt-1 inline-flex items-center gap-1 text-[12px]`}>
          {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{open ? 'Show less' : 'Show the whole email'}
        </button>
      )}
      {entry.quoted && <QuotedFold text={entry.quoted} />}
      <EmailFiles files={files} />
    </div>
  )
}

function ReceivedEmail({ entry, files, canReply, onReply, onRetryFile }: {
  entry: NonNullable<TimelineEvent['inbound']>; files: TimelineEvent['files']; canReply: boolean
  onReply: (ctx: ReplyTo) => void; onRetryFile: (gmailId: string, name: string) => Promise<void>
}) {
  return (
    <div>
      <p className="font-semibold break-words">{entry.subject || '(no subject)'}</p>
      <p className="mt-0.5 text-[12px] text-[#68737d] break-words">From {entry.fromName ? `${entry.fromName} <${entry.from}>` : entry.from}{entry.cc ? `, cc ${entry.cc}` : ''}</p>
      {entry.textless || !entry.body.trim()
        ? <p className="mt-1.5 text-[#68737d] italic">No message text. See the attachment below.</p>
        : <p className="mt-1.5 whitespace-pre-wrap break-words leading-5">{entry.body}</p>}
      {entry.quoted && <QuotedFold text={entry.quoted} />}
      <EmailFiles files={files} skipped={entry.skippedAttachments} gmailId={entry.gmailId} onRetryFile={onRetryFile} />
      {canReply && (
        <button type="button" className={`${BTN_PLAIN} mt-2`}
          onClick={() => onReply({ replyToGmailId: entry.gmailId, to: entry.from, subject: /^re:/i.test(entry.subject) ? entry.subject : `Re: ${entry.subject}` })}>
          <Reply size={14} aria-hidden />Reply
        </button>
      )}
    </div>
  )
}

function EmailFiles({ files, skipped, gmailId, onRetryFile }: {
  files: TimelineEvent['files']; skipped?: { name: string; why: string }[]; gmailId?: string
  onRetryFile?: (gmailId: string, name: string) => Promise<void>
}) {
  if (!files?.length && !skipped?.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {(files ?? []).map((f) => (
        f.url && f.mime.startsWith('image/') && !f.mime.includes('svg') ? (
          <a key={f.name + f.size} href={f.url} target="_blank" rel="noopener noreferrer" title={`${f.name} · ${humanSize(f.size)}`}
            className="block rounded-md border border-[#d8dcde] bg-white overflow-hidden hover:border-[#1f73b7] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={f.url} alt={f.name} loading="lazy" className="h-24 max-w-[200px] object-cover" />
            <span className="block px-1.5 py-0.5 text-[11px] text-[#68737d] truncate max-w-[200px]">{f.name} · {humanSize(f.size)}</span>
          </a>
        ) : f.url ? (
          <a key={f.name + f.size} href={f.url} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-[#d8dcde] bg-white text-[12px] hover:bg-[#f8f9f9] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
            {f.mime.startsWith('image/') ? <ImageIcon size={13} aria-hidden /> : <FileText size={13} aria-hidden />}
            <span className="truncate max-w-[170px]">{f.name}</span><span className="text-[#87929d] tabular-nums">{humanSize(f.size)}</span>
          </a>
        ) : (
          <span key={f.name + f.size} title="The download link has expired. Go back and open this lead again to get a new one."
            className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-[#e9ebed] bg-[#f8f9f9] text-[12px] text-[#87929d]">
            <FileText size={13} aria-hidden /><span className="truncate max-w-[170px]">{f.name}</span><span>link expired</span>
          </span>
        )
      ))}
      {(skipped ?? []).map((sk) => <SkippedFile key={sk.name} skip={sk} gmailId={gmailId} onRetry={onRetryFile} />)}
    </div>
  )
}

// A file the customer sent that could not be saved. The reason is on the chip,
// and where another attempt could work there is a Retry.
function SkippedFile({ skip, gmailId, onRetry }: { skip: { name: string; why: string }; gmailId?: string; onRetry?: (gmailId: string, name: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const canRetry = !!gmailId && !!onRetry && isRetryableSkip(skip.why)
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 min-h-7 px-2 py-0.5 rounded-md border border-[#f1dfb4] bg-[#fff8e6] text-[12px] text-[#703815]" role={failed ? 'alert' : undefined}>
      <TriangleAlert size={13} aria-hidden />
      <span className="truncate max-w-[150px] font-medium">{skip.name}</span>
      <span>was not saved: {failed || skip.why}</span>
      {canRetry && (
        <button type="button" disabled={busy} className="inline-flex items-center gap-1 font-semibold underline disabled:opacity-50"
          onClick={async () => {
            setBusy(true); setFailed('')
            try { await onRetry!(gmailId!, skip.name) } catch (x) { setFailed(errText(x, 'the retry failed')) } finally { setBusy(false) }
          }}>
          {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}Retry
        </button>
      )}
    </span>
  )
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────
// One message as it travelled: the files, the words, and for ours what
// WhatsApp did with it. "Sent" only means accepted; Delivered and Read mean it
// arrived, and a failure says why in words the agent can act on.

const WA_DAY_MS = 24 * 60 * 60 * 1000
const WA_MAX_FILE_BYTES = 16 * 1024 * 1024
const WA_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,audio/*,video/mp4,video/3gpp'
const WA_WINDOW_CODES = new Set([63016, 63024, 131047])

function waFailureHint(code: number | undefined): string {
  if (code !== undefined && WA_WINDOW_CODES.has(code)) {
    return 'WhatsApp only delivers a free message within 24 hours of the customer’s last message. This one was outside that window, so it did not arrive. Wait for them to write first, or send an email.'
  }
  return waErrorHint(code) || 'WhatsApp did not deliver this message.'
}

function WhatsAppMessage({ e, leadId }: { e: TimelineEvent; leadId: string }) {
  const w = e.wa
  const mine = e.kind === 'wa_out'
  const failed = mine && (w?.status === 'failed' || w?.status === 'undelivered')
  // The record folds the failure hint into the event body; the message's own
  // words are on the row itself.
  const text = w ? w.body : (e.body ?? '')
  const media = w?.media ?? []
  return (
    <div>
      {media.map((m, i) => {
        const src = `/api/leads/${encodeURIComponent(leadId)}/whatsapp/media?${m.path ? `path=${encodeURIComponent(m.path)}` : `url=${encodeURIComponent(m.url ?? '')}`}`
        const type = (m.type || '').toLowerCase()
        if (type.startsWith('audio/')) return <audio key={i} controls preload="none" className="mb-1.5 block w-full max-w-sm h-9" aria-label={m.name || 'Voice message'} src={src} />
        if (type.startsWith('image/')) {
          return (
            <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="mb-1.5 block w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={m.name || 'Photo'} loading="lazy" className="max-h-48 max-w-full rounded-md border border-[#d8dcde]" />
            </a>
          )
        }
        if (type.startsWith('video/')) return <video key={i} controls preload="none" className="mb-1.5 block w-full max-w-sm rounded-md" aria-label={m.name || 'Video'} src={src} />
        return (
          <a key={i} href={src} target="_blank" rel="noopener noreferrer" className={`${LINK} mb-1.5 flex items-center gap-1.5 w-fit max-w-full`}>
            <Paperclip size={13} className="shrink-0" aria-hidden /><span className="truncate">{m.name || 'File'}</span>
            {typeof m.size === 'number' && m.size > 0 && <span className="shrink-0 text-[#87929d] tabular-nums">{humanSize(m.size)}</span>}
          </a>
        )
      })}
      {text
        ? <p className="whitespace-pre-wrap break-words leading-5">{text}</p>
        : media.length === 0 && <p className="text-[#68737d] italic">No text in this message.</p>}
      {mine && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {failed ? <Chip tone="red">Not delivered{w?.errorCode ? ` · code ${w.errorCode}` : ''}</Chip>
            : w?.status === 'read' ? <Chip tone="blue">Read</Chip>
            : w?.status === 'delivered' ? <Chip tone="green">Delivered</Chip>
            : <span title="WhatsApp has accepted it. Delivered appears here once it reaches the customer’s phone."><Chip>Sent</Chip></span>}
          {w?.bot && <Chip>Sent automatically</Chip>}
          {w?.template && <Chip>Template message</Chip>}
        </p>
      )}
      {failed && <p role="note" className="mt-1 text-[12px] text-[#cc3340]">{waFailureHint(w?.errorCode)}</p>}
    </div>
  )
}

// The WhatsApp reply box. The server picks the customer's number and the line
// it goes out on; the browser only ever sends the lead id, the words and, for a
// file, where it was uploaded. Voice notes cannot be recorded here, but an
// audio file can be attached.
function WhatsAppBox({ leadId, events, canEmail, onSent }: { leadId: string; events: TimelineEvent[]; canEmail: boolean; onSent: () => void }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'sending'>('idle')
  const [error, setError] = useState('')
  const [sentNote, setSentNote] = useState('')
  // The clock the 24-hour rule is measured against, refreshed every minute.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  // WhatsApp's rule, worked out from the thread: a free message is allowed
  // only within a day of the customer's own last message.
  const lastIn = useMemo(() => {
    let newest: TimelineEvent | null = null
    let at = 0
    for (const e of events) {
      if (e.kind !== 'wa_in') continue
      const t = Date.parse(e.at)
      if (!Number.isNaN(t) && t > at) { at = t; newest = e }
    }
    return newest ? { at, iso: newest.at } : null
  }, [events])
  const closesAt = lastIn ? lastIn.at + WA_DAY_MS : null
  const open = closesAt !== null && now < closesAt
  const minutesLeft = closesAt !== null ? Math.max(1, Math.round((closesAt - now) / 60000)) : 0
  const leftLabel = minutesLeft >= 60 ? `${Math.floor(minutesLeft / 60)} h left` : `${minutesLeft} min left`
  const instead = canEmail ? 'Send an email instead, or wait for them to write.' : 'Wait for them to write first.'

  const busy = phase !== 'idle'
  const canSend = !busy && (!!text.trim() || !!file)

  function pickFile(f: File | null) {
    setError(''); setSentNote('')
    if (f && f.size > WA_MAX_FILE_BYTES) { setError(`"${f.name}" is ${humanSize(f.size)}. WhatsApp allows ${humanSize(WA_MAX_FILE_BYTES)} per message.`); return }
    setFile(f)
  }

  async function send() {
    if (!canSend) return
    const body = text.trim()
    setError(''); setSentNote('')
    try {
      // The file goes straight to storage on a one-time link, then the message
      // names where it landed.
      let media: { mediaPath: string; mediaName: string; mediaType: string } | null = null
      if (file) {
        setPhase('uploading')
        const prep = await fetch(`/api/leads/${encodeURIComponent(leadId)}/whatsapp/upload`, postJson({ name: file.name, mime: file.type, size: file.size }))
        const pd = await prep.json().catch(() => ({}))
        if (prep.status === 401) { window.location.href = '/login'; return }
        if (!prep.ok) throw new Error(pd.error === 'Not allowed' ? 'You do not have permission to send files on WhatsApp here.' : pd.error || 'That file could not be sent.')
        const put = await fetch(pd.uploadUrl, { method: 'PUT', body: file, headers: file.type ? { 'Content-Type': file.type } : undefined })
        if (!put.ok) throw new Error(`"${file.name}" did not upload. Try attaching it again.`)
        media = { mediaPath: pd.path, mediaName: file.name, mediaType: file.type || '' }
      }
      setPhase('sending')
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/whatsapp`, postJson({ body, ...(media ?? {}) }))
      const d = await res.json().catch(() => ({}))
      if (res.status === 401) { window.location.href = '/login'; return }
      if (!res.ok) throw new Error(d.error === 'Not allowed' ? 'You do not have permission to message this lead on WhatsApp.' : d.error || 'The message was not sent.')
      // Cleared only now: a refused send keeps what was typed.
      setText(''); setFile(null)
      setSentNote(typeof d.warning === 'string' && d.warning ? d.warning : 'Sent. Delivery shows on the message above.')
      onSent()
    } catch (e) {
      setError(errText(e, 'The message was not sent. Check your connection and try again.'))
    } finally {
      setPhase('idle')
    }
  }

  return (
    <div>
      {open ? (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-[#68737d]">
          <Chip tone="green">Reply window open · {leftLabel}</Chip>
          <span>The customer last wrote {timeAgo(lastIn!.iso)}. You can reply freely until {formatShortDateTime(new Date(closesAt!).toISOString())}.</span>
        </p>
      ) : (
        <div role="note" className="mb-2 rounded-md border border-[#f1dfb4] bg-[#fff8e6] px-3 py-2 text-[12px] text-[#703815]">
          <b>{lastIn ? 'The 24-hour reply window has closed.' : 'This customer has not written on WhatsApp yet.'}</b>{' '}
          {lastIn
            ? <>Their last WhatsApp message was <span title={formatDateTime(lastIn.iso)}>{timeAgo(lastIn.iso)}</span>, and WhatsApp refuses a message sent more than 24 hours after it. </>
            : <>WhatsApp only delivers a message within 24 hours of the customer writing to you, so one sent now will be refused. </>}
          {instead}
        </div>
      )}
      <div className="rounded-md border border-[#d8dcde] bg-white focus-within:border-[#038153]">
        <textarea value={text} rows={3} maxLength={4000} disabled={busy} aria-label="WhatsApp message"
          placeholder="Write a WhatsApp message. Enter sends, Shift+Enter adds a line."
          onChange={(e) => { setText(e.target.value); setSentNote('') }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          className="block w-full px-2.5 py-2 bg-transparent outline-none resize-y leading-5 placeholder:text-[#87929d] disabled:opacity-60" />
        {file && (
          <p className="border-t border-[#e9ebed] px-2.5 py-1.5 flex items-center gap-2 text-[12px]">
            {file.type.startsWith('image/') ? <ImageIcon size={13} className="text-[#68737d]" aria-hidden /> : <FileText size={13} className="text-[#68737d]" aria-hidden />}
            <span className="truncate">{file.name}</span>
            <span className="shrink-0 text-[#87929d] tabular-nums">{humanSize(file.size)}</span>
            <button type="button" onClick={() => pickFile(null)} disabled={busy} className={`${ICON_BTN} ml-auto !w-6 !h-6`} aria-label={`Remove ${file.name}`}><X size={13} /></button>
          </p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={send} disabled={!canSend} className={BTN_PRIMARY}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
          {phase === 'uploading' ? 'Uploading…' : phase === 'sending' ? 'Sending…' : 'Send on WhatsApp'}
        </button>
        <label className={`${BTN_PLAIN} cursor-pointer focus-within:ring-2 focus-within:ring-[#1f73b7]/40 ${busy ? 'opacity-40 pointer-events-none' : ''}`} title="A photo, PDF, audio file or video, up to 16 MB">
          <Paperclip size={14} aria-hidden />{file ? 'Change file' : 'Attach'}
          <input type="file" className="sr-only" accept={WA_ACCEPT} disabled={busy}
            onChange={(e) => { pickFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
        </label>
        <span className="text-[12px] text-[#87929d]">Photos, PDFs, audio and video up to 16 MB</span>
        {sentNote && !error && <span role="status" className="inline-flex items-center gap-1 text-[12px] text-[#038153]"><Check size={13} aria-hidden />{sentNote}</span>}
      </div>
      <div className="mt-1"><Notice text={error} bad /></div>
    </div>
  )
}

// ── Composer: note ───────────────────────────────────────────────────────────

function NoteBox({ onAdd }: { onAdd: (body: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function add() {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true); setErr('')
    // The text is cleared only once the note is saved, so a failure loses nothing.
    try { await onAdd(body); setText('') } catch (e) { setErr(errText(e, 'The note did not save. Try again.')) } finally { setBusy(false) }
  }
  return (
    <div>
      <textarea value={text} rows={3} maxLength={4000} aria-label="Internal note" placeholder="Write a note for your team. The customer never sees it."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add() } }}
        className={`${TEXTAREA} resize-y !bg-[#fff8e6] !border-[#f1dfb4] focus:!border-[#ad5918]`} />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" onClick={add} disabled={busy || !text.trim()} className={BTN_PRIMARY}><StickyNote size={14} aria-hidden />{busy ? 'Saving…' : 'Add note'}</button>
        <span className="text-[12px] text-[#87929d]">Ctrl or ⌘ + Enter also saves</span>
        <Notice text={err} bad />
      </div>
    </div>
  )
}

// ── Composer: email ──────────────────────────────────────────────────────────
// Sent from the agent's own Gmail, as plain text; the server adds the signature
// and addresses the message itself for anyone who is not an admin. What is
// typed is kept in this browser until the send succeeds.

interface EmailDraft { from: string; to: string; cc: string; subject: string; body: string }

function readDraft(leadId: string): Partial<EmailDraft> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(`zd-email-draft-${leadId}`)
    const d = raw ? JSON.parse(raw) : null
    return d && typeof d === 'object' ? d : {}
  } catch { return {} }
}

function EmailBox({ leadId, leadEmail, siteId, siteName, contactsHidden, recipientLocked, gmail, connectHref, replyTo, onCancelReply, onSent }: {
  leadId: string; leadEmail: string; siteId: string; siteName: string; contactsHidden: boolean; recipientLocked: boolean
  gmail: GmailStatus | null; connectHref: string; replyTo: ReplyTo | null; onCancelReply: () => void; onSent: () => void
}) {
  const [draft, setDraft] = useState<EmailDraft>(() => {
    const d = readDraft(leadId)
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return {
      from: str(d.from), cc: str(d.cc), body: str(d.body),
      to: replyTo?.to || str(d.to) || leadEmail,
      subject: replyTo ? replyTo.subject : str(d.subject),
    }
  })
  const [showCc, setShowCc] = useState(() => !!draft.cc.trim())
  const [files, setFiles] = useState<Attached[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [retryable, setRetryable] = useState(false)
  const [reconnect, setReconnect] = useState(false)
  const [sentNote, setSentNote] = useState('')
  const [sig, setSig] = useState<{ who: string; html: string } | null>(null)
  const [showSig, setShowSig] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  // A new Reply press re-addresses the message; leaving reply mode points it
  // back at the lead. Adjusted during render, so there is no stale frame.
  const [seenReply, setSeenReply] = useState(replyTo)
  if (replyTo !== seenReply) {
    setSeenReply(replyTo)
    setDraft((d) => (replyTo ? { ...d, to: replyTo.to || d.to, subject: replyTo.subject } : { ...d, to: leadEmail || d.to }))
  }

  const aliases = useMemo(() => gmail?.aliases ?? [], [gmail])
  const siteAlias = useMemo(() => (aliases.length ? matchSiteAlias(aliases, siteId, siteName) : null), [aliases, siteId, siteName])
  const ordered = useMemo(() => (siteAlias ? [siteAlias, ...aliases.filter((a) => a.email !== siteAlias.email)] : aliases), [aliases, siteAlias])
  // The address that belongs to this lead's site is the default, so a reply
  // never goes out under another site's name by accident.
  const from = aliases.some((a) => a.email === draft.from)
    ? draft.from
    : (siteAlias ?? aliases.find((a) => a.isDefault) ?? aliases.find((a) => a.isPrimary) ?? aliases[0])?.email ?? ''

  useEffect(() => {
    if (!from) return
    let alive = true
    fetch(`/api/signature?siteId=${encodeURIComponent(siteId)}&from=${encodeURIComponent(from)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive) setSig({ who: [d?.agent?.name, d?.agent?.title].filter(Boolean).join(', '), html: typeof d?.signatureHtml === 'string' ? d.signatureHtml : '' }) })
      .catch(() => { /* the line under the box simply stays generic */ })
    return () => { alive = false }
  }, [siteId, from])

  function set(patch: Partial<EmailDraft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    setSentNote('')
    try { localStorage.setItem(`zd-email-draft-${leadId}`, JSON.stringify(next)) } catch { /* storage is full or off */ }
  }

  // Files go from the browser straight to storage on a one-time link; the
  // server only hands out the link and later reads the file back to send it.
  async function addFiles(picked: File[]) {
    setError(''); setRetryable(false)
    let count = files.length
    for (const file of picked) {
      if (count >= MAX_EMAIL_ATTACHMENTS) { setError(`You can attach up to ${MAX_EMAIL_ATTACHMENTS} files.`); break }
      if (file.size > MAX_EMAIL_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is ${humanSize(file.size)}. The limit is ${humanSize(MAX_EMAIL_ATTACHMENT_BYTES)} per file, so send a download link instead.`)
        continue
      }
      count++
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 7)}`
      const mime = file.type || 'application/octet-stream'
      setFiles((cur) => [...cur, { key, name: file.name, size: file.size, mime, path: null, progress: true }])
      try {
        const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email/upload`, postJson({ name: file.name, mime: file.type, size: file.size }))
        const j = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(j.error === 'Not allowed' ? 'You do not have permission to attach files here.' : j.error || 'The upload was refused.')
        const put = await fetch(j.uploadUrl, { method: 'PUT', body: file, headers: { 'content-type': mime } })
        if (!put.ok) throw new Error(`"${file.name}" did not upload. Try attaching it again.`)
        setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, path: j.path, progress: false } : f)))
      } catch (e) {
        count--
        setFiles((cur) => cur.filter((f) => f.key !== key))
        setError(errText(e, `"${file.name}" could not be attached.`))
      }
    }
  }

  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  const missing: string[] = []
  if (!from) missing.push('a From address')
  if (!draft.to.trim()) missing.push('a recipient')
  if (!draft.subject.trim()) missing.push('a subject')
  if (!draft.body.trim()) missing.push('a message')
  if (files.some((f) => f.progress)) missing.push('the uploads to finish')
  if (totalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL) missing.push(`attachments under ${humanSize(MAX_EMAIL_ATTACHMENTS_TOTAL)} in total`)
  const canSend = missing.length === 0 && !sending

  async function send() {
    if (!canSend) return
    setError(''); setRetryable(false); setSentNote(''); setSending(true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email`, postJson({
        from, to: draft.to, cc: showCc && !contactsHidden ? draft.cc : '', subject: draft.subject, body: draft.body, html: '',
        replyToGmailId: replyTo?.replyToGmailId,
        attachments: files.filter((f) => f.path).map((f) => ({ path: f.path, name: f.name, mime: f.mime, size: f.size })),
      }))
      const j = await res.json().catch(() => ({}))
      if (res.status === 401 && !j.needsReconnect) { window.location.href = '/login'; return }
      if (!res.ok) {
        if (j.needsReconnect) setReconnect(true)
        if (j.retryable) setRetryable(true)
        throw new Error(j.error === 'Not allowed' ? 'You do not have permission to email this lead.' : j.error || 'The email was not sent.')
      }
      // Only now is it safe to let go of what was typed.
      try { localStorage.removeItem(`zd-email-draft-${leadId}`) } catch { /* ignore */ }
      setDraft((d) => ({ ...d, cc: '', subject: '', body: '' }))
      setShowCc(false); setFiles([])
      setSentNote(typeof j.warning === 'string' && j.warning ? j.warning : 'Email sent.')
      onSent()
    } catch (e) {
      setError(errText(e, 'The email was not sent.'))
    } finally {
      setSending(false)
    }
  }

  if (!leadEmail) return <p className="text-[#68737d]">This lead has no email address yet. Add one under Customer on the left, then write to them here.</p>
  if (!gmail) return <p className="text-[#68737d]" role="status">Checking your Gmail connection…</p>
  if (gmail.available === false) return <p className="text-[#68737d]">Email is not switched on for your team.</p>
  if (gmail.configured === false) {
    return <p role="alert" className="text-[#703815]">Email is not set up on the server yet. {gmail.reason || 'An admin needs to add the Google details before email can be sent.'}</p>
  }
  if (!gmail.connected) {
    return (
      <div>
        <p className="font-semibold">{gmail.needsReconnect ? 'Your Gmail connection needs renewing' : 'Connect Gmail to send email'}</p>
        <p className="mt-0.5 text-[#68737d]">{gmail.reason || 'Email goes out from your own Google account, so the customer sees a normal email from you and their reply comes back to this lead.'}</p>
        <a href={connectHref} className={`${BTN_PRIMARY} mt-2`}><Link2 size={14} aria-hidden />{gmail.needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail'}</a>
      </div>
    )
  }

  const toLocked = contactsHidden || recipientLocked
  const ROW = 'flex items-center gap-2 px-2.5 min-h-9 border-b border-[#e9ebed]'
  const ROW_LABEL = 'w-14 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-[#68737d]'
  const ROW_INPUT = 'flex-1 min-w-0 h-8 bg-transparent outline-none placeholder:text-[#87929d]'
  return (
    <div onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void send() } }}>
      {gmail.rateLimited && (
        <p role="alert" className="mb-2 rounded-md border border-[#f1dfb4] bg-[#fff8e6] px-3 py-2 text-[12px] text-[#703815]">
          <b>Gmail is busy right now.</b> {gmail.reason || 'Your connection is fine and this passes in a few seconds.'} Go back and open this lead again to reload your sending addresses.
        </p>
      )}
      {replyTo && (
        <p className="mb-2 flex items-center gap-2 text-[12px] text-[#144a75]">
          <Reply size={13} aria-hidden /><span className="truncate">Replying in the same thread: {replyTo.subject}</span>
          <button type="button" onClick={onCancelReply} className={`${LINK} ml-auto shrink-0`}>Write a new email instead</button>
        </p>
      )}
      <div className="rounded-md border border-[#d8dcde] bg-white focus-within:border-[#1f73b7]">
        <div className={ROW}>
          <label htmlFor="zd-mail-from" className={ROW_LABEL}>From</label>
          <select id="zd-mail-from" value={from} onChange={(e) => set({ from: e.target.value })} className={`${ROW_INPUT} cursor-pointer`}>
            {ordered.length === 0 && <option value="">No sending address available</option>}
            {ordered.map((a) => (
              <option key={a.email} value={a.email}>{(a.displayName ? `${a.displayName} <${a.email}>` : a.email) + (a.email === siteAlias?.email ? ' (this lead’s site)' : '')}</option>
            ))}
          </select>
        </div>
        <div className={ROW}>
          <label htmlFor="zd-mail-to" className={ROW_LABEL}>To</label>
          <input id="zd-mail-to" value={draft.to} readOnly={toLocked} onChange={(e) => set({ to: e.target.value })} className={`${ROW_INPUT} ${toLocked ? 'text-[#68737d]' : ''}`}
            title={contactsHidden ? 'This address is hidden for your account. The message still goes to the customer.' : recipientLocked ? 'Your emails go to this lead. Ask an admin to email anyone else.' : undefined} />
          {toLocked && <Lock size={13} className="shrink-0 text-[#87929d]" aria-hidden />}
          {!showCc && !contactsHidden && <button type="button" onClick={() => setShowCc(true)} className={`${LINK} shrink-0 text-[12px]`}>Add Cc</button>}
        </div>
        {showCc && !contactsHidden && (
          <div className={ROW}>
            <label htmlFor="zd-mail-cc" className={ROW_LABEL}>Cc</label>
            <input id="zd-mail-cc" value={draft.cc} placeholder="name@example.com" onChange={(e) => set({ cc: e.target.value })} className={ROW_INPUT} />
            <button type="button" onClick={() => { setShowCc(false); set({ cc: '' }) }} className={ICON_BTN} aria-label="Remove Cc" title="Remove Cc"><X size={14} /></button>
          </div>
        )}
        <div className={ROW}>
          <label htmlFor="zd-mail-subject" className={ROW_LABEL}>Subject</label>
          <input id="zd-mail-subject" value={draft.subject} maxLength={300} required placeholder="What is this about?" onChange={(e) => set({ subject: e.target.value })} className={`${ROW_INPUT} font-medium`} />
        </div>
        <textarea value={draft.body} rows={5} aria-label="Message" placeholder="Write your message. Your signature is added when it sends."
          onChange={(e) => set({ body: e.target.value })}
          className="block w-full px-2.5 py-2 bg-transparent outline-none resize-y leading-5 placeholder:text-[#87929d]" />
        {files.length > 0 && (
          <ul className="border-t border-[#e9ebed] px-2.5 py-2 space-y-1" aria-label="Attachments">
            {files.map((f) => (
              <li key={f.key} className="flex items-center gap-2 text-[12px]">
                {f.progress ? <Loader2 size={13} className="animate-spin text-[#68737d]" aria-label="Uploading" /> : f.mime.startsWith('image/') ? <ImageIcon size={13} className="text-[#68737d]" aria-hidden /> : <FileText size={13} className="text-[#68737d]" aria-hidden />}
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-[#87929d] tabular-nums">{humanSize(f.size)}</span>
                <button type="button" onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))} className={`${ICON_BTN} ml-auto !w-6 !h-6`} aria-label={`Remove ${f.name}`}><X size={13} /></button>
              </li>
            ))}
            <li className="text-[11px] text-[#87929d] tabular-nums">{humanSize(totalBytes)} of {humanSize(MAX_EMAIL_ATTACHMENTS_TOTAL)} used</li>
          </ul>
        )}
      </div>

      {showSig && sig?.html && (
        <div className="mt-2 rounded-md border border-[#e9ebed] bg-white px-3 py-2 overflow-x-auto">
          <p className={SECTION}>Signature added on send</p>
          <div className="mt-1 pointer-events-none select-none" dangerouslySetInnerHTML={{ __html: sig.html }} />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={send} disabled={!canSend} className={BTN_PRIMARY} title={canSend ? 'Send (Ctrl or ⌘ + Enter)' : undefined}>
          {sending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}{sending ? 'Sending…' : replyTo ? 'Send reply' : 'Send email'}
        </button>
        <input ref={fileInput} type="file" multiple className="hidden" aria-hidden tabIndex={-1}
          onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
        <button type="button" onClick={() => fileInput.current?.click()} disabled={sending} className={BTN_PLAIN} title={`Up to ${humanSize(MAX_EMAIL_ATTACHMENT_BYTES)} per file`}><Paperclip size={14} aria-hidden />Attach</button>
        {sig?.html && <button type="button" onClick={() => setShowSig((v) => !v)} aria-expanded={showSig} className={`${LINK} text-[12px]`}>{showSig ? 'Hide signature' : sig.who ? `Signed ${sig.who}` : 'Show signature'}</button>}
        {missing.length > 0 && !sending && <span className="text-[12px] text-[#ad5918]">Still needs {missing.join(', ')}</span>}
        {sentNote && !error && <span role="status" className="inline-flex items-center gap-1 text-[12px] text-[#038153]"><Check size={13} aria-hidden />{sentNote}</span>}
      </div>
      {error && (
        <p role="alert" className={`mt-2 text-[12px] ${retryable ? 'text-[#ad5918]' : 'text-[#cc3340]'}`}>
          {error}
          {retryable && <> <button type="button" onClick={send} disabled={sending} className="font-semibold underline disabled:opacity-50">Try again</button></>}
          {reconnect && !retryable && <> <a href={connectHref} className="font-semibold underline">Reconnect Gmail</a></>}
        </p>
      )}
    </div>
  )
}

// ── Tasks ────────────────────────────────────────────────────────────────────
// A new task opens already valid: a follow-up, due tomorrow at 10:00 AM
// Pakistan time, assigned to the person adding it. The due time is turned into
// a real instant by the server, so the browser's own time zone never matters.

const newTaskDraft = (me: string): TaskDraft => ({ title: '', type: 'follow_up', dueDate: defaultDueDate(), dueTime: DEFAULT_DUE_TIME, assignee: me })

function TasksPanel({ openTasks, doneTasks, members, me, isAdmin, busyIds, error, onCreate, onToggle, onReassign, onDelete }: {
  openTasks: CrmTaskEntry[]; doneTasks: CrmTaskEntry[]; members: string[]; me: string; isAdmin: boolean; busyIds: Set<string>; error: string
  onCreate: (draft: TaskDraft) => Promise<void>
  onToggle: (task: CrmTaskEntry, done: boolean) => Promise<void>
  onReassign: (task: CrmTaskEntry, assignee: string) => Promise<void>
  onDelete: (task: CrmTaskEntry) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<TaskDraft>(() => newTaskDraft(me))
  const [saving, setSaving] = useState(false)
  const [addErr, setAddErr] = useState('')
  const [showDone, setShowDone] = useState(false)
  const people = members.includes(me) ? members : [me, ...members]

  async function submit() {
    if (!draft.title.trim() || saving) return
    setSaving(true); setAddErr('')
    try { await onCreate({ ...draft, title: draft.title.trim() }); setAdding(false); setDraft(newTaskDraft(me)) } catch (e) { setAddErr(errText(e, 'The task was not added. Try again.')) } finally { setSaving(false) }
  }

  return (
    <section aria-label="Tasks">
      <div className="flex items-center gap-2">
        <h2 className={SECTION}>Tasks <span className="tabular-nums font-normal">({openTasks.length} open)</span></h2>
        {!adding && <button type="button" onClick={() => { setDraft(newTaskDraft(me)); setAddErr(''); setAdding(true) }} className={`${BTN_PLAIN} ml-auto !h-7 !px-2`}><Plus size={14} aria-hidden />Add task</button>}
      </div>

      {adding && (
        <div className={`${CARD} mt-2 p-3 space-y-2`} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false) }}>
          <div>
            <label htmlFor="zd-task-title" className={LABEL}>What needs doing?</label>
            <input id="zd-task-title" value={draft.title} autoFocus maxLength={MAX_TASK_TITLE} placeholder="Call back about the artwork" onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }} className={INPUT} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="zd-task-type" className={LABEL}>Type</label>
              <select id="zd-task-type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as TaskType })} className={SELECT}>
                {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="zd-task-who" className={LABEL}>Assigned to</label>
              <select id="zd-task-who" value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} className={SELECT}>
                {people.map((m) => <option key={m} value={m}>{short(m)}{m === me ? ' (you)' : ''}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="zd-task-date" className={LABEL}>Due date</label>
              <input id="zd-task-date" type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} className={`${INPUT} tabular-nums`} />
            </div>
            <div>
              <label htmlFor="zd-task-time" className={LABEL}>Due time</label>
              <input id="zd-task-time" type="time" value={draft.dueTime} onChange={(e) => setDraft({ ...draft, dueTime: e.target.value })} className={`${INPUT} tabular-nums`} />
            </div>
          </div>
          <p className="text-[11px] text-[#87929d]">Due times are in Pakistan time. A reminder goes to the person it is assigned to.</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={submit} disabled={saving || !draft.title.trim()} className={BTN_PRIMARY}>{saving ? 'Adding…' : 'Add task'}</button>
            <button type="button" onClick={() => setAdding(false)} disabled={saving} className={BTN_PLAIN}>Cancel</button>
          </div>
          <Notice text={addErr} bad />
        </div>
      )}

      <div className="mt-1"><Notice text={error} bad /></div>

      {openTasks.length === 0 ? (
        !adding && <p className="mt-2 text-[12px] text-[#68737d]">Nothing is waiting to be done on this lead.</p>
      ) : (
        <ul className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
          {openTasks.map((t) => <TaskRow key={t.id} task={t} people={people} me={me} isAdmin={isAdmin} busy={busyIds.has(t.id)} onToggle={onToggle} onReassign={onReassign} onDelete={onDelete} />)}
        </ul>
      )}

      {doneTasks.length > 0 && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone} className={`${LINK} inline-flex items-center gap-1 text-[12px]`}>
            {showDone ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}{doneTasks.length} completed
          </button>
          {showDone && (
            <ul className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
              {doneTasks.map((t) => <TaskRow key={t.id} task={t} people={people} me={me} isAdmin={isAdmin} busy={busyIds.has(t.id)} onToggle={onToggle} onReassign={onReassign} onDelete={onDelete} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function TaskRow({ task, people, me, isAdmin, busy, onToggle, onReassign, onDelete }: {
  task: CrmTaskEntry; people: string[]; me: string; isAdmin: boolean; busy: boolean
  onToggle: (task: CrmTaskEntry, done: boolean) => Promise<void>
  onReassign: (task: CrmTaskEntry, assignee: string) => Promise<void>
  onDelete: (task: CrmTaskEntry) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const done = task.status === 'done'
  const bucket = taskBucket(task.due_at)
  const overdue = !done && bucket === 'overdue'
  const today = !done && bucket === 'today'
  return (
    <li className={`px-3 py-2 ${overdue ? 'bg-[#fff0f1]' : ''} ${busy ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2">
        <button type="button" role="checkbox" aria-checked={done} disabled={busy} onClick={() => onToggle(task, !done)}
          aria-label={done ? `Reopen: ${task.title}` : `Mark as done: ${task.title}`} title={done ? 'Reopen this task' : 'Mark as done'}
          className={`mt-0.5 w-[18px] h-[18px] shrink-0 rounded border flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${done ? 'bg-[#038153] border-[#038153] text-white' : 'bg-white border-[#87929d] text-transparent hover:border-[#1f73b7]'}`}>
          <Check size={13} strokeWidth={3} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className={`break-words ${done ? 'line-through text-[#68737d]' : 'font-medium'}`}>{task.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            <Chip>{TASK_TYPE_LABEL[task.type]}</Chip>
            {done
              ? <span className="text-[#038153]" title={formatDateTime(task.completed_at)}>Done {timeAgo(task.completed_at)}{task.completed_by ? ` by ${short(task.completed_by)}` : ''}</span>
              : <span className={`tabular-nums ${overdue ? 'font-semibold text-[#cc3340]' : today ? 'font-semibold text-[#ad5918]' : 'text-[#68737d]'}`} title={formatDateTime(task.due_at)}>{overdue ? 'Overdue · ' : 'Due '}{formatDueLabel(task.due_at)}</span>}
          </p>
        </div>
        {isAdmin && !confirming && (
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={ICON_BTN} aria-label={`Delete: ${task.title}`} title="Delete this task"><Trash2 size={14} /></button>
        )}
      </div>
      {!done && (
        <div className="mt-1.5 pl-[26px]">
          <select value={task.assignee} disabled={busy} onChange={(e) => onReassign(task, e.target.value)} aria-label={`Assigned to, for: ${task.title}`}
            className="h-7 max-w-full px-1.5 rounded-md bg-white border border-[#d8dcde] text-[12px] cursor-pointer outline-none focus:border-[#1f73b7] disabled:opacity-50">
            {!people.includes(task.assignee) && <option value={task.assignee}>{short(task.assignee) || 'Unassigned'}</option>}
            {people.map((m) => <option key={m} value={m}>{short(m)}{m === me ? ' (you)' : ''}</option>)}
          </select>
        </div>
      )}
      {confirming && (
        <div className="mt-2 pl-[26px] flex flex-wrap items-center gap-2" role="group" aria-label="Confirm deleting this task">
          <span className="text-[12px]">Delete this task?</span>
          <button type="button" disabled={busy} onClick={() => { setConfirming(false); void onDelete(task) }} className={`${BTN_DANGER} !h-7 !px-2`}>Delete</button>
          <button type="button" onClick={() => setConfirming(false)} className={`${BTN_PLAIN} !h-7 !px-2`}>Keep it</button>
        </div>
      )}
    </li>
  )
}
