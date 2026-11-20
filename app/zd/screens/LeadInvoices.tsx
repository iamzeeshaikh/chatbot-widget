'use client'

// Invoices on a lead record: the list of saved invoices, the builder that
// opens in a drawer (form on one side, the invoice as the customer will see it
// on the other), the PDF download, sending through PayPal and the payment link.
//
// Every number shown here comes from lib/invoicedoc.ts, the same arithmetic the
// saved copy and the PDF use, so the three cannot disagree about a total.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Copy, Download, Link2, Mail, MessageCircle, Plus, Save, Send, Trash2 } from 'lucide-react'
import { isBankTransfer } from '@/lib/bankdetails'
import { isInvoiceable, type CrmStage } from '@/lib/crm'
import { formatDateTime } from '@/lib/datetime'
import {
  blankInvoice, dateLabel, lineCents, money, poNumber, prefixOf, rateLabel, shipParty, totals,
  type InvoiceDoc, type InvoiceItem, type InvoiceParty,
} from '@/lib/invoicedoc'
import { BTN_DANGER, BTN_PLAIN, BTN_PRIMARY, CARD, Drawer, INPUT, LABEL, Notice, TEXTAREA, postJson, short } from '../ui'

interface Loaded {
  invoices: InvoiceDoc[]
  prefill: InvoiceDoc
  lead: { id: string; name: string; email: string; siteId: string; siteName: string }
  prefix: string
  logoUrl: string
  /** PayPal is available for this lead. */
  paypal?: boolean
  /** Bank details printed when the payment terms say wire / bank transfer. */
  bank?: string
}
type Channel = 'email' | 'whatsapp'
/** What the server is willing to tell THIS member about the payment link. */
interface LinkState {
  present: boolean
  canEdit: boolean
  canSend: boolean
  channels: Channel[]
  channel: Channel | null
  waWindowOpen: boolean | null
  /** Only for a member who may see customer contacts. */
  url: string | null
  savedBy: string
  savedAt: string
  lastSent: { by: string; at: string; channel: Channel } | null
}
interface Msg { ok: boolean; text: string }
type Ask = { kind: 'remove' } | { kind: 'discard' } | { kind: 'paypal'; inv: InvoiceDoc }

const SECTION = 'text-[11px] font-semibold uppercase tracking-wide text-[#68737d]'
const SELECT = `${INPUT} cursor-pointer`
const ICON_BTN = 'w-7 h-7 shrink-0 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed] hover:text-[#2f3941] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40'
const PANEL = 'rounded-lg border border-[#d8dcde] bg-white p-4 space-y-3'
const CURRENCIES = ['USD', 'CAD', 'AUD', 'GBP', 'EUR']

const who = (email: string) => (email.includes('@') ? short(email) : email)

/** Writes to the clipboard from inside the click that asked for it, and falls
 *  back to a hidden text box where the clipboard API is missing or refused. */
function copyText(text: string): Promise<boolean> {
  const viaBox = () => {
    try {
      const box = document.createElement('textarea')
      box.value = text
      box.setAttribute('readonly', '')
      box.style.position = 'fixed'
      box.style.opacity = '0'
      document.body.appendChild(box)
      box.select()
      const ok = document.execCommand('copy')
      box.remove()
      return ok
    } catch { return false }
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, viaBox)
  }
  return Promise.resolve(viaBox())
}

function CopyBtn({ value, label = 'Copy', bare }: { value: string; label?: string; bare?: boolean }) {
  const [state, setState] = useState<'idle' | 'done' | 'blocked'>('idle')
  function onClick() {
    void copyText(value).then((ok) => {
      setState(ok ? 'done' : 'blocked')
      window.setTimeout(() => setState('idle'), 2000)
    })
  }
  const text = state === 'done' ? 'Copied' : state === 'blocked' ? 'Copy was blocked' : label
  const icon = state === 'done' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />
  if (bare) {
    return <button type="button" onClick={onClick} className={ICON_BTN} title={text} aria-label={`${text}: ${value}`}>{icon}</button>
  }
  return <button type="button" onClick={onClick} className={`${BTN_PLAIN} shrink-0`}>{icon}{text}</button>
}

