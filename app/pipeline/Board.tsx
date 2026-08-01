'use client'

// Kanban board — seven stage columns in funnel order.
//
// ── Shape ────────────────────────────────────────────────────────────────────
// The BOARD owns the viewport height, not the page: the page never scrolls
// vertically, each column scrolls its own list. All seven columns flex to share
// the width so nothing is hidden behind a horizontal scrollbar on a normal
// desktop, and every column — empty or not — is a full-height drop target, so an
// empty stage looks like somewhere a card can go rather than a stub.
//
// Cards are sized by their content: a lead with no deal value and no tasks gets
// a short card instead of reserving space for numbers it does not have. The
// stage colour rides on a left border so a card still reads as belonging to its
// column while it is being dragged out of one.
//
// Drag is native HTML5 — no drag library. Every card also carries a stage
// <select> reachable by Tab, so a stage can always be changed without dragging
// (and that is the only mechanism on mobile, where this board is not rendered).

import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { ListTodo, AlertTriangle, User, Building2, GripVertical, Loader2 } from 'lucide-react'
import { timeAgo } from '@/lib/datetime'
import {
  CRM_STAGE_LABEL, CRM_STAGE_STYLE, CRM_STAGE_DOT, formatMoney, type CrmStage,
} from '@/lib/crm'
import type { PipelineCard, PipelineColumn } from '@/lib/pipeline'
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
    // min-w keeps the columns readable on a smaller laptop by allowing a
    // horizontal scroll there; from ~1020px up all seven simply fit.
    <div className="h-full overflow-x-auto">
      <div className="flex gap-1.5 h-full min-w-[980px]">
        {columns.map((col) => (
          <Column key={col.stage} col={col} loading={loading} movingId={movingId}
            loadingMore={loadingMore} onMove={onMove} onLoadMore={onLoadMore}
            dragging={dragging} setDragging={setDragging}
            isOver={over === col.stage && dragging?.stage !== col.stage}
            setOver={setOver} />
        ))}
      </div>
    </div>
  )
}

