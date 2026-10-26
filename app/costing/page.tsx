'use client'
// Costing — the production cost of each sale, entered by whoever knows it
// (lib/costing.ts). The orders show what was made, never what it sold for.
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react'
import { COST_LABELS, type CostingBucket, type CostingItem } from '@/lib/costing'
import { PRODUCTION_LABEL } from '@/lib/salescore'

interface Line { id: string; label: string; amount: string; note: string }

const TABS: { key: CostingBucket; label: string; hint: string }[] = [
  { key: 'needs', label: 'Needs a cost', hint: 'Paid orders with no production cost yet. Enter what each one cost to make.' },
  { key: 'unpaid', label: 'Not paid yet', hint: 'Waiting for the customer’s payment. Add the cost once production starts.' },
  { key: 'done', label: 'Costed', hint: 'Orders from the last 45 days that have a cost. Fix a figure here if it was wrong.' },
]

const INPUT = 'rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900'
const toLines = (it: CostingItem): Line[] =>
  it.costs.length ? it.costs.map((c) => ({ id: c.id, label: c.label, amount: String(c.amount), note: c.note })) : [{ id: '', label: COST_LABELS[0], amount: '', note: '' }]
const pkr = (n: number) => `Rs ${Math.round(n).toLocaleString('en-PK')}`

function OrderCard({ item, onSaved }: { item: CostingItem; onSaved: (next: CostingItem | null, id: string) => void }) {
  const [lines, setLines] = useState<Line[]>(() => toLines(item))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const total = lines.reduce((a, l) => a + (Number(l.amount.replace(/[,\s]/g, '')) || 0), 0)
  const set = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)))

  async function save() {
    setBusy(true); setErr('')
    const r = await fetch('/api/costing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saleId: item.id, costs: lines.filter((l) => l.amount.trim()) }),
    })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setErr(j.error || 'Could not save'); return }
    onSaved(j.item ?? null, item.id)
  }

  const facts: [string, string][] = ([
    ['Size', item.size], ['Material', item.material], ['Printing', item.printing], ['Quantity', item.quantity],
  ] as [string, string][]).filter(([, v]) => v && v.trim())

  return (
    <li className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-bold text-gray-900">{item.customer || 'Customer'}{item.company ? <span className="font-normal text-gray-500"> · {item.company}</span> : null}</h2>
        <span className="text-xs text-gray-500">{item.orderDate}{item.country ? ` · ${item.country}` : ''}</span>
        {item.production && <span className="rounded-full border border-gray-300 bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-700">{PRODUCTION_LABEL[item.production]}</span>}
        {item.leadId && <a className="ml-auto text-xs font-semibold text-blue-700 hover:underline" href={`/leads/${encodeURIComponent(item.leadId)}`}>Open lead</a>}
      </div>
      <p className="mt-1 text-sm text-gray-800">{item.product || 'Packaging order'}</p>
      {facts.length > 0 && (
        <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600">
          {facts.map(([k, v]) => <div key={k}><dt className="inline font-semibold">{k}:</dt> <dd className="inline">{v}</dd></div>)}
        </dl>
      )}
      {item.reference && <p className="mt-0.5 text-[11px] text-gray-500">Ref: {item.reference}</p>}

      {item.editable ? (
        <div className="mt-3 space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-[11rem_9rem_1fr_auto] gap-2">
              <input list="cost-labels" aria-label="What the cost is for" className={INPUT} value={l.label} onChange={(e) => set(i, 'label', e.target.value)} />
              <input inputMode="decimal" aria-label="Amount in rupees" placeholder="Rs" className={`${INPUT} tabular-nums`} value={l.amount} onChange={(e) => set(i, 'amount', e.target.value)} />
              <input aria-label="Note" placeholder="Note (vendor, bill no.)" className={INPUT} value={l.note} onChange={(e) => set(i, 'note', e.target.value)} />
              <button type="button" aria-label="Remove this line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                className="justify-self-start p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-700"><Trash2 size={15} aria-hidden /></button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="button" onClick={() => setLines((ls) => [...ls, { id: '', label: COST_LABELS[ls.length] ?? 'Other', amount: '', note: '' }])}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50"><Plus size={13} aria-hidden /> Add a line</button>
            <span className="text-sm text-gray-700">Total <b className="tabular-nums">{pkr(total)}</b></span>
            <button type="button" disabled={busy} onClick={() => void save()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"><Save size={14} aria-hidden /> {busy ? 'Saving…' : 'Save cost'}</button>
          </div>
          {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
        </div>
      ) : (
        <p className="mt-3 text-xs text-gray-600">This order was costed in another currency. Ask the owner to change it from Sales.</p>
      )}
    </li>
  )
}

export default function CostingPage() {
  const [items, setItems] = useState<CostingItem[] | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<CostingBucket>('needs')

  useEffect(() => {
    try { document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark') } catch { /* ignore */ }
    void fetch('/api/costing').then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(j.error || 'Not allowed'); return }
      setItems(j.items)
    })
  }, [])

  const counts = useMemo(() => {
    const c: Record<CostingBucket, number> = { needs: 0, unpaid: 0, done: 0 }
    for (const it of items ?? []) c[it.bucket]++
    return c
  }, [items])
  const shown = (items ?? []).filter((it) => it.bucket === tab)

  function onSaved(next: CostingItem | null, id: string) {
    setItems((list) => (list ?? []).flatMap((it) => (it.id !== id ? [it] : next ? [next] : [])))
  }

  return (
    <main className="min-h-screen bg-gray-100">
      <datalist id="cost-labels">{COST_LABELS.map((l) => <option key={l} value={l} />)}</datalist>
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <a href="/" aria-label="Back" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"><ArrowLeft size={16} aria-hidden /></a>
          <div>
            <h1 className="text-base font-bold text-gray-900">Costing</h1>
            <p className="text-xs text-gray-500">What each order cost to make, in rupees. Printing, material, die, inserts, packing and shipping, one line each.</p>
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-4 flex gap-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm font-semibold border-b-2 ${tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-600 hover:text-gray-900'}`}>
              {t.label} <span className={`ml-1 rounded-full px-1.5 text-[11px] ${t.key === 'needs' && counts.needs > 0 ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600'}`}>{counts[t.key]}</span>
            </button>
          ))}
        </div>
      </header>
      <div className="max-w-4xl mx-auto p-4 space-y-3">
        {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
        {items === null && !err && <p className="text-sm text-gray-500">Loading…</p>}
        {items && <p className="text-xs text-gray-500">{TABS.find((t) => t.key === tab)?.hint}</p>}
        <ul className="space-y-3">
          {shown.map((it) => <OrderCard key={`${it.id}-${it.updatedAt}`} item={it} onSaved={onSaved} />)}
        </ul>
        {items && shown.length === 0 && <p className="text-sm text-gray-500">{tab === 'needs' ? 'Every paid order has a cost. Nothing to do.' : 'Nothing here.'}</p>}
      </div>
    </main>
  )
}