// ── The section on the record ────────────────────────────────────────────────
export default function LeadInvoices({ leadId, stage, contactsHidden }: { leadId: string; stage: CrmStage; contactsHidden?: boolean }) {
  const [list, setList] = useState<InvoiceDoc[] | null>(null)
  const [failed, setFailed] = useState(false)
  /** '' is a new invoice, an id opens that one, null is closed. */
  const [open, setOpen] = useState<string | null>(null)
  const [linkTick, setLinkTick] = useState(0)
  const api = `/api/leads/${encodeURIComponent(leadId)}/invoices`

  useEffect(() => {
    let alive = true
    fetch(`${api}?list=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive) { setList(j?.invoices ?? []); setFailed(!j) } })
      .catch(() => { if (alive) { setList([]); setFailed(true) } })
    return () => { alive = false }
  }, [api])

  return (
    <section aria-label="Invoices">
      <div className="flex items-center gap-2">
        <h2 className={SECTION}>Invoices{list ? <span className="tabular-nums font-normal"> ({list.length})</span> : null}</h2>
        <button type="button" onClick={() => setOpen('')} className={`${BTN_PLAIN} ml-auto`}><Plus size={14} aria-hidden />New invoice</button>
      </div>

      {list === null ? (
        <div className="mt-2 h-9 rounded-md bg-[#e9ebed] animate-pulse"><span className="sr-only" role="status">Loading invoices</span></div>
      ) : failed ? (
        <div className="mt-2"><Notice text="The invoices could not be loaded." bad /></div>
      ) : list.length === 0 ? (
        <p className="mt-2 text-[12px] text-[#68737d]">No invoice yet. Create one when the customer is ready to pay.</p>
      ) : (
        <ul className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-1 pr-2">
              <button type="button" onClick={() => setOpen(d.id)} title="Open this invoice"
                className="min-w-0 flex-1 text-left px-3 py-2 hover:bg-[#f8f9f9] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium text-[#1f73b7]">#{d.number}</span>
                  <span className="ml-auto shrink-0 font-semibold tabular-nums">{money(totals(d).total, d.currency)}</span>
                </span>
                <span className="block truncate text-[11px] text-[#87929d]" title={d.updatedAt ? `Saved ${formatDateTime(d.updatedAt)}` : undefined}>
                  {[dateLabel(d.date), d.paymentTerms, d.updatedBy ? `saved by ${who(d.updatedBy)}` : ''].filter(Boolean).join(' · ')}
                </span>
              </button>
              <a href={`${api}/${encodeURIComponent(d.id)}/pdf`} className={ICON_BTN} title="Download PDF" aria-label={`Download invoice ${d.number} as a PDF`}>
                <Download size={14} aria-hidden />
              </a>
            </li>
          ))}
        </ul>
      )}

      {isInvoiceable(stage) && <PaymentLink leadId={leadId} tick={linkTick} />}

      {open !== null && (
        <Builder leadId={leadId} startId={open} contactsHidden={!!contactsHidden}
          onClose={() => setOpen(null)}
          onList={(next) => { setList(next); setFailed(false) }}
          onLinkChanged={() => setLinkTick((t) => t + 1)} />
      )}
    </section>
  )
}

// ── Payment link ─────────────────────────────────────────────────────────────
// An admin saves the link. Everybody else is told that one exists and can send
// it without reading it: the server resolves both the link and the recipient.
function PaymentLink({ leadId, tick }: { leadId: string; tick: number }) {
  const [state, setState] = useState<LinkState | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState<Channel | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [own, setOwn] = useState(0)
  const api = `/api/leads/${encodeURIComponent(leadId)}/payment-link`

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(api, { cache: 'no-store' })
        const j = await res.json().catch(() => ({}))
        if (!alive || !res.ok) return
        setState(j)
        if (j.url) setUrl(j.url)
      } catch { /* the rest of the section works without it */ }
    })()
    return () => { alive = false }
  }, [api, tick, own])

  async function save() {
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetch(api, postJson({ url }))
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(String(j.error || 'That did not save.')); return }
      setState(j); setMsg(url ? 'Saved.' : 'Cleared.')
    } catch { setErr('That did not save.') } finally { setBusy(false) }
  }

  async function send(channel: Channel) {
    setBusy(true); setSending(channel); setErr(''); setMsg('')
    try {
      const res = await fetch(`${api}/send`, postJson({ channel }))
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(String(j.error || 'That did not send.')); return }
      setMsg(j.channel === 'whatsapp' ? 'Sent on WhatsApp.' : 'Emailed to the customer.')
      setOwn((t) => t + 1)
    } catch { setErr('That did not send.') } finally { setBusy(false); setSending(null) }
  }

  if (!state) return null

  return (
    <div className={`${CARD} mt-3 p-3 space-y-2`}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-[#49545c]"><Link2 size={14} aria-hidden />Payment link</p>

      {state.canEdit ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <div className="flex items-center gap-1">
            <input className={INPUT} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://…" aria-label="Payment link" />
            {state.url && state.url === url && <CopyBtn value={state.url} bare label="Copy the payment link" />}
          </div>
          <p className="text-[11px] text-[#68737d]">PayPal, Wise, Stripe: any https payment link.</p>
          <button type="submit" disabled={busy} className={BTN_PLAIN}>{busy && !sending ? 'Saving…' : 'Save link'}</button>
        </form>
      ) : state.present ? (
        <p className="rounded-md border border-[#e9ebed] bg-[#f8f9f9] px-2.5 py-2 text-[12px] text-[#49545c]">
          <span className="font-mono tracking-widest text-[#2f3941]">••••••</span>
          <span className="ml-2">saved{state.savedBy ? ` by ${who(state.savedBy)}` : ''}. You can send it without seeing it.</span>
        </p>
      ) : (
        <p className="rounded-md border border-[#e9ebed] bg-[#f8f9f9] px-2.5 py-2 text-[12px] text-[#68737d]">
          No payment link on this lead yet. An admin adds it here, then you can send it.
        </p>
      )}

      {state.present && (
        <>
          <div className="flex flex-wrap gap-2">
            {state.channels.map((ch) => (
              <button key={ch} type="button" onClick={() => void send(ch)} disabled={busy || !state.canSend} className={BTN_PLAIN}>
                {ch === 'whatsapp' ? <MessageCircle size={14} aria-hidden /> : <Mail size={14} aria-hidden />}
                {sending === ch ? 'Sending…' : ch === 'whatsapp' ? 'Send on WhatsApp' : 'Email to customer'}
              </button>
            ))}
          </div>
          {state.channels.includes('whatsapp') && (
            state.waWindowOpen === false ? (
              <p className="text-[11px] text-[#ad5918]">
                WhatsApp only allows a free message within 24 hours of the customer&apos;s last one, and this conversation
                is outside that window. A WhatsApp send will not be delivered until they message first.
              </p>
            ) : state.channels.length === 1 ? (
              <p className="text-[11px] text-[#68737d]">This lead has no email address, so it goes to their WhatsApp instead.</p>
            ) : null
          )}
          {!state.canSend && (
            <p className="text-[11px] text-[#ad5918]">
              This lead has no email address and no phone number, so the link cannot be sent. Add one on the record first.
            </p>
          )}
        </>
      )}

      {state.lastSent && (
        <p className="text-[11px] text-[#68737d]" title={formatDateTime(state.lastSent.at)}>
          Last sent by {who(state.lastSent.by)}{state.lastSent.channel === 'whatsapp' ? ' on WhatsApp' : ' by email'}.
        </p>
      )}
      <Notice text={msg} />
      <Notice text={err} bad />
    </div>
  )
}

// ── The builder ──────────────────────────────────────────────────────────────
function Builder({ leadId, startId, contactsHidden, onClose, onList, onLinkChanged }: {
  leadId: string; startId: string; contactsHidden: boolean
  onClose: () => void; onList: (list: InvoiceDoc[]) => void; onLinkChanged: () => void
}) {
  const [data, setData] = useState<Loaded | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [doc, setDoc] = useState<InvoiceDoc>(blankInvoice())
  const [poTouched, setPoTouched] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [deposit, setDeposit] = useState('')
  /** The payer link PayPal returned for the invoice just sent. */
  const [payLink, setPayLink] = useState<{ number: string; url: string } | null>(null)
  const [wordmark, setWordmark] = useState(false)
  const [logoOk, setLogoOk] = useState(true)
  const api = `/api/leads/${encodeURIComponent(leadId)}/invoices`

  useEffect(() => {
    let alive = true
    fetch(api).then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((j: Loaded) => {
      if (!alive) return
      setData(j)
      const existing = startId ? j.invoices.find((d) => d.id === startId) : undefined
      setDoc(existing ?? j.prefill)
      setPoTouched(!!existing)
      onList(j.invoices)
    }).catch(() => { if (alive) setLoadErr('Could not load this lead.') })
    return () => { alive = false }
    // onList is the parent's setter wrapper; re-running the load for it would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, startId])

  const update = useCallback((patch: Partial<InvoiceDoc>) => {
    setDoc((cur) => {
      const next = { ...cur, ...patch }
      // The PO number follows the invoice number, agent and date until
      // somebody types their own. Then it is theirs.
      if (!poTouched && data) next.poNumber = poNumber(prefixOf(next.number, data.lead.siteName), next.agentName, next.date)
      return next
    })
    setDirty(true)
  }, [poTouched, data])

  const party = (key: 'billTo' | 'shipTo', patch: Partial<InvoiceParty>) => update({ [key]: { ...doc[key], ...patch } } as Partial<InvoiceDoc>)
  const item = (i: number, patch: Partial<InvoiceItem>) => update({ items: doc.items.map((it, n) => (n === i ? { ...it, ...patch } : it)) })

  function pick(id: string) {
    if (!data) return
    const d = data.invoices.find((x) => x.id === id)
    setDoc(d ?? data.prefill); setPoTouched(!!d); setDirty(false); setAsk(null); setMsg(null); setPayLink(null)
  }

  async function save(): Promise<InvoiceDoc | null> {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(api, postJson({ doc }))
      const j = await r.json()
      if (!r.ok) { setMsg({ ok: false, text: j.error ?? 'Could not save.' }); return null }
      const saved: InvoiceDoc = j.invoice
      setDoc(saved); setDirty(false); setPoTouched(true)
      if (data) {
        const invoices = [saved, ...data.invoices.filter((x) => x.id !== saved.id)]
        setData({ ...data, invoices })
        onList(invoices)
      }
      setMsg({ ok: true, text: `Invoice #${saved.number} saved on the lead.` })
      return saved
    } catch { setMsg({ ok: false, text: 'Could not save.' }); return null } finally { setBusy(false) }
  }

  async function download() {
    const saved = dirty || !doc.id ? await save() : doc
    if (!saved) return
    const a = document.createElement('a')
    a.href = `${api}/${encodeURIComponent(saved.id)}/pdf`
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  /** Step one: make sure what is on screen is saved, then ask before sending. */
  async function askPaypal() {
    const saved = dirty || !doc.id ? await save() : doc
    if (!saved) return
    setDeposit(''); setPayLink(null); setAsk({ kind: 'paypal', inv: saved })
  }

  async function sendPaypal(saved: InvoiceDoc) {
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`${api}/${encodeURIComponent(saved.id)}/paypal`, postJson({ deposit: Number(deposit.replace(/[^0-9.]/g, '')) || 0 }))
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setMsg({ ok: false, text: j.error ?? 'PayPal did not take the invoice.' }); return }
      setAsk(null)
      setMsg({ ok: true, text: `Sent through PayPal as invoice ${j.paypalNumber}. The payer link is saved on the lead; payment will be recorded by itself.` })
      setPayLink({ number: String(j.paypalNumber ?? ''), url: typeof j.link === 'string' ? j.link : '' })
      onLinkChanged()
    } catch { setMsg({ ok: false, text: 'PayPal did not take the invoice.' }) } finally { setBusy(false) }
  }

  async function remove() {
    if (!doc.id || !data) return
    setBusy(true); setMsg(null)
    try {
      const r = await fetch(`${api}?inv=${encodeURIComponent(doc.id)}`, { method: 'DELETE' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        setMsg({ ok: false, text: j.error ?? 'Could not remove it.' })
        return
      }
      const invoices = data.invoices.filter((x) => x.id !== doc.id)
      setData({ ...data, invoices })
      onList(invoices)
      setDoc(data.prefill); setPoTouched(false); setDirty(false); setAsk(null); setPayLink(null)
      setMsg({ ok: true, text: 'Invoice removed.' })
    } catch { setMsg({ ok: false, text: 'Could not remove it.' }) } finally { setBusy(false) }
  }

  // Closing with unsaved typing asks once, in the drawer itself.
  function close() {
    if (dirty && ask?.kind !== 'discard') { setAsk({ kind: 'discard' }); return }
    onClose()
  }

  const sums = useMemo(() => totals(doc), [doc])
  const title = doc.id ? `Invoice #${doc.number}` : 'New invoice'

  if (!data) {
    return (
      <Drawer title="Invoice" onClose={onClose} width={1120}>
        {loadErr ? <Notice text={loadErr} bad /> : (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-9 rounded-md bg-[#e9ebed] animate-pulse" />)}
            <span className="sr-only" role="status">Loading the invoice</span>
          </div>
        )}
      </Drawer>
    )
  }

  const ship = shipParty(doc)
  const showBank = !!data.bank && isBankTransfer(doc.paymentTerms)
  const forPaypal: [string, string][] = [
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
    <Drawer title={title} onClose={close} width={1120}>
      {/* Actions stay in reach while the form scrolls, and wrap on a narrow screen. */}
      <div className="sticky top-0 z-10 -mx-5 -mt-4 mb-4 px-5 py-2.5 border-b border-[#d8dcde] bg-[#f8f9f9] flex flex-wrap items-center gap-2">
        {data.invoices.length > 0 && (
          <select aria-label="Invoice to work on" value={doc.id} onChange={(e) => pick(e.target.value)} className={`${SELECT} !w-auto max-w-[220px] !h-8`}>
            <option value="">New invoice</option>
            {data.invoices.map((d) => <option key={d.id} value={d.id}>#{d.number} · {dateLabel(d.date)}</option>)}
          </select>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {doc.id && (
            <button type="button" onClick={() => setAsk({ kind: 'remove' })} disabled={busy} className={BTN_DANGER}><Trash2 size={14} aria-hidden />Remove</button>
          )}
          <button type="button" onClick={() => void save()} disabled={busy} className={BTN_PLAIN}>
            <Save size={14} aria-hidden />{busy && !ask ? 'Working…' : dirty || !doc.id ? 'Save' : 'Saved'}
          </button>
          {data.paypal && (
            <button type="button" onClick={() => void askPaypal()} disabled={busy} className={BTN_PLAIN}><Send size={14} aria-hidden />Send via PayPal</button>
          )}
          <button type="button" onClick={() => void download()} disabled={busy} className={BTN_PRIMARY}><Download size={14} aria-hidden />Download PDF</button>
        </div>
      </div>

      <div className="space-y-3 mb-4 empty:hidden">
        {msg && <Notice text={msg.text} bad={!msg.ok} />}

        {ask?.kind === 'discard' && (
          <div className="rounded-lg border border-[#f1dfb4] bg-[#fff8e6] px-3 py-2.5 flex flex-wrap items-center gap-2">
            <p className="text-[#703815]">This invoice has changes that are not saved.</p>
            <div className="ml-auto flex gap-2">
              <button type="button" className={BTN_PLAIN} onClick={() => setAsk(null)}>Keep editing</button>
              <button type="button" className={BTN_DANGER} onClick={onClose}>Close without saving</button>
            </div>
          </div>
        )}

        {ask?.kind === 'remove' && (
          <div className="rounded-lg border border-[#cc3340] bg-[#fff0f1] px-3 py-2.5 flex flex-wrap items-center gap-2" role="alertdialog" aria-label="Remove this invoice">
            <p>Remove invoice #{doc.number}?</p>
            <div className="ml-auto flex gap-2">
              <button type="button" className={BTN_PLAIN} onClick={() => setAsk(null)} disabled={busy}>Keep it</button>
              <button type="button" className={BTN_DANGER} onClick={() => void remove()} disabled={busy}>{busy ? 'Removing…' : 'Remove invoice'}</button>
            </div>
          </div>
        )}

        {ask?.kind === 'paypal' && (() => {
          const inv = ask.inv
          const total = totals(inv).total
          return (
            <form className="rounded-lg border border-[#1f73b7] bg-[#edf7ff] px-3 py-3 space-y-2.5" aria-label="Send through PayPal"
              onSubmit={(e) => { e.preventDefault(); void sendPaypal(inv) }}>
              <p className="font-medium">
                Send invoice #{inv.number} ({money(total, inv.currency)}) to {data.lead.email || 'the customer'} through PayPal?
              </p>
              <p className="text-[12px] text-[#49545c]">PayPal will email it to the customer now.</p>
              <div className="max-w-[320px]">
                <label className={LABEL} htmlFor="zd-inv-deposit">Deposit (optional)</label>
                <input id="zd-inv-deposit" inputMode="decimal" className={INPUT} value={deposit} onChange={(e) => setDeposit(e.target.value)}
                  placeholder={`e.g. ${Math.round(total / 2)}`} />
                <p className="mt-1 text-[11px] text-[#68737d]">For a deposit, type the minimum they may pay first. Leave empty for full payment.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" className={BTN_PRIMARY} disabled={busy}><Send size={14} aria-hidden />{busy ? 'Sending…' : 'Send now'}</button>
                <button type="button" className={BTN_PLAIN} onClick={() => setAsk(null)} disabled={busy}>Cancel</button>
              </div>
            </form>
          )
        })()}

        {payLink && (
          <div className="rounded-lg border border-[#b7dfcf] bg-[#edf8f4] px-3 py-3 space-y-2">
            <p className="font-medium text-[#038153]">PayPal invoice {payLink.number} is with the customer.</p>
            {payLink.url && !contactsHidden ? (
              <>
                <label className={LABEL} htmlFor="zd-inv-paylink">Payment link</label>
                <div className="flex flex-wrap items-center gap-2">
                  <input id="zd-inv-paylink" readOnly value={payLink.url} onFocus={(e) => e.currentTarget.select()} className={`${INPUT} flex-1 min-w-[220px]`} />
                  <CopyBtn value={payLink.url} label="Copy link" />
                </div>
                <p className="text-[11px] text-[#49545c]">If Copy is blocked by the browser, select the link in the box instead.</p>
              </>
            ) : (
              <p className="text-[12px] text-[#49545c]">The payment link is saved on the lead. You can send it from the record without seeing it.</p>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-5 min-[1100px]:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]">
        {/* ── The form ── */}
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <section className={PANEL} aria-label="Invoice details">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL} htmlFor="zd-inv-number">Invoice #</label>
                <input id="zd-inv-number" className={INPUT} value={doc.number} placeholder={`${data.prefix}-001`} onChange={(e) => update({ number: e.target.value })} />
              </div>
              <div>
                <label className={LABEL} htmlFor="zd-inv-agent">Agent</label>
                <input id="zd-inv-agent" className={INPUT} value={doc.agentName} placeholder="Your name" onChange={(e) => update({ agentName: e.target.value })} />
              </div>
              <div>
                <label className={LABEL} htmlFor="zd-inv-date">Date</label>
                <input id="zd-inv-date" type="date" className={INPUT} value={doc.date}
                  onChange={(e) => update({ date: e.target.value, dueDate: doc.dueDate === doc.date ? e.target.value : doc.dueDate })} />
              </div>
              <div>
                <label className={LABEL} htmlFor="zd-inv-due">Due date</label>
                <input id="zd-inv-due" type="date" className={INPUT} value={doc.dueDate} onChange={(e) => update({ dueDate: e.target.value })} />
              </div>
              <div>
                <label className={LABEL} htmlFor="zd-inv-terms">Payment terms</label>
                <input id="zd-inv-terms" list="zd-inv-terms-list" className={INPUT} value={doc.paymentTerms} onChange={(e) => update({ paymentTerms: e.target.value })} />
                <datalist id="zd-inv-terms-list"><option value="Credit Card" /><option value="PayPal" /><option value="Bank Transfer" /></datalist>
              </div>
              <div>
                <label className={LABEL} htmlFor="zd-inv-po">PO number</label>
                <input id="zd-inv-po" className={INPUT} value={doc.poNumber} onChange={(e) => { setPoTouched(true); update({ poNumber: e.target.value }) }} />
              </div>
            </div>
            {showBank && (
              <div className="rounded-md border border-[#e9ebed] bg-[#f8f9f9] px-3 py-2">
                <div className="flex items-center gap-2">
                  <p className="text-[12px] font-semibold text-[#49545c]">Bank transfer details, printed on the invoice</p>
                  <span className="ml-auto"><CopyBtn value={data.bank ?? ''} bare label="Copy the bank details" /></span>
                </div>
                <p className="mt-1 whitespace-pre-line break-words text-[12px] text-[#49545c]">{data.bank}</p>
              </div>
            )}
          </section>

          {(['billTo', 'shipTo'] as const).map((key) => (
            <section key={key} className={PANEL} aria-label={key === 'billTo' ? 'Bill to' : 'Ship to'}>
              <div className="flex items-center">
                <h3 className="font-semibold">{key === 'billTo' ? 'Bill to' : 'Ship to'}</h3>
                {key === 'shipTo' && (
                  <label className="ml-auto inline-flex items-center gap-1.5 text-[12px] text-[#49545c] cursor-pointer">
                    <input type="checkbox" className="accent-[#1f73b7]" checked={doc.shipSame} onChange={(e) => update({ shipSame: e.target.checked })} /> Same as bill to
                  </label>
                )}
              </div>
              {(key === 'billTo' || !doc.shipSame) && (
                <div className="space-y-2">
                  <input aria-label="Name" className={INPUT} placeholder="Name" value={doc[key].name} onChange={(e) => party(key, { name: e.target.value })} />
                  <input aria-label="Company" className={INPUT} placeholder="Company (optional)" value={doc[key].company} onChange={(e) => party(key, { company: e.target.value })} />
                  <textarea aria-label="Address" className={TEXTAREA} rows={3} placeholder={'Street\nCity, State ZIP'} value={doc[key].address} onChange={(e) => party(key, { address: e.target.value })} />
                  <input aria-label="Phone" className={INPUT} placeholder="Phone" value={doc[key].phone} onChange={(e) => party(key, { phone: e.target.value })} />
                </div>
              )}
            </section>
          ))}

          <section className={PANEL} aria-label="Items">
            <h3 className="font-semibold">Items</h3>
            {doc.items.map((it, i) => (
              <div key={i} className="rounded-md border border-[#e9ebed] bg-[#f8f9f9] p-2.5 space-y-2">
                <div className="flex items-center gap-1.5">
                  <input aria-label={`Item ${i + 1}`} className={INPUT} placeholder="7oz Paper Cups with Lids" value={it.name} onChange={(e) => item(i, { name: e.target.value })} />
                  {doc.items.length > 1 && (
                    <button type="button" aria-label={`Remove item ${i + 1}`} title="Remove item" onClick={() => update({ items: doc.items.filter((_, n) => n !== i) })}
                      className={`${ICON_BTN} hover:!text-[#cc3340]`}><Trash2 size={14} aria-hidden /></button>
                  )}
                </div>
                <textarea aria-label={`Item ${i + 1} details`} className={TEXTAREA} rows={3} placeholder={'Double Wall\nCustom Color Printing'} value={it.details} onChange={(e) => item(i, { details: e.target.value })} />
                <div className="grid grid-cols-3 gap-2 items-end">
                  <div>
                    <label className={LABEL} htmlFor={`zd-inv-qty-${i}`}>Quantity</label>
                    <input id={`zd-inv-qty-${i}`} inputMode="numeric" className={INPUT} value={it.quantity} placeholder="2000" onChange={(e) => item(i, { quantity: e.target.value })} />
                  </div>
                  <div>
                    <label className={LABEL} htmlFor={`zd-inv-rate-${i}`}>Rate</label>
                    <input id={`zd-inv-rate-${i}`} inputMode="decimal" className={INPUT} value={it.rate} placeholder="0.52" onChange={(e) => item(i, { rate: e.target.value })} />
                  </div>
                  <p className="pb-2 text-right font-semibold tabular-nums">{money(lineCents(it) / 100, doc.currency)}</p>
                </div>
              </div>
            ))}
            <div className="flex flex-wrap items-end gap-3">
              <button type="button" onClick={() => update({ items: [...doc.items, { name: '', details: '', quantity: '', rate: '' }] })} className={BTN_PLAIN}>
                <Plus size={14} aria-hidden />Add item
              </button>
              <div className="ml-auto w-[76px]">
                <label className={LABEL} htmlFor="zd-inv-tax">Tax %</label>
                <input id="zd-inv-tax" inputMode="decimal" className={INPUT} value={doc.taxPercent} onChange={(e) => update({ taxPercent: e.target.value })} />
              </div>
              <div className="w-[88px]">
                <label className={LABEL} htmlFor="zd-inv-currency">Currency</label>
                <select id="zd-inv-currency" value={doc.currency} onChange={(e) => update({ currency: e.target.value })} className={SELECT}>
                  {!CURRENCIES.includes(doc.currency) && <option>{doc.currency}</option>}
                  {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <dl className="border-t border-[#e9ebed] pt-2 space-y-1 text-[12px]">
              <Sum label="Subtotal" value={money(sums.subtotal, doc.currency)} />
              <Sum label={`Tax (${Number(doc.taxPercent) || 0}%)`} value={money(sums.tax, doc.currency)} />
              <Sum label="Total" value={money(sums.total, doc.currency)} strong />
            </dl>
          </section>

          <section className={PANEL} aria-label="Notes and terms">
            <div>
              <label className={LABEL} htmlFor="zd-inv-notes">Notes</label>
              <textarea id="zd-inv-notes" className={TEXTAREA} rows={4} value={doc.notes} onChange={(e) => update({ notes: e.target.value })} />
            </div>
            <div>
              <label className={LABEL} htmlFor="zd-inv-tc">Terms</label>
              <textarea id="zd-inv-tc" className={TEXTAREA} rows={2} value={doc.terms} onChange={(e) => update({ terms: e.target.value })} />
            </div>
          </section>
        </form>

        {/* ── The invoice as the customer will see it, and the PayPal fields ── */}
        <div className="space-y-4 min-w-0">
          <div>
            <h3 className={SECTION}>Preview</h3>
            <article aria-label="Invoice preview" className="mt-2 rounded-lg border border-[#d8dcde] bg-white p-5 min-[1100px]:p-8 overflow-x-auto [scrollbar-width:thin]">
              <div className="min-w-[540px]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2.5">
                      {logoOk && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={data.logoUrl} alt="" className={wordmark ? 'max-h-12 max-w-[190px] object-contain' : 'max-h-11 max-w-[60px] object-contain'}
                          onLoad={(e) => setWordmark(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight >= 2.2)}
                          onError={() => setLogoOk(false)} />
                      )}
                      {!wordmark && <span className="text-[19px] font-semibold text-[#03363d]">{data.lead.siteName}</span>}
                    </div>
                    <p className="mt-5 font-semibold">{doc.agentName}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[30px] leading-none font-light tracking-tight text-[#03363d]">INVOICE</p>
                    <p className="mt-2 text-[#68737d]"># {doc.number || `${data.prefix}-001`}</p>
                  </div>
                </div>

                <div className="mt-8 grid grid-cols-[1fr_1fr_1.3fr] gap-5">
                  {([['Bill To:', doc.billTo], ['Ship To:', ship]] as [string, InvoiceParty][]).map(([heading, p]) => (
                    <div key={heading} className="min-w-0 break-words">
                      <p className="text-[#68737d]">{heading}</p>
                      <p className="font-semibold">{p.name}</p>
                      {p.company && <p>{p.company}</p>}
                      {p.address && <p className="whitespace-pre-line">{p.address}</p>}
                      {p.phone && <p>{p.phone}</p>}
                    </div>
                  ))}
                  <div className="space-y-1.5">
                    {[['Date:', dateLabel(doc.date)], ['Payment Terms:', doc.paymentTerms], ['Due Date:', dateLabel(doc.dueDate || doc.date)], ...(doc.poNumber ? [['PO Number:', doc.poNumber]] : [])].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3"><span className="text-[#68737d]">{k}</span><span className="text-right">{v}</span></div>
                    ))}
                    <div className="flex justify-between gap-3 rounded-md bg-[#e9ebed] px-3 py-2 font-semibold">
                      <span>Balance Due:</span><span className="tabular-nums">{money(sums.total, doc.currency)}</span>
                    </div>
                  </div>
                </div>

                <table className="mt-7 w-full border-collapse">
                  <thead>
                    <tr className="bg-[#03363d] text-white text-left">
                      <th className="rounded-l-md px-3 py-1.5 font-normal">Item</th>
                      <th className="px-3 py-1.5 font-normal w-24">Quantity</th>
                      <th className="px-3 py-1.5 font-normal w-24 text-right">Rate</th>
                      <th className="rounded-r-md px-3 py-1.5 font-normal w-28 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.items.map((it, i) => (
                      <tr key={i} className="align-top border-b border-[#e9ebed]">
                        <td className="px-3 py-2.5"><p className="font-semibold">{it.name}</p>{it.details && <p className="whitespace-pre-line text-[#68737d]">{it.details}</p>}</td>
                        <td className="px-3 py-2.5">{it.quantity}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{it.rate ? rateLabel(it.rate, doc.currency) : ''}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(lineCents(it) / 100, doc.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <dl className="ml-auto mt-5 w-64 space-y-1.5">
                  <Sum label="Subtotal:" value={money(sums.subtotal, doc.currency)} />
                  <Sum label={`Tax (${Number(doc.taxPercent) || 0}%):`} value={money(sums.tax, doc.currency)} />
                  <Sum label="Total:" value={money(sums.total, doc.currency)} strong />
                </dl>

                {doc.notes && <div className="mt-7"><p className="text-[#68737d]">Notes:</p><p className="whitespace-pre-line">{doc.notes}</p></div>}
                {showBank && <div className="mt-4"><p className="text-[#68737d]">Pay by bank transfer:</p><p className="whitespace-pre-line">{data.bank}</p></div>}
                {doc.terms && <div className="mt-4"><p className="text-[#68737d]">Terms:</p><p className="whitespace-pre-line">{doc.terms}</p></div>}
              </div>
            </article>
          </div>

          <section aria-label="Copy into PayPal">
            <h3 className={SECTION}>Copy into PayPal</h3>
            <p className="mt-1 text-[12px] text-[#68737d]">Each field in the order PayPal&apos;s invoice form asks for it.</p>
            <dl className={`${CARD} mt-2 divide-y divide-[#e9ebed]`}>
              {forPaypal.filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="flex items-start gap-3 px-3 py-1.5">
                  <dt className="w-[130px] shrink-0 pt-1 text-[12px] font-medium text-[#68737d]">{k}</dt>
                  <dd className="min-w-0 flex-1 pt-1 whitespace-pre-line break-words">{v}</dd>
                  <CopyBtn value={v} bare label={`Copy ${k.toLowerCase()}`} />
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </Drawer>
  )
}

function Sum({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'font-semibold text-[#2f3941]' : ''}`}>
      <dt className={strong ? '' : 'text-[#68737d]'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
