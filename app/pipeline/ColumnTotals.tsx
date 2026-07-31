'use client'

// Column money, and the one rule that matters: DIFFERENT CURRENCIES ARE NEVER
// ADDED TOGETHER.
//
// A lead's currency is per-lead (USD by default, changeable on the record page),
// so a column can legitimately hold $, £ and PKR at once. Adding those into a
// single figure would produce a number that means nothing — "$3,412,500" where
// most of it is rupees. There is no FX rate in this system and inventing one
// would be worse than not showing a total.
//
// So the header shows ONE currency's subtotal as the headline — the one the
// most leads in that column are denominated in, never the numerically largest,
// because "largest" across currencies is itself a comparison we cannot make.
// A "+N cur" chip flags that other currencies exist; the full per-currency
// breakdown, and how many leads carry no value at all, are on hover and in the
// aria-label.

import { formatMoney } from '@/lib/crm'
import type { CurrencyTotal } from '@/lib/pipeline'

export default function ColumnTotals({ totals, unvalued, count }: {
  totals: CurrencyTotal[]
  unvalued: number
  count: number
}) {
  if (count === 0) return <p className="mt-0.5 text-[10px] text-gray-400">—</p>

  if (totals.length === 0) {
    return (
      <p className="mt-0.5 text-[10px] text-gray-400" title={`${unvalued} lead${unvalued === 1 ? '' : 's'} with no value set`}>
        No value set
      </p>
    )
  }

  const [primary, ...rest] = totals
  const breakdown = totals.map((t) => `${formatMoney(t.total, t.currency)} across ${t.leads} lead${t.leads === 1 ? '' : 's'}`)
  if (unvalued > 0) breakdown.push(`${unvalued} lead${unvalued === 1 ? '' : 's'} with no value`)
  const full = breakdown.join('\n')

  return (
    <p className="mt-0.5 flex items-baseline gap-1 min-w-0" title={full}
      aria-label={`Column value: ${breakdown.join('; ')}`}>
      <span className="text-xs font-bold text-gray-900 tabular-nums truncate">
        {formatMoney(primary.total, primary.currency)}
      </span>
      {rest.length > 0 && (
        <span className="shrink-0 text-[9px] font-semibold px-1 rounded bg-amber-100 text-amber-700 border border-amber-300"
          aria-hidden>
          +{rest.length} cur
        </span>
      )}
      {unvalued > 0 && rest.length === 0 && (
        <span className="shrink-0 text-[9px] text-gray-400 tabular-nums" aria-hidden>+{unvalued} n/a</span>
      )}
    </p>
  )
}
