'use client'

// The record page's invoice card: one button and the list. The invoice itself
// is built on its own page (/leads/[id]/invoice) — the record was already the
// busiest screen in the CRM, and an invoice needs room for a form AND the
// preview beside it. It opens in a new tab (owner, 2026-10-13) so the record
// stays open behind it.

import { useEffect, useState } from 'react'
import { FileText, Download, Plus } from 'lucide-react'
import { Card } from './ui'
import { dateLabel, money, totals, type InvoiceDoc } from '@/lib/invoicedoc'

export default function Invoices({ leadId }: { leadId: string }) {
  const [list, setList] = useState<InvoiceDoc[] | null>(null)
  const base = `/leads/${encodeURIComponent(leadId)}/invoice`
  useEffect(() => {
    let alive = true
    fetch(`/api/leads/${encodeURIComponent(leadId)}/invoices?list=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) setList(j?.invoices ?? []) })
      .catch(() => { if (alive) setList([]) })
    return () => { alive = false }
  }, [leadId])

  return (
    <Card title="Invoices" icon={FileText}
      action={
        <a href={base} target="_blank" rel="noopener"
          className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg border border-blue-300 bg-blue-100 text-blue-700 hover:bg-blue-200">
          <Plus size={12} strokeWidth={2.5} aria-hidden /> Create invoice
        </a>
      }>
      <div className="px-3 py-2">
        {list === null ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-xs text-gray-500">No invoice yet. Create one when the customer is ready to pay.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {list.map((d) => (
              <li key={d.id} className="flex items-center gap-2 py-1.5 text-xs">
                <a href={`${base}?inv=${encodeURIComponent(d.id)}`} target="_blank" rel="noopener" className="font-semibold text-blue-700 hover:underline">#{d.number}</a>
                <span className="text-gray-500">{dateLabel(d.date)}</span>
                <span className="ml-auto font-semibold text-gray-700 tabular-nums">{money(totals(d).total, d.currency)}</span>
                <a href={`/api/leads/${encodeURIComponent(leadId)}/invoices/${encodeURIComponent(d.id)}/pdf`}
                  title="Download PDF" className="text-gray-500 hover:text-gray-700"><Download size={13} aria-hidden /></a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}
