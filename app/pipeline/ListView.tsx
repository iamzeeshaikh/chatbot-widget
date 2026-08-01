'use client'

// The list mode — the same leads as the board, as a sortable table, and the
// default on small screens where dragging a card is not a real interaction.
//
// Sorting happens over the cards currently loaded across all columns. That is
// stated in the footer rather than implied, so a sorted "top by value" is never
// mistaken for the top of the whole pipeline.

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, ChevronsUpDown, ListTodo, AlertTriangle } from 'lucide-react'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { formatMoney, type CrmStage } from '@/lib/crm'
import type { PipelineCard } from '@/lib/pipeline'
import { EmptyLine } from '@/app/leads/[id]/ui'
import StageSelect from './StageSelect'

type SortKey = 'name' | 'siteName' | 'stage' | 'value' | 'owner' | 'lastActivityAt' | 'openTasks'

const COLUMNS: { key: SortKey; label: string; align?: 'right'; hideSm?: boolean }[] = [
  { key: 'name', label: 'Lead' },
  { key: 'siteName', label: 'Site', hideSm: true },
  { key: 'stage', label: 'Stage' },
  { key: 'value', label: 'Value', align: 'right' },
  { key: 'owner', label: 'Owner', hideSm: true },
  { key: 'lastActivityAt', label: 'Last activity', align: 'right', hideSm: true },
  { key: 'openTasks', label: 'Tasks', align: 'right' },
]

// Stage order is funnel order, not alphabetical — sorting by stage should walk
// the pipeline.
import { CRM_STAGES } from '@/lib/crm'
const stageRank = (s: CrmStage) => CRM_STAGES.indexOf(s)

export default function ListView({ cards, movingId, onMove, loading }: {
  cards: PipelineCard[]
  movingId: string | null
  onMove: (card: PipelineCard, to: CrmStage) => void
  loading: boolean
}) {
  const [sort, setSort] = useState<SortKey>('lastActivityAt')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')

  const sorted = useMemo(() => {
    const mul = dir === 'asc' ? 1 : -1
    return [...cards].sort((a, b) => {
      switch (sort) {
        case 'value': {
          // Leads with no value always sink, whichever way the column is sorted
          // — an empty cell is not "worth less than $1".
          if (a.value === null && b.value === null) return 0
          if (a.value === null) return 1
          if (b.value === null) return -1
          return (a.value - b.value) * mul
        }
        case 'openTasks': return (a.openTasks - b.openTasks) * mul
        case 'stage': return (stageRank(a.stage) - stageRank(b.stage)) * mul
        case 'lastActivityAt': return (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? '') * mul
        case 'owner': return (a.owner ?? '').localeCompare(b.owner ?? '') * mul
        case 'siteName': return a.siteName.localeCompare(b.siteName) * mul
        default: return a.name.localeCompare(b.name) * mul
      }
    })
  }, [cards, sort, dir])

  function toggle(key: SortKey) {
    if (key === sort) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(key); setDir(key === 'name' || key === 'siteName' || key === 'owner' ? 'asc' : 'desc') }
  }

  if (!loading && cards.length === 0) {
    return (
      <section className="bg-white border border-gray-200 rounded-xl shadow-sm">
        <EmptyLine icon={ListTodo} text="No leads match these filters." />
      </section>
    )
  }

  return (
    <section className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-gray-200">
              {COLUMNS.map((c) => {
                const active = sort === c.key
                return (
                  <th key={c.key} scope="col"
                    aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`px-2.5 py-1.5 ${c.align === 'right' ? 'text-right' : 'text-left'} ${c.hideSm ? 'hidden sm:table-cell' : ''}`}>
                    <button onClick={() => toggle(c.key)}
                      className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded ${
                        active ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'
                      } ${c.align === 'right' ? 'flex-row-reverse' : ''}`}>
                      {c.label}
                      {active
                        ? (dir === 'asc' ? <ArrowUp size={10} strokeWidth={2.5} aria-hidden /> : <ArrowDown size={10} strokeWidth={2.5} aria-hidden />)
                        : <ChevronsUpDown size={10} strokeWidth={2} className="text-gray-400" aria-hidden />}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-gray-100">
                    {COLUMNS.map((c) => (
                      <td key={c.key} className={`px-2.5 py-2 ${c.hideSm ? 'hidden sm:table-cell' : ''}`}>
                        <div className="h-3 bg-gray-200 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : sorted.map((card) => (
                  <tr key={card.id} className={`border-b border-gray-100 hover:bg-gray-100 transition-colors ${movingId === card.id ? 'opacity-40' : ''}`}>
                    <td className="px-2.5 py-1.5 min-w-0">
                      <Link href={`/leads/${encodeURIComponent(card.id)}`}
                        className="text-xs font-medium text-gray-900 hover:text-blue-700 hover:underline break-words focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                        {card.name}
                      </Link>
                      <span className="block sm:hidden text-[10px] text-gray-500 truncate">{card.siteName}</span>
                    </td>
                    <td className="px-2.5 py-1.5 hidden sm:table-cell">
                      <span className="text-xs text-gray-700 truncate block max-w-[150px]" title={card.siteName}>{card.siteName}</span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <div className="w-[124px]">
                        <StageSelect value={card.stage} disabled={movingId === card.id}
                          label={`Stage for ${card.name}`} onChange={(next) => onMove(card, next)} />
                      </div>
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      <span className="text-xs font-semibold text-gray-900 tabular-nums">
                        {card.value === null ? <span className="text-gray-400 font-normal">—</span> : formatMoney(card.value, card.currency)}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 hidden sm:table-cell">
                      <span className="text-xs text-gray-700">{card.owner ? card.owner.split('@')[0] : <span className="text-gray-400">Unassigned</span>}</span>
                    </td>
                    <td className="px-2.5 py-1.5 text-right hidden sm:table-cell">
                      <span className="text-[11px] text-gray-500 tabular-nums whitespace-nowrap"
                        title={card.lastActivityAt ? formatDateTime(card.lastActivityAt) : undefined}>
                        {card.lastActivityAt ? timeAgo(card.lastActivityAt) : '—'}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      {card.openTasks === 0 ? (
                        <span className="text-[11px] text-gray-300">—</span>
                      ) : (
                        <span title={card.overdueTasks > 0 ? `${card.overdueTasks} overdue of ${card.openTasks} open` : `${card.openTasks} open`}
                          className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 rounded border tabular-nums ${
                            card.overdueTasks > 0 ? 'bg-red-100 text-red-700 border-red-300' : 'bg-gray-200 text-gray-600 border-gray-300'
                          }`}>
                          {card.overdueTasks > 0
                            ? <AlertTriangle size={8} strokeWidth={2.5} aria-hidden />
                            : <ListTodo size={8} strokeWidth={2.5} aria-hidden />}
                          {card.openTasks}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && (
        <p className="px-2.5 py-1.5 text-[10px] text-gray-500 border-t border-gray-100">
          Showing <span className="tabular-nums font-medium">{cards.length}</span> loaded lead{cards.length === 1 ? '' : 's'}.
          Sorting applies to these; use “Show more” on the board to pull in the rest of a stage.
        </p>
      )}
    </section>
  )
}
