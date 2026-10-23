'use client'
// Send a price quote from the portal (Saifullah, 2026-10-22). Left: the form
// with the price table. Right: the email exactly as it will go (lib/pricequote.ts
// builds both). Send → from the agent's own mailbox on the site's address,
// stage Quote Sent, value recorded, bot follows up the next day.
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import { ArrowLeft, Download, Plus, Send, Trash2, X } from 'lucide-react'
import { blankItem, blankQuote, dealValue, orderTotals, money, normalizeQuote, quoteHtml, quoteProblems, quoteTitle, type PriceQuote, type QuoteItem, type QuoteRow } from '@/lib/pricequote'

interface Setup { name: string; siteId: string; siteName: string; toKnown: boolean; cc: string[]; aliases: { email: string; displayName: string }[]; replyTo: { title: string } | null }
const input = 'w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'
const label = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

export default function QuotePage() {
  const { id } = useParams<{ id: string }>()
  const leadId = decodeURIComponent(id)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [q, setQ] = useState<PriceQuote | null>(null)
  const [from, setFrom] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState(false)
  const [attachPdf, setAttachPdf] = useState(true)
  const [pdfBusy, setPdfBusy] = useState(false)
  const key = `zee-quote-${leadId}`

  useEffect(() => {
    fetch(`/api/leads/${encodeURIComponent(leadId)}/price-quote`).then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setErr(j.error || 'Could not load this lead'); return }
      setSetup(j)
      let saved: PriceQuote | null = null
      try { const raw = JSON.parse(localStorage.getItem(key) || 'null'); saved = raw ? normalizeQuote(raw) : null } catch { saved = null }
      setQ(saved ?? blankQuote(j.name || '', ''))
      const site = String(j.siteId || '').replace(/-/g, '')
      const pick = (j.aliases as Setup['aliases']).find((a) => a.email.split('@')[1]?.replace(/\./g, '').startsWith(site.slice(0, 8))) ?? j.aliases[0]
      setFrom(pick?.email ?? '')
      setCc((j.cc as string[]).join(', '))
    })
  }, [leadId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (q) try { localStorage.setItem(key, JSON.stringify(q)) } catch { /* private mode */ } }, [q, key])

  const set = (p: Partial<PriceQuote>) => setQ((x) => (x ? { ...x, ...p } : x))
  const setItem = (k: number, p: Partial<QuoteItem>) => setQ((x) => (x ? { ...x, items: x.items.map((it, n) => (n === k ? { ...it, ...p } : it)) } : x))
  const setRow = (k: number, i: number, p: Partial<QuoteRow>) => setQ((x) => (x ? { ...x, items: x.items.map((it, n) => (n === k ? { ...it, rows: it.rows.map((r, m) => (m === i ? { ...r, ...p } : r)) } : it)) } : x))
  const html = useMemo(() => (q ? quoteHtml(q, { pdf: attachPdf }) : ''), [q, attachPdf])
  const problems = q ? quoteProblems(q) : []
  const value = q ? dealValue(q) : 0
  const totals = q ? orderTotals(q) : []

  async function send() {
    if (!q) return
    setBusy(true); setErr('')
    const r = await fetch(`/api/leads/${encodeURIComponent(leadId)}/price-quote`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote: q, attachPdf, from, cc, subject: subject || (setup?.replyTo ? '' : `Price quote — ${quoteTitle(q)} - ${setup?.siteName ?? ''}`) }),
    })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setErr(j.error || 'The quote did not send'); return }
    try { localStorage.removeItem(key) } catch { /* ignore */ }
    setDone(true)
    setTimeout(() => { window.location.href = `/leads/${encodeURIComponent(leadId)}` }, 1500)
  }

  async function downloadPdf() {
    if (!q) return
    setPdfBusy(true); setErr('')
    const r = await fetch(`/api/leads/${encodeURIComponent(leadId)}/price-quote/pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quote: q }),
    })
    setPdfBusy(false)
    if (!r.ok) { const j = await r.json().catch(() => ({})); setErr(j.error || 'Could not make the PDF'); return }
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'Price Quotation.pdf'
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  if (err && !setup) return <main className="p-8 text-sm text-red-700">{err}</main>
  if (!setup || !q) return <main className="p-8 text-sm text-gray-500">Loading…</main>
  return (
    <main className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1300px] mx-auto px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <a href={`/leads/${encodeURIComponent(leadId)}`} aria-label="Back to the lead" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"><ArrowLeft size={16} aria-hidden /></a>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-gray-900">Send price quote</h1>
            <p className="text-xs text-gray-500">{setup.name || 'Customer'} · {setup.siteName}{setup.replyTo ? ' · replies in the customer\'s email thread' : ''}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {problems.length > 0 && <span className="text-xs text-amber-700">Add {problems.join(' and ')}</span>}
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-700 select-none">
              <input type="checkbox" checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} /> Attach quotation PDF
            </label>
            <button type="button" disabled={pdfBusy || problems.length > 0} onClick={() => void downloadPdf()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              <Download size={14} aria-hidden /> {pdfBusy ? 'Making PDF…' : 'Download PDF'}
            </button>
            <button type="button" disabled={busy || done || problems.length > 0 || !from || !setup.toKnown} onClick={() => void send()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
              <Send size={14} aria-hidden /> {done ? 'Sent ✓' : busy ? 'Sending…' : 'Send quote'}
            </button>
          </div>
        </div>
        {err && <p role="alert" className="max-w-[1300px] mx-auto px-4 pb-2 text-xs text-red-700">{err}</p>}
      </header>
      <div className="max-w-[1300px] mx-auto p-4 grid lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="q-from">From</label>
              <select id="q-from" className={input} value={from} onChange={(e) => setFrom(e.target.value)}>
                {setup.aliases.length === 0 && <option value="">Connect Gmail first</option>}
                {setup.aliases.map((a) => <option key={a.email} value={a.email}>{a.email}</option>)}
              </select></div>
            <div><label className={label} htmlFor="q-cc">Cc (customer&apos;s colleagues)</label>
              <input id="q-cc" className={input} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="nobody" /></div>
          </div>
          {!setup.replyTo && <div><label className={label} htmlFor="q-subj">Subject</label>
            <input id="q-subj" className={input} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={`Price quote — ${quoteTitle(q) || 'your boxes'} - ${setup.siteName}`} /></div>}
          <div className="grid grid-cols-3 gap-3">
            <div><label className={label} htmlFor="q-hi">Greeting name</label><input id="q-hi" className={input} value={q.greetingName} onChange={(e) => set({ greetingName: e.target.value })} /></div>
            <div className="col-span-2"><label className={label} htmlFor="q-intro">Opening line</label><input id="q-intro" className={input} value={q.intro} onChange={(e) => set({ intro: e.target.value })} /></div>
          </div>
          {q.items.map((it, k) => (
            <div key={k} className="rounded-lg border border-gray-300 bg-gray-50 p-3 space-y-2">
              <div className="flex items-end gap-2">
                <div className="flex-1"><label className={label} htmlFor={`q-prod-${k}`}>Product {q.items.length > 1 ? k + 1 : ''}</label>
                  <input id={`q-prod-${k}`} className={input} value={it.product} onChange={(e) => setItem(k, { product: e.target.value })} placeholder={k === 0 ? 'Custom Lipstick Boxes' : 'Custom Mascara Boxes'} /></div>
                {q.items.length > 1 && <button type="button" aria-label={`Remove product ${k + 1}`} onClick={() => set({ items: q.items.filter((_, n) => n !== k) })} className="mb-1 inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-gray-500 hover:bg-red-50 hover:text-red-700"><X size={13} aria-hidden /> Remove</button>}
              </div>
              <div><label className={label} htmlFor={`q-opt-${k}`}>Option (optional — e.g. a delivery time; options are never added together)</label>
                <input id={`q-opt-${k}`} className={input} value={it.option ?? ''} onChange={(e) => setItem(k, { option: e.target.value })} placeholder="Standard delivery 18-22 business days" /></div>
              <div><label className={label} htmlFor={`q-specs-${k}`}>Specifications (one per line)</label>
                <textarea id={`q-specs-${k}`} className={input} rows={3} value={it.specs} onChange={(e) => setItem(k, { specs: e.target.value })} placeholder={'Size: 2 x 2 x 4 in\n16pt SBS, matte lamination\n4-color printing outside'} /></div>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-[11px] text-gray-500"><th className="pb-1 pr-2 font-semibold">Quantity</th><th className="pb-1 pr-2 font-semibold">Unit price ($)</th><th className="pb-1 pr-2 font-semibold text-right">Total</th><th /></tr></thead>
                <tbody>
                  {it.rows.map((r, i) => {
                    const total = (Number(r.quantity.replace(/[^0-9.]/g, '')) || 0) * (Number(r.unitPrice.replace(/[^0-9.]/g, '')) || 0)
                    return (
                      <tr key={i}>
                        <td className="py-1 pr-2"><input aria-label="Quantity" className={input} inputMode="numeric" value={r.quantity} onChange={(e) => setRow(k, i, { quantity: e.target.value })} placeholder="500" /></td>
                        <td className="py-1 pr-2"><input aria-label="Unit price" className={input} inputMode="decimal" value={r.unitPrice} onChange={(e) => setRow(k, i, { unitPrice: e.target.value })} placeholder="0.85" /></td>
                        <td className="py-1 pr-2 text-right tabular-nums font-semibold">{total ? money(Math.round(total * 100) / 100) : '—'}</td>
                        <td className="py-1">{it.rows.length > 1 && <button type="button" aria-label="Remove row" onClick={() => setItem(k, { rows: it.rows.filter((_, n) => n !== i) })} className="text-gray-400 hover:text-red-700"><Trash2 size={14} aria-hidden /></button>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <button type="button" onClick={() => setItem(k, { rows: [...it.rows, { quantity: '', unitPrice: '' }] })} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Plus size={12} aria-hidden /> Add quantity</button>
            </div>
          ))}
          <button type="button" disabled={q.items.length >= 15} onClick={() => set({ items: [...q.items, blankItem()] })}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50">
            <Plus size={14} aria-hidden /> Add another product
          </button>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
            <label className="inline-flex items-center gap-1.5 select-none font-semibold text-gray-700">
              <input type="checkbox" checked={q.showTotal !== false} onChange={(e) => set({ showTotal: e.target.checked })} /> Show order total
            </label>
            {totals.map((t) => <span key={t.label || 'all'}>{t.label ? `Total — ${t.label}` : `Order total (${t.count} products)`}: <b>{money(t.total)}</b></span>)}
            {q.showTotal !== false && totals.length === 0 && q.items.length > 1 && <span>No total shown (a product has more than one quantity).</span>}
          </div>
          <div><label className={label} htmlFor="q-inc">Included (one per line)</label><textarea id="q-inc" className={input} rows={3} value={q.included} onChange={(e) => set({ included: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label} htmlFor="q-turn">Turnaround</label><input id="q-turn" className={input} value={q.turnaround} onChange={(e) => set({ turnaround: e.target.value })} /></div>
            <div><label className={label} htmlFor="q-valid">Valid for</label><input id="q-valid" className={input} value={q.validity} onChange={(e) => set({ validity: e.target.value })} /></div>
          </div>
          <div><label className={label} htmlFor="q-close">Closing line</label><textarea id="q-close" className={input} rows={2} value={q.closing} onChange={(e) => set({ closing: e.target.value })} /></div>
          <p className="text-[11px] text-gray-500">Sending moves the stage to Quote Sent, records {value ? money(value) : 'the first total of each product'} as the deal value, and the bot sends the first follow-up the next day if the customer does not answer. Your signature is added automatically.</p>
        </section>
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-3">Preview — what the customer gets{cc ? ` (cc ${cc})` : ''}</p>
          <div className="text-[14px] leading-relaxed text-gray-800" dangerouslySetInnerHTML={{ __html: html }} />
          <p className="text-[12px] text-gray-400 mt-2">+ your email signature{attachPdf ? ' · 📎 quotation PDF attached' : ''}</p>
        </section>
      </div>
    </main>
  )
}