function Column({
  col, loading, movingId, loadingMore, onMove, onLoadMore, dragging, setDragging, isOver, setOver,
}: {
  col: PipelineColumn
  loading: boolean
  movingId: string | null
  loadingMore: CrmStage | null
  onMove: (card: PipelineCard, to: CrmStage) => void
  onLoadMore: (stage: CrmStage) => void
  dragging: PipelineCard | null
  setDragging: (c: PipelineCard | null) => void
  isOver: boolean
  setOver: (s: CrmStage | null) => void
}) {
  const tint = CRM_STAGE_DOT[col.stage]
  const busy = loadingMore === col.stage

  // Load more as the column is scrolled rather than making someone find a button
  // at the bottom of four hundred cards. Guarded so a fast scroll cannot fire it
  // repeatedly for the same page.
  const asked = useRef(0)
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!col.hasMore || busy) return
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return
    if (asked.current === col.cards.length) return
    asked.current = col.cards.length
    onLoadMore(col.stage)
  }, [col.hasMore, col.cards.length, col.stage, busy, onLoadMore])

  return (
    <section
      onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(col.stage) } }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(null)
        if (dragging && dragging.stage !== col.stage) onMove(dragging, col.stage)
        setDragging(null)
      }}
      // flex-1 basis-0 is what makes all seven share the width evenly.
      className={`flex-1 basis-0 min-w-0 flex flex-col rounded-lg border transition-colors ${
        isOver ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-100/60'
      }`}>

      {/* ── header: coloured rule, tinted ground, count front and centre ── */}
      <header className="shrink-0 rounded-t-lg overflow-hidden" style={{ backgroundColor: `${tint}12` }}>
        <div className="h-[3px]" style={{ backgroundColor: tint }} aria-hidden />
        <div className="px-2 pt-1.5 pb-1.5">
          <div className="flex items-baseline gap-1.5 min-w-0">
            <h2 className={`text-[10px] font-bold px-1.5 rounded-full border truncate ${CRM_STAGE_STYLE[col.stage]}`}>
              {CRM_STAGE_LABEL[col.stage]}
            </h2>
            <span className="ml-auto text-sm font-bold text-gray-900 tabular-nums leading-none">{col.count}</span>
          </div>
          <ColumnTotals totals={col.totals} count={col.count} loaded={col.cards.length} />
        </div>
      </header>

      {/* ── the list: this is what scrolls, never the page ── */}
      <div onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-1 space-y-1">
        {loading ? (
          <>
            <div className="h-14 rounded-md bg-gray-200 animate-pulse" />
            <div className="h-14 rounded-md bg-gray-200 animate-pulse" />
            <div className="h-14 rounded-md bg-gray-200 animate-pulse" />
          </>
        ) : col.cards.length === 0 ? (
          // A full-height, dashed drop target — an empty stage should look like
          // somewhere a card belongs, not like a broken column.
          <div className={`h-full min-h-[120px] rounded-md border border-dashed flex items-center justify-center px-2 transition-colors ${
            isOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300'
          }`}>
            <p className="text-[10px] text-gray-400 text-center leading-snug">
              {isOver ? 'Drop to move here' : 'No leads'}
            </p>
          </div>
        ) : (
          <>
            {col.cards.map((card) => (
              <BoardCard key={card.id} card={card} moving={movingId === card.id}
                onDragStart={() => setDragging(card)}
                onDragEnd={() => { setDragging(null); setOver(null) }}
                onMove={onMove} />
            ))}
            {busy && (
              <p className="flex items-center justify-center gap-1 py-2 text-[10px] text-gray-500">
                <Loader2 size={10} strokeWidth={2.5} className="animate-spin" aria-hidden />
                Loading more…
              </p>
            )}
            {!busy && col.hasMore && (
              // A visible fallback for anyone who does not scroll (and for
              // keyboard users, who never fire a scroll event).
              <button onClick={() => onLoadMore(col.stage)}
                className="w-full text-[10px] font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-200 rounded-md py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                Load more
              </button>
            )}
          </>
        )}
      </div>
    </section>
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
      // The stage colour lives on a left border so the card still reads as
      // belonging to its column mid-drag, when it is no longer inside one.
      style={{ borderLeftWidth: 3, borderLeftColor: CRM_STAGE_DOT[card.stage] }}
      className={`group/card relative bg-white border border-gray-200 rounded-md px-1.5 py-1 shadow-sm transition-opacity ${
        moving ? 'opacity-40' : 'hover:border-gray-300 cursor-grab active:cursor-grabbing'
      }`}>

      <div className="flex items-start gap-1 min-w-0">
        <GripVertical size={10} strokeWidth={2}
          className="text-gray-400 shrink-0 mt-[3px] opacity-0 group-hover/card:opacity-100 transition-opacity" aria-hidden />
        <Link href={`/leads/${encodeURIComponent(card.id)}`}
          className="text-[11px] font-semibold text-gray-900 hover:text-blue-700 hover:underline leading-tight break-words min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
          {card.name}
        </Link>
        {/* Only when there is one — most leads have no value, and reserving a
            slot for it is what made every card tall and half empty. */}
        {card.value !== null && (
          <span className="ml-auto shrink-0 text-[11px] font-bold text-gray-900 tabular-nums leading-tight">
            {formatMoney(card.value, card.currency)}
          </span>
        )}
      </div>

      <p className="flex items-center gap-1 mt-0.5 text-[9px] text-gray-500 min-w-0">
        <Building2 size={8} strokeWidth={2} className="shrink-0" aria-hidden />
        <span className="truncate" title={card.siteName}>{card.siteName}</span>
      </p>

      <div className="flex items-center gap-1 mt-0.5 min-w-0">
        <User size={8} strokeWidth={2} className="text-gray-400 shrink-0" aria-hidden />
        <span className="text-[9px] text-gray-500 truncate">
          {card.owner ? card.owner.split('@')[0] : 'Unassigned'}
        </span>
        {/* Likewise: no badge at all when there are no tasks. */}
        {card.openTasks > 0 && (
          <span
            title={card.overdueTasks > 0 ? `${card.overdueTasks} overdue of ${card.openTasks} open` : `${card.openTasks} open`}
            className={`shrink-0 inline-flex items-center gap-0.5 text-[9px] font-semibold px-1 rounded border tabular-nums ${
              card.overdueTasks > 0
                ? 'bg-red-100 text-red-700 border-red-300'
                : 'bg-gray-200 text-gray-600 border-gray-300'
            }`}>
            {card.overdueTasks > 0
              ? <AlertTriangle size={7} strokeWidth={2.5} aria-hidden />
              : <ListTodo size={7} strokeWidth={2.5} aria-hidden />}
            {card.openTasks}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[9px] text-gray-400 tabular-nums">
          {card.lastActivityAt ? timeAgo(card.lastActivityAt) : '—'}
        </span>
      </div>

      {/* Keyboard / no-drag path. Absolutely positioned so it costs the card no
          height when hidden — the card stays as short as its content. */}
      <div className="absolute inset-x-1 bottom-1 opacity-0 group-hover/card:opacity-100 focus-within:opacity-100 transition-opacity">
        <StageSelect value={card.stage} disabled={moving}
          label={`Stage for ${card.name}`}
          onChange={(next) => onMove(card, next)} />
      </div>
    </article>
  )
}
