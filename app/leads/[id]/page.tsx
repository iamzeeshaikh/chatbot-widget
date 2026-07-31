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

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import {
  CRM_STAGES, CRM_STAGE_LABEL, CRM_STAGE_STYLE, CRM_STAGE_DOT, CRM_CURRENCIES,
  CURRENCY_SYMBOL, type CrmStage, type CrmCurrency,
} from '@/lib/crm'
import { isImageMime } from '@/lib/attachment'
import type { LeadRecord, TimelineEvent } from '@/lib/leadrecord'
import type { CrmTaskEntry } from '@/lib/tasks'
import Timeline from './Timeline'
import Tasks, { type TaskDraft } from './Tasks'
import { Card, EmptyState, InlineField, MetaRow, QuickAction, Skeleton } from './ui'

export default function LeadRecordPage() {
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : ''

  const [record, setRecord] = useState<LeadRecord | null>(null)
  const [status, setStatus] = useState<'loading' | 'ok' | 'forbidden' | 'missing' | 'error'>('loading')
  const [me, setMe] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [stageError, setStageError] = useState('')
  // Tasks mid-write. Keyed by task id so completing one doesn't grey out the
  // rest of the list.
  const [taskBusy, setTaskBusy] = useState<Set<string>>(new Set())
  const [taskError, setTaskError] = useState('')

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
    ? 'No follow-ups yet'
    : `${record.followUps.count} follow-up${record.followUps.count === 1 ? '' : 's'}${record.followUps.lastAt ? ` · last ${timeAgo(record.followUps.lastAt)}` : ''}`

  const displayName = record.contact.name || record.contact.email || record.contact.phone || 'Unnamed lead'

  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">
      {/* ── Header ── */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-3 flex-wrap">
          <Link href="/" title="Back to the dashboard"
            className="shrink-0 px-2 py-1 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 transition-colors">
            ←
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-base font-bold text-gray-900 truncate">{displayName}</h1>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${CRM_STAGE_STYLE[record.stage]}`}>
                {CRM_STAGE_LABEL[record.stage]}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 truncate">
              {record.siteName} · {record.sourceLabel} · created {formatDateTime(record.createdAt)}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {record.hasConversation ? (
              <Link href={conversationHref}
                className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
                💬 Full conversation
              </Link>
            ) : (
              <span title="This lead arrived by email — there is no chat transcript"
                className="text-xs font-medium px-2.5 py-1.5 rounded-lg border border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed">
                💬 No chat
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_290px] gap-4 items-start animate-in">
        {/* ══ LEFT — identity ══ */}
        <div className="space-y-4 min-w-0">
          <Card>
            <div className="flex items-center gap-3 px-4 pt-4 pb-3">
              <span className="w-11 h-11 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-base font-bold shrink-0" aria-hidden>
                {(displayName[0] ?? '?').toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900 truncate">{displayName}</p>
                <p className="text-[11px] text-gray-500 truncate">{record.siteName}</p>
              </div>
            </div>

            <div className="border-t border-gray-100 divide-y divide-gray-100">
              <InlineField label="Name" value={record.contact.name} placeholder="Add a name"
                overridden={record.overriddenFields.includes('name')} onSave={(v) => saveField('name', v)} />
              <InlineField label="Email" value={record.contact.email} placeholder="Add an email"
                href={record.contact.email ? `mailto:${record.contact.email}` : undefined}
                overridden={record.overriddenFields.includes('email')} onSave={(v) => saveField('email', v)} />
              <InlineField label="Phone" value={record.contact.phone} placeholder="Add a phone number"
                href={record.contact.phone ? `tel:${record.contact.phone.replace(/[^\d+]/g, '')}` : undefined}
                overridden={record.overriddenFields.includes('phone')} onSave={(v) => saveField('phone', v)} />
            </div>

            <div className="flex items-center gap-1.5 px-3 py-3 border-t border-gray-100">
              <QuickAction icon="📝" label="Note" onClick={() => {
                document.getElementById('note-composer')?.focus()
                document.getElementById('note-composer')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              }} />
              <QuickAction icon="✅" label="Task" hint="Add a task or follow-up" onClick={() => {
                const btn = document.getElementById('task-composer-open')
                btn?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                btn?.click()
              }} />
              <QuickAction icon="✉️" label="Email" disabled hint="Coming soon" />
              <QuickAction icon="📞" label="Call" disabled hint="Coming soon" />
            </div>
          </Card>

          <Card title="About this lead">
            <div className="py-2">
              <MetaRow label="Owner">
                <select value={record.owner ?? ''} onChange={(e) => saveOwner(e.target.value)}
                  aria-label="Lead owner"
                  className="bg-gray-100 border border-gray-200 rounded-md px-1.5 py-0.5 text-xs text-gray-800 max-w-full focus:outline-none focus:border-gray-400 cursor-pointer">
                  <option value="">Unassigned</option>
                  {record.assignableMembers.map((m) => (
                    <option key={m} value={m}>{m.split('@')[0]}</option>
                  ))}
                </select>
              </MetaRow>
              <MetaRow label="Stage">
                <span className={`text-[10px] font-semibold px-1.5 py-px rounded-full border ${CRM_STAGE_STYLE[record.stage]}`}>
                  {CRM_STAGE_LABEL[record.stage]}
                </span>
                {record.stageBy && <span className="text-[10px] text-gray-500 ml-1.5">by {record.stageBy.split('@')[0]}</span>}
              </MetaRow>
              <MetaRow label="Source">{record.sourceLabel}</MetaRow>
              <MetaRow label="Site">{record.siteName}</MetaRow>
              <MetaRow label="First seen" title={formatDateTime(record.firstSeenAt)}>{formatDateTime(record.firstSeenAt)}</MetaRow>
              <MetaRow label="Created" title={formatDateTime(record.createdAt)}>{formatDateTime(record.createdAt)}</MetaRow>
              <MetaRow label="Last contact" title={record.lastContactedAt ? formatDateTime(record.lastContactedAt) : undefined}>
                {record.lastContactedAt ? `${formatDateTime(record.lastContactedAt)} · ${timeAgo(record.lastContactedAt)}` : 'Never'}
              </MetaRow>
              <MetaRow label="Last activity" title={formatDateTime(record.lastActivityAt)}>
                {record.lastActivityAt ? timeAgo(record.lastActivityAt) : '—'}
              </MetaRow>
              {(record.country || record.referrer) && (
                <MetaRow label="Origin" title={record.referrer ?? undefined}>
                  {[record.country, record.referrer].filter(Boolean).join(' · ')}
                </MetaRow>
              )}
              {record.tags.length > 0 && (
                <MetaRow label="Tags">
                  <span className="flex items-center gap-1 flex-wrap">
                    {record.tags.map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-px rounded-full bg-gray-200 border border-gray-300 text-gray-700">{t}</span>
                    ))}
                  </span>
                </MetaRow>
              )}
            </div>
          </Card>
        </div>

        {/* ══ CENTER — tasks + deal + activity ══ */}
        <div className="space-y-4 min-w-0">
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

          <Card title="Deal">
            <div className="p-4 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <label htmlFor="stage-select" className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Stage</label>
                <select id="stage-select" value={record.stage} onChange={(e) => changeStage(e.target.value as CrmStage)}
                  style={{ boxShadow: `inset 3px 0 0 ${CRM_STAGE_DOT[record.stage]}` }}
                  className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${CRM_STAGE_STYLE[record.stage]}`}>
                  {CRM_STAGES.map((s) => (
                    <option key={s} value={s} className="bg-white text-gray-800">{CRM_STAGE_LABEL[s]}</option>
                  ))}
                </select>
                <span className="text-[11px] text-gray-500">
                  {record.stageAt ? `changed ${timeAgo(record.stageAt)}` : 'never changed'}
                </span>
                <span className="ml-auto text-[11px] font-medium text-gray-600 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5"
                  title="Counted automatically from agent replies — a burst of replies in one sitting counts as one follow-up">
                  🔁 {followUpLabel}
                </span>
              </div>

              {stageError && (
                <p role="alert" className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">
                  {stageError} — the stage was put back.
                </p>
              )}

              {/* Stage rail */}
              <div className="flex items-center gap-1" aria-hidden>
                {CRM_STAGES.filter((s) => s !== 'lost').map((s) => {
                  const idx = CRM_STAGES.indexOf(s)
                  const cur = CRM_STAGES.indexOf(record.stage)
                  const done = record.stage !== 'lost' && idx <= cur
                  return (
                    <span key={s} title={CRM_STAGE_LABEL[s]} className="flex-1 h-1.5 rounded-full transition-colors"
                      style={{ backgroundColor: done ? CRM_STAGE_DOT[record.stage] : 'rgba(148,163,184,0.28)' }} />
                  )
                })}
              </div>

              {/* Keyed on the saved value so a change made elsewhere (or a
                  rolled-back save) re-seeds the inputs without an effect. */}
              <DealValue key={`${record.value.estimated}|${record.value.won}|${record.value.currency}`}
                record={record} onSave={saveValue} />
            </div>
          </Card>

          <Card title="Activity"
            action={<span className="text-[10px] text-gray-500">{record.messageCount} message{record.messageCount === 1 ? '' : 's'}</span>}>
            <div className="px-4 pt-3">
              <label htmlFor="note-composer" className="sr-only">Add an internal note</label>
              <textarea id="note-composer" value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote() } }}
                rows={noteDraft ? 3 : 2} placeholder="Add an internal note… (only your team can see this)"
                className="w-full bg-gray-100 border border-gray-200 rounded-xl px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-400 resize-y transition-colors" />
              <div className="flex items-center gap-2 mt-2 mb-1">
                <button onClick={addNote} disabled={!noteDraft.trim() || addingNote}
                  className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
                  {addingNote ? 'Saving…' : 'Add note'}
                </button>
                <span className="text-[10px] text-gray-400">⌘/Ctrl + Enter</span>
              </div>
            </div>
            <Timeline events={record.timeline} currency={record.value.currency}
              onEditNote={editNote} onDeleteNote={deleteNote} canManageNote={canManageNote} />
          </Card>
        </div>

        {/* ══ RIGHT — related ══ */}
        <div className="space-y-4 min-w-0">
          <Card title="Attachments" action={<span className="text-[10px] text-gray-500">{record.attachments.length}</span>}>
            {record.attachments.length === 0 ? (
              <EmptyState icon="📎" title="No attachments" hint="Files shared in this chat show up here." />
            ) : (
              <ul className="p-2 space-y-1">
                {record.attachments.map((f) => (
                  <li key={f.url}>
                    <a href={f.url} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-2 rounded-xl px-2 py-1.5 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
                      {isImageMime(f.mime)
                        /* eslint-disable-next-line @next/next/no-img-element */
                        ? <img src={f.url} alt="" className="w-8 h-8 rounded object-cover shrink-0 border border-gray-200" />
                        : <span className="w-8 h-8 rounded bg-gray-100 border border-gray-200 flex items-center justify-center text-sm shrink-0" aria-hidden>📄</span>}
                      <span className="min-w-0">
                        <span className="block text-xs text-blue-700 truncate">{f.name}</span>
                        <span className="block text-[10px] text-gray-500">{f.by} · {formatDateTime(f.at)}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Related leads" action={<span className="text-[10px] text-gray-500">{record.related.length}</span>}>
            {record.related.length === 0 ? (
              <EmptyState icon="🔗" title="No related leads" hint="Other leads with the same email or phone appear here." />
            ) : (
              <ul className="p-2 space-y-1">
                {record.related.map((r) => (
                  <li key={r.id}>
                    <Link href={`/leads/${encodeURIComponent(r.id)}`}
                      className="block rounded-xl px-2.5 py-2 hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400">
                      <span className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-gray-900 truncate">{r.name || r.email || r.phone || 'Lead'}</span>
                        <span className="text-[9px] px-1 py-px rounded bg-gray-200 border border-gray-300 text-gray-600 shrink-0">
                          {r.kind === 'chat' ? 'chat' : r.kind === 'quote' ? 'quote' : 'order'}
                        </span>
                      </span>
                      <span className="block text-[10px] text-gray-500 truncate">
                        {r.siteName} · {formatDateTime(r.at)}
                      </span>
                      <span className="block text-[10px] text-gray-400">matched on {r.matchedOn}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {record.quoteMessage && (
            <Card title={record.kind === 'checkout' ? 'Order email' : 'Quote request'}>
              <p className="px-4 py-3 text-[11px] text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                {record.quoteMessage}
              </p>
            </Card>
          )}

          <Card>
            <div className="px-4 py-3">
              {record.hasConversation ? (
                <Link href={conversationHref} className="text-xs text-blue-700 hover:underline">
                  💬 Open the full conversation →
                </Link>
              ) : (
                <p className="text-xs text-gray-500">This lead arrived by email — there is no chat transcript.</p>
              )}
              <p className="text-[10px] text-gray-400 mt-1 font-mono truncate" title={record.id}>{record.id}</p>
            </div>
          </Card>
        </div>
      </main>
    </div>
  )
}

// ── Deal value ───────────────────────────────────────────────────────────────
// "Won revenue" only exists once the deal is Won — showing it earlier invites
// someone to fill in a number that means nothing yet.
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

  const inputClass = 'w-full bg-gray-100 border border-gray-200 rounded-lg pl-6 pr-2 py-1.5 text-sm text-gray-900 tabular-nums focus:outline-none focus:border-blue-400 transition-colors'

  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3">
      <div>
        <label htmlFor="deal-estimated" className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
          Estimated value
        </label>
        <div className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-500" aria-hidden>
            {CURRENCY_SYMBOL[currency]}
          </span>
          <input id="deal-estimated" inputMode="decimal" value={estimated} placeholder="0"
            onChange={(e) => setEstimated(e.target.value)} onBlur={() => commit()}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            className={inputClass} />
        </div>
      </div>

      {record.stage === 'won' ? (
        <div>
          <label htmlFor="deal-won" className="block text-[10px] font-semibold uppercase tracking-wider text-green-700 mb-1">
            Won revenue
          </label>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-500" aria-hidden>
              {CURRENCY_SYMBOL[currency]}
            </span>
            <input id="deal-won" inputMode="decimal" value={won} placeholder="0"
              onChange={(e) => setWon(e.target.value)} onBlur={() => commit()}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className={`${inputClass} border-green-300`} />
          </div>
        </div>
      ) : (
        <div className="flex items-end">
          <p className="text-[11px] text-gray-400 pb-2">Won revenue appears once the stage is Won.</p>
        </div>
      )}

      <div>
        <label htmlFor="deal-currency" className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">
          Currency
        </label>
        <select id="deal-currency" value={currency}
          onChange={(e) => { const c = e.target.value as CrmCurrency; setCurrency(c); commit({ currency: c }) }}
          className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:border-blue-400 cursor-pointer">
          {CRM_CURRENCIES.map((c) => <option key={c} value={c} className="bg-white text-gray-800">{c}</option>)}
        </select>
      </div>
    </div>
  )
}

// ── Loading / failure states ─────────────────────────────────────────────────
// The skeleton mirrors the real three-column layout so nothing jumps when the
// record lands.
function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-gray-100">
      <header className="sticky top-0 z-20 bg-white/95 border-b border-gray-200">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-3 flex items-center gap-3">
          <Skeleton className="w-6 h-6 rounded-lg" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-2.5 w-64" />
          </div>
        </div>
      </header>
      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_290px] gap-4 items-start">
        {[0, 1, 2].map((col) => (
          <div key={col} className="space-y-4 w-full">
            <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 space-y-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-9 w-full rounded-xl" />
              <Skeleton className="h-9 w-full rounded-xl" />
              <Skeleton className="h-9 w-2/3 rounded-xl" />
            </div>
            {col === 1 && (
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-4 space-y-3">
                <Skeleton className="h-3 w-20" />
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="w-6 h-6 rounded-full shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-1/3" />
                      <Skeleton className="h-3 w-3/4" />
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
    ? { icon: '🔒', title: 'You don’t have access to this lead', hint: 'It belongs to a site outside your assigned sites. Ask an admin if you need it.' }
    : status === 'missing'
      ? { icon: '🔍', title: 'Lead not found', hint: 'The record may have been deleted, or the link is wrong.' }
      : { icon: '⚠️', title: 'Could not load this lead', hint: 'Something went wrong on our side. Try again in a moment.' }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="bg-white border border-gray-200 rounded-2xl shadow-sm max-w-sm w-full py-8 animate-in">
        <EmptyState icon={copy.icon} title={copy.title} hint={copy.hint} />
        <div className="flex justify-center pb-2">
          <Link href="/" className="text-xs font-medium text-blue-700 hover:underline">← Back to the dashboard</Link>
        </div>
      </div>
    </div>
  )
}
