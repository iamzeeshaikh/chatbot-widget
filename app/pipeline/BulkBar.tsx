'use client'

// The bulk action bar for the pipeline list.
//
// Bulk writes have a wide blast radius, so the bar never applies on the first
// click: picking a stage or an owner arms a confirmation that states the exact
// sentence — "Set 47 leads to Contacted" — and only the second click writes.
//
// Undo is real, and is offered after every action. It is a COMPENSATING change,
// not a rollback: it writes a further row per lead restoring the previous
// value. The audit trail keeps both events, which is the point of an
// append-only log — so the wording says "restored", never "erased".

import { useState } from 'react'
import {
  X, Check, Undo2, ListTodo, UserRound, TriangleAlert, Loader2, ArrowRightLeft,
} from 'lucide-react'
import { CRM_STAGES, CRM_STAGE_LABEL, type CrmStage } from '@/lib/crm'
import { TASK_TYPES, TASK_TYPE_LABEL, defaultDueDate, DEFAULT_DUE_TIME, type TaskType } from '@/lib/tasks'

export interface BulkResult {
  applied: number
  skipped: { id: string; reason: string }[]
  failed: { id: string; error: string }[]
  note: string
  undo?: { action: string; entries: unknown[] }
}

type Pending =
  | { kind: 'stage'; stage: CrmStage }
  | { kind: 'owner'; email: string }
  | { kind: 'task' }
  | null

