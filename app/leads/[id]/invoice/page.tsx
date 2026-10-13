'use client'

// /leads/[id]/invoice — build an invoice, see it as the customer will, then
// download the PDF or copy each field into PayPal's invoice form.
//
// The form is on the left and a live preview on the right, laid out like the
// team's own invoices (TPC-017, TWP-020, TDCS-019). The preview and the PDF
// share every number through lib/invoicedoc.ts, so what is on screen is what
// the customer gets. `?inv=<id>` opens a saved invoice for editing.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { ArrowLeft, Download, Plus, Save, Trash2 } from 'lucide-react'
import { CopyButton } from '../ui'
import {
  blankInvoice, dateLabel, lineCents, money, poNumber, prefixOf, rateLabel, shipParty, totals,
  type InvoiceDoc, type InvoiceItem, type InvoiceParty,
} from '@/lib/invoicedoc'

interface Loaded {
  invoices: InvoiceDoc[]
  prefill: InvoiceDoc
  lead: { id: string; name: string; email: string; siteId: string; siteName: string }
  prefix: string
  logoUrl: string
}

const input = 'w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
const label = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>()
  const search = useSearchParams()
  const [data, setData] = useState<Loaded | null>(null)
  const [doc, setDoc] = useState<InvoiceDoc>(blankInvoice())
  const [poTouched, setPoTouched] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const leadId = decodeURIComponent(id)
  const api = `/api/leads/${encodeURIComponent(leadId)}/invoices`

  useEffect(() => {
    let alive = true
    fetch(api).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j: Loaded) => {
      if (!alive) return
      setData(j)
      const want = search.get('inv')
      const existing = want ? j.invoices.find((d) => d.id === want) : undefined
      setDoc(existing ?? j.prefill)
      setPoTouched(!!existing)
    }).catch(() => { if (alive) setMsg({ ok: false, text: 'Could not load this lead.' }) })
    return () => { alive = false }
  }, [api, search])

  const update = useCallback((patch: Partial<InvoiceDoc>) => {
    setDoc((cur) => {
      const next = { ...cur, ...patch }
      // The PO number follows the invoice number, agent and date until
      // somebody types their own — then it is theirs.
      if (!poTouched && data) next.poNumber = poNumber(prefixOf(next.number, data.lead.siteName), next.agentName, next.date)
      return next
    })
    setDirty(true)
  }, [poTouched, data])

  const party = (key: 'billTo' | 'shipTo', patch: Partial<InvoiceParty>) => update({ [key]: { ...doc[key], ...patch } } as Partial<InvoiceDoc>)
  const item = (i: number, patch: Partial<InvoiceItem>) => update({ items: doc.items.map((it, n) => (n === i ? { ...it, ...patch } : it)) })

  async function save(): Promise<InvoiceDoc | null> {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc }) })
      const j = await r.json()
      if (!r.ok) { setMsg({ ok: false, text: j.error ?? 'Could not save.' }); return null }
      setDoc(j.invoice); setDirty(false); setPoTouched(true)
      setData((d) => d && ({ ...d, invoices: [j.invoice, ...d.invoices.filter((x) => x.id !== j.invoice.id)] }))
      const url = new URL(window.location.href); url.searchParams.set('inv', j.invoice.id); window.history.replaceState(null, '', url)
      setMsg({ ok: true, text: `Invoice #${j.invoice.number} saved on the lead.` })
      return j.invoice
    } catch { setMsg({ ok: false, text: 'Could not save.' }); return null } finally { setBusy(false) }
  }

  async function download() {
    const saved = dirty || !doc.id ? await save() : doc
    if (saved) window.location.href = `${api}/${encodeURIComponent(saved.id)}/pdf`
  }

  async function remove() {
    if (!doc.id || !window.confirm(`Remove invoice #${doc.number}?`)) return
    const r = await fetch(`${api}?inv=${encodeURIComponent(doc.id)}`, { method: 'DELETE' })
    if (r.ok && data) {
      setData({ ...data, invoices: data.invoices.filter((x) => x.id !== doc.id) })
      setDoc(data.prefill); setPoTouched(false); setDirty(false)
      setMsg({ ok: true, text: 'Invoice removed.' })
    }
  }

  const sums = useMemo(() => totals(doc), [doc])
  const ship = shipParty(doc)

  if (!data) {
    return <main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">{msg?.text ?? 'Loading…'}</main>
  }

  const paypal: [string, string][] = [
    ['Customer email', data.lead.email],
    ['Invoice number', doc.number],
    ...doc.items.flatMap((it, i): [string, string][] => [
      [`Item ${i + 1} name`, it.name],
      [`Item ${i + 1} description`, it.details.replace(/\n+/g, ', ')],
      [`Item ${i + 1} quantity`, it.quantity],
      [`Item ${i + 1} price`, String(Number(String(it.rate).replace(/[$,]/g, '')) || '')],
    ]),
    ['Note to customer', doc.notes],
    ['Terms and conditions', doc.terms],
    ['Total', money(sums.total, doc.currency)],
  ]

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <a href={`/leads/${encodeURIComponent(leadId)}`} className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900">
            <ArrowLeft size={15} aria-hidden /> {data.lead.name || 'Lead'}
          </a>
          <h1 className="text-base font-bold text-gray-900">{doc.id ? `Invoice #${doc.number}` : 'New invoice'}</h1>
          {data.invoices.length > 0 && (
            <select value={doc.id} onChange={(e) => {
              const d = data.invoices.find((x) => x.id === e.target.value)
              setDoc(d ?? data.prefill); setPoTouched(!!d); setDirty(false)
            }} className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700">
              <option value="">+ New invoice</option>
              {data.invoices.map((d) => <option key={d.id} value={d.id}>#{d.number} · {dateLabel(d.date)}</option>)}
            </select>
          )}
          <div className="ml-auto flex items-center gap-2">
            {msg && <span className={`text-xs ${msg.ok ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</span>}
            {doc.id && <button type="button" onClick={remove} title="Remove this invoice" className="rounded-lg border border-gray-300 p-1.5 text-gray-500 hover:text-red-700"><Trash2 size={14} aria-hidden /></button>}
            <button type="button" onClick={save} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
              <Save size={14} aria-hidden /> {dirty || !doc.id ? 'Save' : 'Saved'}
            </button>
            <button type="button" onClick={download} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              <Download size={14} aria-hidden /> Download PDF
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 lg:grid-cols-[minmax(340px,430px)_1fr]">
        {/* ── the form ───────────────────────────────────────────────── */}
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label} htmlFor="inv-number">Invoice #</label>
                <input id="inv-number" className={input} value={doc.number} placeholder={`${data.prefix}-001`}
                  onChange={(e) => update({ number: e.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="inv-agent">Agent</label>
                <input id="inv-agent" className={input} value={doc.agentName} placeholder="Steve Hayes" onChange={(e) => update({ agentName: e.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="inv-date">Date</label>
                <input id="inv-date" type="date" className={input} value={doc.date}
                  onChange={(e) => update({ date: e.target.value, dueDate: doc.dueDate === doc.date ? e.target.value : doc.dueDate })} />
              </div>
              <div>
                <label className={label} htmlFor="inv-due">Due date</label>
                <input id="inv-due" type="date" className={input} value={doc.dueDate} onChange={(e) => update({ dueDate: e.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="inv-terms">Payment terms</label>
                <input id="inv-terms" className={input} value={doc.paymentTerms} onChange={(e) => update({ paymentTerms: e.target.value })} />
              </div>
              <div>
                <label className={label} htmlFor="inv-po">PO number</label>
                <input id="inv-po" className={input} value={doc.poNumber}
                  onChange={(e) => { setPoTouched(true); update({ poNumber: e.target.value }) }} />
              </div>
            </div>
          </section>

          {(['billTo', 'shipTo'] as const).map((key) => (
            <section key={key} className="rounded-xl border border-gray-200 bg-white p-4 space-y-2.5">
              <div className="flex items-center">
                <h2 className="text-sm font-bold text-gray-800">{key === 'billTo' ? 'Bill to' : 'Ship to'}</h2>
                {key === 'shipTo' && (
                  <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-600">
                    <input type="checkbox" checked={doc.shipSame} onChange={(e) => update({ shipSame: e.target.checked })} /> Same as bill to
                  </label>
                )}
              </div>
              {(key === 'billTo' || !doc.shipSame) && (
                <>
                  <input aria-label="Name" className={input} placeholder="Name" value={doc[key].name} onChange={(e) => party(key, { name: e.target.value })} />
                  <input aria-label="Company" className={input} placeholder="Company (optional)" value={doc[key].company} onChange={(e) => party(key, { company: e.target.value })} />
                  <textarea aria-label="Address" className={input} rows={3} placeholder={'Street\nCity, State ZIP'} value={doc[key].address} onChange={(e) => party(key, { address: e.target.value })} />
                  <input aria-label="Phone" className={input} placeholder="Phone" value={doc[key].phone} onChange={(e) => party(key, { phone: e.target.value })} />
                </>
              )}
            </section>
          ))}

          <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-bold text-gray-800">Items</h2>
            {doc.items.map((it, i) => (
              <div key={i} className="rounded-lg border border-gray-200 p-2.5 space-y-2">
                <div className="flex gap-2">
                  <input aria-label="Item" className={input} placeholder="7oz Paper Cups with Lids" value={it.name} onChange={(e) => item(i, { name: e.target.value })} />
                  {doc.items.length > 1 && (
                    <button type="button" aria-label="Remove item" onClick={() => update({ items: doc.items.filter((_, n) => n !== i) })}
                      className="shrink-0 rounded-lg border border-gray-300 px-2 text-gray-500 hover:text-red-700"><Trash2 size={13} aria-hidden /></button>
                  )}
                </div>
                <textarea aria-label="Details" className={input} rows={3} placeholder={'Double Wall\nCustom Color Printing'} value={it.details} onChange={(e) => item(i, { details: e.target.value })} />
                <div className="grid grid-cols-3 gap-2 items-end">
                  <div><label className={label}>Quantity</label><input inputMode="numeric" className={input} value={it.quantity} placeholder="2000" onChange={(e) => item(i, { quantity: e.target.value })} /></div>
                  <div><label className={label}>Rate</label><input inputMode="decimal" className={input} value={it.rate} placeholder="0.52" onChange={(e) => item(i, { rate: e.target.value })} /></div>
                  <div className="pb-1.5 text-right text-sm font-semibold text-gray-700 tabular-nums">{money(lineCents(it) / 100, doc.currency)}</div>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <button type="button" onClick={() => update({ items: [...doc.items, { name: '', details: '', quantity: '', rate: '' }] })}
                className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Plus size={12} aria-hidden /> Add item</button>
              <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-600">Tax %
                <input inputMode="decimal" className="w-16 rounded-lg border border-gray-300 bg-white px-2 py-1 text-sm" value={doc.taxPercent} onChange={(e) => update({ taxPercent: e.target.value })} />
              </label>
              <select aria-label="Currency" value={doc.currency} onChange={(e) => update({ currency: e.target.value })} className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs">
                {['USD', 'CAD', 'AUD', 'GBP', 'EUR'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <div><label className={label} htmlFor="inv-notes">Notes</label>
              <textarea id="inv-notes" className={input} rows={4} value={doc.notes} onChange={(e) => update({ notes: e.target.value })} /></div>
            <div><label className={label} htmlFor="inv-tc">Terms</label>
              <textarea id="inv-tc" className={input} rows={2} value={doc.terms} onChange={(e) => update({ terms: e.target.value })} /></div>
          </section>
        </form>

        {/* ── the preview, and PayPal ─────────────────────────────────── */}
        <div className="space-y-4 min-w-0">
          <article aria-label="Invoice preview" className="rounded-xl border border-gray-200 bg-white p-6 sm:p-10 text-[13px] text-gray-800 shadow-sm overflow-x-auto">
            <div className="min-w-[560px]">
              <div className="flex items-start justify-between">
                <div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={data.logoUrl} alt={data.lead.siteName} className="max-h-12 max-w-[180px] object-contain" />
                  <p className="mt-5 font-bold">{doc.agentName}</p>
                </div>
                <div className="text-right">
                  <p className="text-4xl font-light tracking-tight text-gray-700">INVOICE</p>
                  <p className="mt-1 text-gray-500"># {doc.number || `${data.prefix}-001`}</p>
                </div>
              </div>
              <div className="mt-10 grid grid-cols-[1fr_1fr_1.3fr] gap-5">
                {[['Bill To:', doc.billTo], ['Ship To:', ship]].map(([title, p]) => {
                  const pp = p as InvoiceParty
                  return (
                    <div key={title as string}>
                      <p className="text-gray-500">{title as string}</p>
                      <p className="font-bold">{pp.name}</p>
                      {pp.company && <p>{pp.company}</p>}
                      {pp.address && <p className="whitespace-pre-line">{pp.address}</p>}
                      {pp.phone && <p>{pp.phone}</p>}
                    </div>
                  )
                })}
                <div className="space-y-2">
                  {[['Date:', dateLabel(doc.date)], ['Payment Terms:', doc.paymentTerms], ['Due Date:', dateLabel(doc.dueDate || doc.date)], ...(doc.poNumber ? [['PO Number:', doc.poNumber]] : [])].map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3"><span className="text-gray-500">{k}</span><span>{v}</span></div>
                  ))}
                  <div className="flex justify-between gap-3 rounded-md bg-gray-100 px-3 py-2 font-bold text-[14px]"><span>Balance Due:</span><span className="tabular-nums">{money(sums.total, doc.currency)}</span></div>
                </div>
              </div>
              <table className="mt-8 w-full border-collapse">
                <thead>
                  <tr className="bg-gray-800 text-white">
                    <th className="rounded-l-md px-3 py-1.5 text-left font-normal">Item</th>
                    <th className="px-3 py-1.5 text-left font-normal w-24">Quantity</th>
                    <th className="px-3 py-1.5 text-right font-normal w-24">Rate</th>
                    <th className="rounded-r-md px-3 py-1.5 text-right font-normal w-28">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.items.map((it, i) => (
                    <tr key={i} className="align-top">
                      <td className="px-3 py-3"><p className="font-bold">{it.name}</p>{it.details && <p className="whitespace-pre-line text-gray-500">{it.details}</p>}</td>
                      <td className="px-3 py-3">{it.quantity}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{it.rate ? rateLabel(it.rate, doc.currency) : ''}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{money(lineCents(it) / 100, doc.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="ml-auto mt-6 w-64 space-y-1.5">
                {[['Subtotal:', sums.subtotal], [`Tax (${Number(doc.taxPercent) || 0}%):`, sums.tax], ['Total:', sums.total]].map(([k, v]) => (
                  <div key={k as string} className="flex justify-between"><span className="text-gray-500">{k as string}</span><span className="tabular-nums">{money(v as number, doc.currency)}</span></div>
                ))}
              </div>
              {doc.notes && <div className="mt-8"><p className="text-gray-500">Notes:</p><p className="whitespace-pre-line">{doc.notes}</p></div>}
              {doc.terms && <div className="mt-4"><p className="text-gray-500">Terms:</p><p className="whitespace-pre-line">{doc.terms}</p></div>}
            </div>
          </article>

          <section className="rounded-xl border border-gray-200 bg-white p-4">
            <h2 className="text-sm font-bold text-gray-800">Copy into PayPal</h2>
            <p className="mt-0.5 text-xs text-gray-500">Each field in the order PayPal&apos;s invoice form asks for it.</p>
            <dl className="mt-3 divide-y divide-gray-100">
              {paypal.filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="flex items-start gap-3 py-1.5">
                  <dt className="w-40 shrink-0 text-xs font-semibold text-gray-500">{k}</dt>
                  <dd className="min-w-0 flex-1 whitespace-pre-line break-words text-sm text-gray-800">{v}</dd>
                  <CopyButton value={v} />
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </main>
  )
}
