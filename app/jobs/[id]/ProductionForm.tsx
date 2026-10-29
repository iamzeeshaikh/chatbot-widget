'use client'

// The production form on a production job (lib/jobs.ts ProductionForm): the
// editor the CSR fills in, and the printed sheet laid out like the team's
// spreadsheet (Taylor_IH-029.xlsx) with signature lines left blank for pen.

import { Plus, Printer, Trash2 } from 'lucide-react'
import { blankProductionItem, ORDER_TYPES, type ProductionForm as Form, type ProductionItem } from '@/lib/jobs'

const input = 'w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
const label = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

/** "2026-10-28" → "10/28/2026", as the sheet writes dates. */
const us = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[2]}/${m[3]}/${m[1]}` : '' }

const ITEM_COLS: { key: keyof ProductionItem; label: string; hint: string }[] = [
  { key: 'product', label: 'Product', hint: 'Punch insert' },
  { key: 'stock', label: 'Stock', hint: '310gsm cream natural' },
  { key: 'size', label: 'Finish size (L×W×D) in.', hint: '5 x 4.5 x 1"' },
  { key: 'lamination', label: 'Lamination', hint: 'Gloss' },
  { key: 'printing', label: 'Printing', hint: 'CMYK / NA' },
  { key: 'quantity', label: 'Quantity', hint: '250' },
]

export function ProductionFormEditor({ form, fromDraft, onChange, onPrint, contactsHidden }: {
  form: Form; fromDraft: boolean; onChange: (f: Form) => void; onPrint: () => void; contactsHidden: boolean
}) {
  const set = (p: Partial<Form>) => onChange({ ...form, ...p })
  const field = (k: keyof Form, text: string, type = 'text', hint = '') => (
    <div>
      <label className={label}>{text}</label>
      <input type={type} className={input} value={String(form[k] ?? '')} placeholder={hint} onChange={(e) => set({ [k]: e.target.value } as Partial<Form>)} />
    </div>
  )
  const setItem = (i: number, p: Partial<ProductionItem>) => set({ items: form.items.map((x, n) => (n === i ? { ...x, ...p } : x)) })

  return (
    <section className="rounded-xl border border-emerald-200 bg-white p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-sm font-bold text-gray-800">Production form</h2>
        {fromDraft && <span className="rounded-full border border-amber-300 bg-amber-100 px-2 text-[11px] font-semibold text-amber-700">Filled from the invoice — check it, then Save changes</span>}
        <button type="button" onClick={onPrint} className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100">
          <Printer size={14} aria-hidden /> Print / PDF
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {field('invoiceNo', 'Invoice no.', 'text', 'IH-029')}
        {field('jobNo', 'Job no.', 'text', 'IH-SK-10282026')}
        {field('orderDate', 'Order date', 'date')}
        {field('csr', 'CSR name')}
        <div>
          <label className={label}>Order type</label>
          <select className={`${input} ${form.orderType === 'Rush' ? 'font-bold text-red-700' : ''}`} value={form.orderType} onChange={(e) => set({ orderType: e.target.value })}>
            {ORDER_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        {field('printerDeadline', "Printer's deadline", 'date')}
        {field('deliveryDate', 'Delivery date', 'date')}
        {field('folderPath', 'Folder path')}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-500">
            {ITEM_COLS.map((c) => <th key={c.key} className="py-1.5 pr-2 font-semibold">{c.label}</th>)}<th />
          </tr></thead>
          <tbody>
            {form.items.map((it, i) => (
              <tr key={i} className="border-t border-gray-100">
                {ITEM_COLS.map((c) => (
                  <td key={c.key} className={`py-1.5 pr-2 ${c.key === 'quantity' ? 'w-24' : ''}`}>
                    <input aria-label={c.label} className={input} value={it[c.key]} placeholder={c.hint} onChange={(e) => setItem(i, { [c.key]: e.target.value })} />
                  </td>
                ))}
                <td className="py-1.5 pl-1">{form.items.length > 1 && <button type="button" aria-label="Remove line" onClick={() => set({ items: form.items.filter((_, n) => n !== i) })} className="text-gray-400 hover:text-red-700"><Trash2 size={13} aria-hidden /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => set({ items: [...form.items, blankProductionItem()] })}
        className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Plus size={12} aria-hidden /> Add product</button>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="col-span-2 sm:col-span-4">{field('addOn', 'Add on', 'text', 'Window, insert, handle, ribbon')}</div>
        {field('handoverToDesigner', 'Handover to designer', 'date')}
        {field('sentToProduction', 'Sent to production', 'date')}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-600">Designer detail</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {([['die', 'Box die & dimension'], ['color', 'Color'], ['quantity', 'Quantity'], ['stock', 'Stock'], ['addOn', 'Add on']] as const).map(([k, t]) => (
            <div key={k}><label className={label}>{t}</label>
              <input className={input} value={form.designer[k]} onChange={(e) => set({ designer: { ...form.designer, [k]: e.target.value } })} /></div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-600">Client information</p>
        {contactsHidden ? (
          <p className="text-xs text-gray-500">Client: {form.client.name || '—'} · phone and address are kept by the CSR.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {([['name', 'Client name'], ['phone', 'Phone no.'], ['company', 'Company']] as const).map(([k, t]) => (
              <div key={k}><label className={label}>{t}</label>
                <input className={input} value={form.client[k]} onChange={(e) => set({ client: { ...form.client, [k]: e.target.value } })} /></div>
            ))}
            <div className="col-span-2 sm:col-span-3"><label className={label}>Ship-to address</label>
              <textarea rows={2} className={input} value={form.client.address} onChange={(e) => set({ client: { ...form.client, address: e.target.value } })} /></div>
          </div>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-600">Shipping</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          {([['via', 'Ship via', 'text'], ['date', 'Shipping date', 'date'], ['weight', 'Weight', 'text'], ['cartons', 'No. of cartons', 'text'], ['quantity', 'Quantity', 'text'], ['tracking', 'Tracking no(s).', 'text']] as const).map(([k, t, type]) => (
            <div key={k}><label className={label}>{t}</label>
              <input type={type} className={input} value={form.shipping[k]} onChange={(e) => set({ shipping: { ...form.shipping, [k]: e.target.value } })} /></div>
          ))}
        </div>
        <div className="mt-3"><label className={label}>Shipper review</label>
          <textarea rows={2} className={input} value={form.shipperReview} onChange={(e) => set({ shipperReview: e.target.value })} /></div>
      </div>
    </section>
  )
}

// ── the printed sheet ───────────────────────────────────────────────────────
// Black on white whatever the screen theme is, so it is plain inline colours.
const cell: React.CSSProperties = { border: '1px solid #000', padding: '5px 7px', fontSize: 12, verticalAlign: 'top', color: '#000' }
const head: React.CSSProperties = { ...cell, fontWeight: 700, background: '#e5e7eb' }
const band: React.CSSProperties = { ...cell, fontWeight: 700, textAlign: 'center', background: '#d1d5db', fontSize: 13 }

export function ProductionSheet({ form, siteId, siteName }: { form: Form; siteId: string; siteName: string }) {
  const rows = Math.max(form.items.length, 3)
  return (
    <div className="production-sheet" style={{ color: '#000', background: '#fff', fontFamily: 'Arial, Helvetica, sans-serif' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup><col style={{ width: '18%' }} /><col style={{ width: '20%' }} /><col style={{ width: '16%' }} /><col style={{ width: '16%' }} /><col style={{ width: '14%' }} /><col style={{ width: '16%' }} /></colgroup>
        <tbody>
          <tr>
            <td colSpan={3} rowSpan={2} style={{ ...cell, textAlign: 'center', verticalAlign: 'middle' }}>
              {siteId
                ? <img src={`/api/logo/${encodeURIComponent(siteId)}`} alt={siteName} style={{ maxHeight: 56, maxWidth: '100%', display: 'inline-block' }} onError={(e) => { (e.currentTarget as HTMLImageElement).replaceWith(document.createTextNode(siteName)) }} />
                : <b>{siteName}</b>}
            </td>
            <td style={head}>Invoice No.</td><td colSpan={2} style={cell}>{form.invoiceNo}</td>
          </tr>
          <tr><td style={head}>Job No.</td><td colSpan={2} style={cell}>{form.jobNo}</td></tr>
          <tr>
            <td colSpan={3} style={{ ...band, fontSize: 16 }}>PRODUCTION FORM</td>
            <td style={head}>Order Date</td><td colSpan={2} style={cell}>{us(form.orderDate)}</td>
          </tr>
          <tr>
            <td style={head}>CSR Name</td><td colSpan={2} style={cell}>{form.csr}</td>
            <td style={head}>Order Type</td>
            <td colSpan={2} style={{ ...cell, fontWeight: 700, color: form.orderType === 'Rush' ? '#b91c1c' : '#000' }}>{form.orderType}</td>
          </tr>
          <tr>
            <td style={head}>Printer&apos;s Deadline</td><td colSpan={2} style={cell}>{us(form.printerDeadline)}</td>
            <td style={head}>Delivery Date</td><td colSpan={2} style={cell}>{us(form.deliveryDate)}</td>
          </tr>
          <tr>{['Product', 'Stock', 'Finish Size (LWD) in.', 'Lamination', 'Printing', 'Quantity'].map((h) => <td key={h} style={head}>{h}</td>)}</tr>
          {Array.from({ length: rows }, (_, i) => form.items[i] ?? blankProductionItem()).map((it, i) => (
            <tr key={i} style={{ height: 26 }}>
              <td style={cell}>{it.product}</td><td style={cell}>{it.stock}</td><td style={cell}>{it.size}</td>
              <td style={cell}>{it.lamination}</td><td style={cell}>{it.printing}</td><td style={cell}>{it.quantity}</td>
            </tr>
          ))}
          <tr><td style={head}>Add On</td><td colSpan={5} style={cell}>{form.addOn}</td></tr>
          <tr>
            <td colSpan={2} style={head}>Handover to Designer:</td><td style={cell}>{us(form.handoverToDesigner)}</td>
            <td colSpan={2} style={head}>Sent to Production:</td><td style={cell}>{us(form.sentToProduction)}</td>
          </tr>
          <tr style={{ height: 34 }}>
            <td colSpan={2} style={head}>Output Head Signature:</td><td style={cell} />
            <td style={head}>CSR Signature:</td><td colSpan={2} style={cell} />
          </tr>
          <tr><td colSpan={6} style={band}>DESIGNER DETAIL</td></tr>
          <tr>{['Box Die & Dimension', 'Color', 'Quantity', 'Stock', 'Add On', 'Signature'].map((h) => <td key={h} style={head}>{h}</td>)}</tr>
          <tr style={{ height: 30 }}>
            <td style={cell}>{form.designer.die}</td><td style={cell}>{form.designer.color}</td><td style={cell}>{form.designer.quantity}</td>
            <td style={cell}>{form.designer.stock}</td><td style={cell}>{form.designer.addOn}</td><td style={cell} />
          </tr>
          <tr><td colSpan={6} style={band}>CLIENT INFORMATION</td></tr>
          <tr><td style={head}>Client Name</td><td colSpan={5} style={cell}>{form.client.name}</td></tr>
          <tr>
            <td style={head}>Phone No</td><td colSpan={2} style={cell}>{form.client.phone}</td>
            <td style={head}>Company</td><td colSpan={2} style={cell}>{form.client.company}</td>
          </tr>
          <tr><td style={head}>Address</td><td colSpan={5} style={{ ...cell, whiteSpace: 'pre-line' }}>{form.client.address}</td></tr>
          <tr><td style={head}>Folder Path:</td><td colSpan={5} style={cell}>{form.folderPath}</td></tr>
          <tr>{['Ship Via', 'Shipping Date', 'Weight', 'No. of Cartons', 'Quantity', 'Tracking No(s).'].map((h) => <td key={h} style={head}>{h}</td>)}</tr>
          <tr style={{ height: 30 }}>
            <td style={cell}>{form.shipping.via}</td><td style={cell}>{us(form.shipping.date)}</td><td style={cell}>{form.shipping.weight}</td>
            <td style={cell}>{form.shipping.cartons}</td><td style={cell}>{form.shipping.quantity}</td><td style={{ ...cell, wordBreak: 'break-all' }}>{form.shipping.tracking}</td>
          </tr>
          <tr style={{ height: 40 }}>
            <td style={head}>Shipper Review</td><td colSpan={4} style={{ ...cell, whiteSpace: 'pre-line' }}>{form.shipperReview}</td>
            <td style={{ ...cell, fontWeight: 700 }}>Signature</td>
          </tr>
          <tr><td colSpan={6} style={{ ...cell, fontStyle: 'italic', fontSize: 11 }}>If approvals were required and the shipping department shipped without verifying, then the shipping department is responsible.</td></tr>
        </tbody>
      </table>
    </div>
  )
}