export default function BulkBar({
  count, allMatching, owners, me, busy, result, onApply, onUndo, onClear, onDismissResult,
}: {
  count: number
  allMatching: boolean
  owners: string[]
  me: string
  busy: boolean
  result: BulkResult | null
  onApply: (body: Record<string, unknown>, describe: string) => void
  onUndo: () => void
  onClear: () => void
  onDismissResult: () => void
}) {
  const [pending, setPending] = useState<Pending>(null)
  const [task, setTask] = useState({
    title: '', type: 'follow_up' as TaskType,
    dueDate: defaultDueDate(), dueTime: DEFAULT_DUE_TIME, assignee: '',
  })

  const leads = `${count} lead${count === 1 ? '' : 's'}`

  // ── the result of the last action, with Undo ───────────────────────────────
  if (result) {
    const problems = result.failed.length + result.skipped.length
    return (
      <div className="fixed bottom-0 inset-x-0 z-30 px-3 pb-3 pointer-events-none">
        <div className="mx-auto max-w-3xl pointer-events-auto bg-white border border-gray-300 rounded-xl shadow-lg px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            <span className={`mt-px shrink-0 ${problems ? 'text-amber-600' : 'text-green-600'}`}>
              {problems ? <TriangleAlert size={15} strokeWidth={2} aria-hidden /> : <Check size={15} strokeWidth={2.5} aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-gray-900">
                {result.applied} lead{result.applied === 1 ? '' : 's'} updated
              </p>
              {(result.note || result.failed.length > 0) && (
                <p className="text-[11px] text-gray-600 mt-0.5 leading-snug">
                  {result.note}
                  {result.failed.length > 0 && ` ${result.failed.length} failed to write and ${result.failed.length === 1 ? 'was' : 'were'} left unchanged; the rest were saved.`}
                </p>
              )}
            </div>
            {result.undo && result.applied > 0 && (
              <button onClick={onUndo} disabled={busy}
                className="shrink-0 inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-800 hover:bg-gray-100 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {busy ? <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden /> : <Undo2 size={12} strokeWidth={2.5} aria-hidden />}
                Undo
              </button>
            )}
            <button onClick={onDismissResult} aria-label="Dismiss"
              className="shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors">
              <X size={13} strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (count === 0) return null

  return (
    <div className="fixed bottom-0 inset-x-0 z-30 px-3 pb-3 pointer-events-none">
      <div className="mx-auto max-w-3xl pointer-events-auto bg-white border border-gray-300 rounded-xl shadow-lg">

        {/* ── armed: say exactly what is about to happen ── */}
        {pending && (
          <div className="px-3 py-2.5 border-b border-gray-200 bg-amber-50 rounded-t-xl">
            {pending.kind === 'task' ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-900">
                  Add a task to {leads}
                </p>
                <input value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })}
                  placeholder="What needs doing? *" maxLength={200} autoFocus
                  className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-blue-500" />
                <div className="flex flex-wrap items-center gap-1.5">
                  <select value={task.type} onChange={(e) => setTask({ ...task, type: e.target.value as TaskType })}
                    aria-label="Task type"
                    className="bg-white border border-gray-300 rounded-lg px-1.5 py-1.5 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-500">
                    {TASK_TYPES.map((t) => <option key={t} value={t}>{TASK_TYPE_LABEL[t]}</option>)}
                  </select>
                  <input type="date" value={task.dueDate} onChange={(e) => setTask({ ...task, dueDate: e.target.value })}
                    aria-label="Due date"
                    className="bg-white border border-gray-300 rounded-lg px-1.5 py-1.5 text-[11px] text-gray-800 focus:outline-none focus:border-blue-500" />
                  <input type="time" value={task.dueTime} onChange={(e) => setTask({ ...task, dueTime: e.target.value })}
                    aria-label="Due time"
                    className="bg-white border border-gray-300 rounded-lg px-1.5 py-1.5 text-[11px] text-gray-800 focus:outline-none focus:border-blue-500" />
                  <select value={task.assignee} onChange={(e) => setTask({ ...task, assignee: e.target.value })}
                    aria-label="Assign to"
                    className="bg-white border border-gray-300 rounded-lg px-1.5 py-1.5 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-500">
                    <option value="">Me ({me.split('@')[0]})</option>
                    {owners.map((o) => <option key={o} value={o}>{o.split('@')[0]}</option>)}
                  </select>
                  <span className="text-[10px] text-gray-500">PKT</span>
                </div>
              </div>
            ) : (
              <p className="text-xs font-semibold text-gray-900">
                {pending.kind === 'stage'
                  ? <>Set {leads} to <span className="text-amber-800">{CRM_STAGE_LABEL[pending.stage]}</span></>
                  : pending.email
                    ? <>Assign {leads} to <span className="text-amber-800">{pending.email.split('@')[0]}</span></>
                    : <>Unassign {leads}</>}
              </p>
            )}

            <div className="flex items-center gap-1.5 mt-2">
              <button
                disabled={busy || (pending.kind === 'task' && !task.title.trim())}
                onClick={() => {
                  if (pending.kind === 'stage') {
                    onApply({ action: 'stage', stage: pending.stage }, `Set ${leads} to ${CRM_STAGE_LABEL[pending.stage]}`)
                  } else if (pending.kind === 'owner') {
                    onApply({ action: 'owner', email: pending.email }, pending.email ? `Assign ${leads}` : `Unassign ${leads}`)
                  } else {
                    onApply({ action: 'task', ...task }, `Add a task to ${leads}`)
                  }
                  setPending(null)
                }}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {busy ? <Loader2 size={12} strokeWidth={2.5} className="animate-spin" aria-hidden /> : <Check size={12} strokeWidth={2.5} aria-hidden />}
                Apply to {leads}
              </button>
              <button onClick={() => setPending(null)} disabled={busy}
                className="text-[11px] font-medium px-2 py-1.5 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <span className="text-[10px] text-gray-500 ml-auto">
                Undo is available afterwards.
              </span>
            </div>
          </div>
        )}

        {/* ── the bar itself ── */}
        <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
          <span className="text-xs font-semibold text-gray-900 tabular-nums shrink-0">
            {count} selected
            {allMatching && <span className="ml-1 font-normal text-gray-500">(all matching)</span>}
          </span>

          <span className="w-px h-4 bg-gray-300 hidden sm:block" />

          <select value="" disabled={busy} aria-label="Set stage for the selected leads"
            onChange={(e) => { if (e.target.value) setPending({ kind: 'stage', stage: e.target.value as CrmStage }) }}
            className="bg-white border border-gray-300 rounded-lg px-1.5 py-1 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-500 disabled:opacity-50">
            <option value="">Set stage…</option>
            {CRM_STAGES.map((s) => <option key={s} value={s}>{CRM_STAGE_LABEL[s]}</option>)}
          </select>

          <select value="" disabled={busy} aria-label="Set owner for the selected leads"
            onChange={(e) => { if (e.target.value) setPending({ kind: 'owner', email: e.target.value === '__none' ? '' : e.target.value }) }}
            className="bg-white border border-gray-300 rounded-lg px-1.5 py-1 text-[11px] text-gray-800 cursor-pointer focus:outline-none focus:border-blue-500 disabled:opacity-50">
            <option value="">Set owner…</option>
            <option value={me}>Me ({me.split('@')[0]})</option>
            {owners.filter((o) => o !== me).map((o) => <option key={o} value={o}>{o.split('@')[0]}</option>)}
            <option value="__none">Unassign</option>
          </select>

          <button onClick={() => setPending({ kind: 'task' })} disabled={busy}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-lg border border-gray-300 bg-white text-gray-800 hover:bg-gray-100 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            <ListTodo size={12} strokeWidth={2} aria-hidden /> Add task
          </button>

          <button onClick={onClear} disabled={busy}
            className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors disabled:opacity-50">
            <X size={12} strokeWidth={2} aria-hidden /> Clear
          </button>
        </div>
      </div>
    </div>
  )
}

// Re-exported so the list header can label its select-all control consistently.
export { ArrowRightLeft, UserRound }
