'use client'

// Kanban board — seven stage columns in funnel order.
//
// Built from the record page's design system: the same Card shell, the same
// four-step type scale, the same stage palette (CRM_STAGE_STYLE / CRM_STAGE_DOT)
// and the same lucide treatment at one stroke weight. Authored in the light
// Tailwind utilities globals.css remaps, so dark mode follows the dashboard.
//
// Drag is native HTML5 — no drag library, per the "no new UI framework" rule.
// Every card also carries a stage <select> reachable by Tab, so a stage can
// always be changed without dragging (and that is the only mechanism on mobile,
// where this board is not rendered at all).

import { useState } from 'react'
import Link from 'next/link'
import { ListTodo, AlertTriangle, User, Building2, GripVertical } from 'lucide-react'
import { timeAgo } from '@/lib/datetime'
import {
  CRM_STAGE_LABEL, CRM_STAGE_STYLE, CRM_STAGE_DOT, formatMoney, type CrmStage,
} from '@/lib/crm'
import type { PipelineCard, PipelineColumn } from '@/lib/pipeline'
import { Skeleton } from '@/app/leads/[id]/ui'
import ColumnTotals from './ColumnTotals'
import StageSelect from './StageSelect'

export default function Board({
  columns, loading, movingId, loadingMore, onMove, onLoadMore,
}: {
  columns: PipelineColumn[]
  loading: boolean
  movingId: string | null
  loadingMore: CrmStage | null
  onMove: (card: PipelineCard, to: CrmStage) => void
  onLoadMore: (stage: CrmStage) => void
}) {
  const [dragging, setDragging] = useState<PipelineCard | null>(null)
  const [over, setOver] = useState<CrmStage | null>(null)

  return (
    <div className="flex gap-2.5 overflow-x-auto pb-3 items-start">
      {columns.map((col) => {
        const isOver = over === col.stage && dragging?.stage !== col.stage
        return (
          <section key={col.stage}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(col.stage) } }}
            onDragLeave={() => setOver((s) => (s === col.stage ? null : s))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              if (dragging && dragging.stage !== col.stage) onMove(dragging, col.stage)
              setDragging(null)
            }}
            className={`shrink-0 w-[248px] rounded-xl border transition-colors ${
              isOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-100/60'
            }`}>

            {/* Column header — the stage's own colour as a top rule, so seven
                columns read apart at a glance. */}
            <header className="px-2.5 pt-2 pb-1.5 border-b border-gray-200">
              <div className="h-0.5 rounded-full mb-2" style={{ backgroundColor: CRM_STAGE_DOT[col.stage] }} aria-hidden />
              <div className="flex items-center gap-1.5">
                <h2 className={`text-[11px] font-bold px-1.5 py-px rounded-full border ${CRM_STAGE_STYLE[col.stage]}`}>
                  {CRM_STAGE_LABEL[col.stage]}
                </h2>
                {/* The count is ALL matching leads, not the cards on screen. */}
                <span className="text-[11px] font-semibold text-gray-600 tabular-nums ml-auto">{col.count}</span>
              </div>
              <ColumnTotals totals={col.totals} unvalued={col.unvalued} count={col.count} />
            </header>

            <div className="p-1.5 space-y-1.5 min-h-[80px]">
              {loading ? (
                <>
                  <Skeleton className="h-[74px] w-full rounded-lg" />
                  <Skeleton className="h-[74px] w-full rounded-lg" />
                </>
              ) : col.cards.length === 0 ? (
                <p className="px-2 py-3 text-[11px] text-gray-400 text-center">
                  {isOver ? 'Drop to move here' : 'No leads'}
                </p>
              ) : (
                col.cards.map((card) => (
                  <BoardCard key={card.id} card={card} moving={movingId === card.id}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => { setDragging(null); setOver(null) }}
                    onMove={onMove} />
                ))
              )}

              {col.hasMore && !loading && (
                <button onClick={() => onLoadMore(col.stage)} disabled={loadingMore === col.stage}
                  className="w-full text-[11px] font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-lg py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50">
                  {loadingMore === col.stage
                    ? 'Loading…'
                    : `Show more (${col.count - col.cards.length} left)`}
                </button>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function BoardCard({ card, moving, onDragStart, onDragEnd, onMove }: {
  card: PipelineCard
  moving: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onMove: (card: PipelineCard, to: CrmStage) => void
}) {
  return (
    <article
      draggable={!moving}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); onDragStart() }}
      onDragEnd={onDragEnd}
      className={`group/card bg-white border border-gray-200 rounded-lg p-2 shadow-sm transition-opacity ${
        moving ? 'opacity-40' : 'hover:border-gray-300 cursor-grab active:cursor-grabbing'
      }`}>

      <div className="flex items-start gap-1">
        <GripVertical size={12} strokeWidth={2}
          className="text-gray-300 shrink-0 mt-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity" aria-hidden />
        <Link href={`/leads/${encodeURIComponent(card.id)}`}
          className="text-xs font-semibold text-gray-900 hover:text-blue-700 hover:underline leading-snug break-words min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
          {card.name}
        </Link>
        {card.value !== null && (
          <span className="ml-auto shrink-0 text-xs font-bold text-gray-900 tabular-nums">
            {formatMoney(card.value, card.currency)}
          </span>
        )}
      </div>

      <p className="flex items-center gap-1 mt-1 text-[10px] text-gray-500 min-w-0">
        <Building2 size={9} strokeWidth={2} className="shrink-0" aria-hidden />
        <span className="truncate" title={card.siteName}>{card.siteName}</span>
      </p>

      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 min-w-0">
          <User size={9} strokeWidth={2} className="shrink-0" aria-hidden />
          <span className="truncate max-w-[86px]">{card.owner ? card.owner.split('@')[0] : 'Unassigned'}</span>
        </span>
        {card.openTasks > 0 && (
          <span
            title={card.overdueTasks > 0 ? `${card.overdueTasks} overdue of ${card.openTasks} open` : `${card.openTasks} open`}
            className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 rounded border tabular-nums ${
              card.overdueTasks > 0
                ? 'bg-red-100 text-red-700 border-red-300'
                : 'bg-gray-200 text-gray-600 border-gray-300'
            }`}>
            {card.overdueTasks > 0
              ? <AlertTriangle size={8} strokeWidth={2.5} aria-hidden />
              : <ListTodo size={8} strokeWidth={2.5} aria-hidden />}
            {card.openTasks}
          </span>
        )}
        <span className="ml-auto text-[10px] text-gray-400 tabular-nums shrink-0">
          {card.lastActivityAt ? timeAgo(card.lastActivityAt) : '—'}
        </span>
      </div>

      {/* Keyboard / no-drag path. Hidden until hover or focus so it does not
          compete with the card, but always reachable by Tab. */}
      <div className="mt-1 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity">
        <StageSelect value={card.stage} disabled={moving}
          label={`Stage for ${card.name}`}
          onChange={(next) => onMove(card, next)} />
      </div>
    </article>
  )
}
