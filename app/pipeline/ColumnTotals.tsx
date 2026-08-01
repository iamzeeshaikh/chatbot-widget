'use client'

// The money line under a column heading, and the one rule that matters:
// DIFFERENT CURRENCIES ARE NEVER ADDED TOGETHER.
//
// A lead's currency is per-lead (USD by default, changeable on the record page),
// so a column can legitimately hold $, £ and PKR at once. Adding those into one
// figure would produce a number that means nothing. There is no FX rate in this
// system and inventing one would be worse than showing no total.
//
// So one currency's subtotal is the headline — the one the MOST leads in that
// column are denominated in, never the numerically largest, because "largest"
// across currencies is itself a comparison we cannot make. A "+N" chip flags
// that others exist; the full breakdown is on hover and in the aria-label.
//
// Nothing is printed when a column has no money in it: "No value set" under a
// column of 401 new leads was noise, not information.

import { formatMoney } from '@/lib/crm'
import type { CurrencyTotal } from '@/lib/pipeline'

export default function ColumnTotals({ totals, count, loaded }: {
  totals: CurrencyTotal[]
  count: number
  /** Cards actually on screen, so the header can say "12 of 401". */
  loaded: number
}) {
  const showProgress = count > loaded && loaded > 0

  if (totals.length === 0) {
    // No money and nothing paged — the header says everything already.
    if (!showProgress) return null
    return (
      <p className="mt-0.5 text-[9px] text-gray-500 tabular-nums">
        showing {loaded} of {count}
      </p>
    )
  }

  const [primary, ...rest] = totals
  const breakdown = totals.map((t) => `${formatMoney(t.total, t.currency)} across ${t.leads} lead${t.leads === 1 ? '' : 's'}`)
  const full = breakdown.join('\n')

  return (
    <p className="mt-0.5 flex items-baseline gap-1 min-w-0" title={full}
      aria-label={`Column value: ${breakdown.join('; ')}`}>
      <span className="text-[10px] font-bold text-gray-800 tabular-nums truncate">
        {formatMoney(primary.total, primary.currency)}
      </span>
      {rest.length > 0 && (
        <span className="shrink-0 text-[8px] font-semibold px-1 rounded bg-amber-100 text-amber-700 border border-amber-300" aria-hidden>
          +{rest.length}
        </span>
      )}
      {showProgress && (
        <span className="ml-auto shrink-0 text-[9px] text-gray-500 tabular-nums">{loaded}/{count}</span>
      )}
    </p>
  )
}
