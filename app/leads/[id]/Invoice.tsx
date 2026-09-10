'use client'

// The invoice worksheet on a lead record.
//
// A sale gets agreed across a WhatsApp thread, two emails and a note, and then
// somebody has to turn that into a name, an address, a quantity and an amount
// to type into a payment page. This is where that assembly happens once.
//
// It reads the conversation and fills the blanks: quantities, amounts, street
// addresses and what was being discussed, newest first. A value that came from
// the thread is labelled with where it was said and the panel opens unsaved,
// because "8 sets" in a message might be what was ordered or what was first
// asked about — the fill is a draft for a person to confirm, not an answer.
// Anything already typed always wins; alternatives stay as buttons underneath.

import { useCallback, useEffect, useState } from 'react'
import { Receipt, Copy, Check, RefreshCw, Sparkles, Link2, Send, MessageCircle } from 'lucide-react'
import { Card, EmptyState } from './ui'

interface Draft {
  item: string
  quantity: string
  amount: string
  currency: string
  billTo: string
  shipTo: string
  notes: string
}
interface Sheet extends Draft {
  name: string; email: string; phone: string; gaps: string[]
  autofilled: string[]; sources: Record<string, string>
}
interface Suggestion { value: string; from: string; at: string }
/** What the server is willing to tell THIS member about the payment link. */
interface LinkState {
  present: boolean
  canEdit: boolean
  canSend: boolean
  /** 'email' when the lead has an address, 'whatsapp' when it only has a
   *  number, null when neither. Decided on the server — both values are
   *  hidden from a masked member, so the browser cannot work it out. */
  channels: ('email' | 'whatsapp')[]
  channel: 'email' | 'whatsapp' | null
  waWindowOpen: boolean | null
  /** Populated only for a member who may see contacts. Never for an agent. */
  url: string | null
  savedBy: string
  savedAt: string
  lastSent: { by: string; at: string; channel: 'email' | 'whatsapp' } | null
}
/** Example text for the empty fields, chosen by the workspace — see lib/invoice.ts. */
interface Hints { item: string; quantity: string; amount: string; billTo: string }
interface Payload {
  sheet: Sheet
  text: string
  draft: Draft | null
  suggestions: { item: Suggestion[]; quantity: Suggestion[]; amount: Suggestion[]; address: Suggestion[] }
  hints?: Hints
  contactsHidden: boolean
}

const BLANK: Draft = { item: '', quantity: '', amount: '', currency: 'USD', billTo: '', shipTo: '', notes: '' }
const INPUT =
  'mt-1 w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 ' +
  'outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10'
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500'

export default function Invoice({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [v, setV] = useState<Draft>(BLANK)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/invoice`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(String(j.error || 'Could not load the invoice sheet.')); return }
      setError('')
      setData(j)
      // Open with what the sheet resolved, not with the bare draft: an empty
      // field that the conversation could fill is shown filled, so saving is a
      // confirmation rather than a retype. `autofilled` says which ones those
      // are, and the panel labels them.
      const d = j.draft ?? {}
      setV({
        ...BLANK, ...d,
        item: d.item || j.sheet.item || '',
        quantity: d.quantity || j.sheet.quantity || '',
        amount: d.amount || j.sheet.amount || '',
        shipTo: d.shipTo || j.sheet.shipTo || '',
        currency: d.currency || j.sheet.currency || 'USD',
      })
      setDirty((j.sheet.autofilled?.length ?? 0) > 0)
    } catch {
      setError('Could not load the invoice sheet.')
    } finally {
      setBusy(false)
    }
  }, [leadId])

  useEffect(() => { void load() }, [load])

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setV((p) => ({ ...p, [k]: e.target.value })); setDirty(true)
  }
  const take = (k: keyof Draft, value: string) => { setV((p) => ({ ...p, [k]: value })); setDirty(true) }

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/invoice`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(String(j.error || 'That did not save.')); return }
      setError(''); setData((p) => (p ? { ...p, ...j } : j)); setDirty(false)
    } catch {
      setError('That did not save.')
    } finally {
      setBusy(false)
    }
  }

  async function copy() {
    if (!data?.text) return
    try {
      await navigator.clipboard.writeText(data.text)
      setCopied(true); window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copy was blocked — select the block below instead.')
    }
  }

  const gaps = data?.sheet.gaps ?? []
  const sug = data?.suggestions
  // Empty until the server says which workspace this is. A hard-coded default
  // here is how the sports examples reached a packaging lead in the first place.
  const hint = data?.hints

  return (
    <Card
      title="Invoice details"
      icon={Receipt}
      action={
        <button type="button" onClick={() => void load()}
          className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label="Reload from the record">
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      }>
      <div className="px-3 py-2.5 space-y-3">
        {error && <p className="text-xs font-medium text-red-700">{error}</p>}

        {!data && !busy && <EmptyState icon={Receipt} title="Nothing loaded" hint="Reload to try again." />}

        {data && (
          <>
            <div className={`rounded-lg px-2.5 py-2 text-[11px] font-semibold ${
              gaps.length === 0 ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
            }`}>
              {gaps.length === 0 ? 'Everything an invoice needs is here.' : `Still missing: ${gaps.join(', ')}`}
            </div>

            {/* From the record, not editable here — the record is where a
                contact detail gets corrected, and two places to edit one value
                is how they end up disagreeing. */}
            <dl className="space-y-1 text-xs">
              <Row label="Name" value={data.sheet.name} />
              <Row label="Email" value={data.sheet.email} />
              <Row label="Phone" value={data.sheet.phone} />
            </dl>
            {data.contactsHidden && (
              <p className="text-[11px] text-gray-500">
                Contact details are hidden for your account, so they are masked here too.
              </p>
            )}

            <div className="space-y-2.5 border-t border-gray-100 pt-2.5">
              <div>
                <label className={LABEL} htmlFor="inv-item">What was sold</label>
                <input id="inv-item" className={INPUT} value={v.item} onChange={set('item')}
                  placeholder={hint?.item ?? ''} />
                <From sheet={data.sheet} field="item" />
                <Suggest list={sug?.item} onPick={(x) => take('item', x)} />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={LABEL} htmlFor="inv-qty">Quantity</label>
                  <input id="inv-qty" className={INPUT} value={v.quantity} onChange={set('quantity')} placeholder={hint?.quantity ?? ''} />
                  <From sheet={data.sheet} field="quantity" />
                  <Suggest list={sug?.quantity} onPick={(x) => take('quantity', x)} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="inv-amt">Amount</label>
                  <div className="mt-1 flex gap-1.5">
                    <input className={`${INPUT} mt-0 w-16`} value={v.currency} onChange={set('currency')} aria-label="Currency" />
                    <input id="inv-amt" className={`${INPUT} mt-0 flex-1`} value={v.amount} onChange={set('amount')} placeholder={hint?.amount ?? ''} />
                  </div>
                  <From sheet={data.sheet} field="amount" />
                  <Suggest list={sug?.amount} onPick={(x) => take('amount', x.replace(/^\$/, ''))} />
                </div>
              </div>

              <div>
                <label className={LABEL} htmlFor="inv-billto">Bill to</label>
                <input id="inv-billto" className={INPUT} value={v.billTo} onChange={set('billTo')}
                  placeholder={hint?.billTo ?? ''} />
              </div>

              <div>
                <label className={LABEL} htmlFor="inv-ship">Shipping address</label>
                <textarea id="inv-ship" rows={2} className={INPUT} value={v.shipTo} onChange={set('shipTo')} />
                <From sheet={data.sheet} field="shipTo" />
                <Suggest list={sug?.address} onPick={(x) => take('shipTo', x)} />
              </div>

              <div>
                <label className={LABEL} htmlFor="inv-notes">Notes for the invoice</label>
                <textarea id="inv-notes" rows={2} className={INPUT} value={v.notes} onChange={set('notes')}
                  placeholder="PO number, department, anything finance needs" />
              </div>

              <button type="button" onClick={() => void save()} disabled={!dirty || busy}
                className="w-full rounded-lg bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            </div>

            <PaymentLink leadId={leadId} />

            <div className="border-t border-gray-100 pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className={LABEL}>Copy for the invoice</span>
                <button type="button" onClick={copy}
                  className="inline-flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                  {copied ? <Check className="w-3 h-3" aria-hidden /> : <Copy className="w-3 h-3" aria-hidden />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 border border-gray-200 p-2.5 text-[11px] leading-relaxed text-gray-700">
                {data.text || 'Nothing to copy yet.'}
              </pre>
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

/** Says a value came out of the conversation rather than from a person. */
function From({ sheet, field }: { sheet: Sheet; field: string }) {
  if (!sheet.autofilled?.includes(field)) return null
  return (
    <p className="mt-1 text-[10px] text-amber-700">
      Read from the {sheet.sources?.[field] ?? 'thread'} — check it before saving.
    </p>
  )
}

/** Candidates lifted out of the thread. A button, never a value. */
function Suggest({ list, onPick }: { list?: Suggestion[]; onPick: (v: string) => void }) {
  if (!list?.length) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <Sparkles className="w-3 h-3 text-gray-400" aria-hidden />
      {list.slice(0, 4).map((s) => (
        <button key={`${s.value}-${s.at}`} type="button" onClick={() => onPick(s.value)}
          title={`Said in ${s.from}`}
          className="rounded-full border border-gray-300 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 hover:border-gray-900 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
          {s.value}
        </button>
      ))}
    </div>
  )
}

/**
 * The payment link, for somebody who may not be allowed to read it.
 *
 * An admin gets a field and saves the URL. Everybody else gets six dots and a
 * Send button — the URL is not in the field, not in an href, and not in the
 * response that fed this component, because opening a PayPal invoice link
 * shows the customer's email address on PayPal's own page and that is exactly
 * what the workspace hides. The send happens on the server, which resolves
 * both the link and the recipient from our own rows.
 */
function PaymentLink({ leadId }: { leadId: string }) {
  const [state, setState] = useState<LinkState | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  // WHICH button is working, not just that one is. A single `busy` put
  // "Sending…" on both at once, so a send by email looked like a send by
  // WhatsApp as well.
  const [sending, setSending] = useState<'email' | 'whatsapp' | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)

  // Fetched inside the effect rather than through a shared callback: the effect
  // must not reach any function that sets state before its first await, or it
  // schedules a render inside a render.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/payment-link`, { cache: 'no-store' })
        const j = await res.json().catch(() => ({}))
        if (!alive || !res.ok) return
        setState(j)
        if (j.url) setUrl(j.url)
      } catch { /* the panel is still usable without it */ }
    })()
    return () => { alive = false }
  }, [leadId, tick])

  async function save() {
    setBusy(true); setErr(''); setMsg('')
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/payment-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(String(j.error || 'That did not save.')); return }
      setState(j); setMsg(url ? 'Saved.' : 'Cleared.')
    } catch { setErr('That did not save.') } finally { setBusy(false) }
  }

  async function send(channel: 'email' | 'whatsapp') {
    setBusy(true); setSending(channel); setErr(''); setMsg('')
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/payment-link/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setErr(String(j.error || 'That did not send.')); return }
      setMsg(j.channel === 'whatsapp' ? 'Sent on WhatsApp.' : 'Emailed to the customer.')
      setTick((t) => t + 1)
    } catch { setErr('That did not send.') } finally { setBusy(false); setSending(null) }
  }

  if (!state) return null
  const canEdit = state.canEdit   // decided by the server, and refused there too

  return (
    <div className="border-t border-gray-100 pt-2.5 space-y-2">
      <span className={LABEL}>
        <Link2 className="inline w-3 h-3 mr-1 -mt-px text-gray-400" aria-hidden />Payment link
      </span>

      {canEdit ? (
        <>
          <input className={INPUT} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url"
            placeholder="https://www.paypal.com/invoice/p/#…" aria-label="Payment link" />
          <button type="button" onClick={() => void save()} disabled={busy}
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
            {busy ? 'Saving…' : 'Save link'}
          </button>
        </>
      ) : state.present ? (
        <p className="rounded-lg bg-gray-50 border border-gray-200 px-2.5 py-2 text-[11px] text-gray-600">
          <span className="font-mono tracking-widest text-gray-800">••••••</span>
          <span className="ml-2">saved{state.savedBy ? ` by ${state.savedBy}` : ''}. You can send it without seeing it.</span>
        </p>
      ) : (
        /* Said plainly. This block used to render "•••••• saved" whether or not
           anything had been, so a lead with no link at all claimed to have one
           and then offered no way to send it. */
        <p className="rounded-lg bg-gray-50 border border-gray-200 px-2.5 py-2 text-[11px] text-gray-500">
          No payment link on this lead yet — an admin adds it here, then you can send it.
        </p>
      )}

      {state.present && (
        <>
          {/* One button per channel this customer actually has. The label names
              it, because the agent cannot work it out — the address and the
              number are both masked for them — and when there are two, which
              one to use is a judgement about this customer, not something to
              decide for them silently. */}
          {state.channels.map((ch) => (
            <button key={ch} type="button" onClick={() => void send(ch)} disabled={busy || !state.canSend}
              className={`w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                ch === 'whatsapp' ? 'bg-green-700 hover:bg-green-800' : 'bg-gray-900 hover:bg-gray-800'
              }`}>
              {ch === 'whatsapp' ? <MessageCircle className="w-3 h-3" aria-hidden /> : <Send className="w-3 h-3" aria-hidden />}
              {sending === ch ? 'Sending…' : ch === 'whatsapp' ? 'Send on WhatsApp' : 'Email to customer'}
            </button>
          ))}
          {state.channels.includes('whatsapp') && (
            state.waWindowOpen === false ? (
              /* Twilio ACCEPTS a message outside the window and marks it
                 undelivered minutes later, so "Sent" would be a lie the agent
                 only finds out about by checking the thread. */
              <p className="text-[10px] text-amber-700">
                WhatsApp only allows a free message within 24 hours of the customer&apos;s last one,
                and this conversation is outside that window — a WhatsApp send will not be delivered
                until they message first.
              </p>
            ) : state.channels.length === 1 ? (
              <p className="text-[10px] text-gray-500">
                This lead has no email address, so it goes to their WhatsApp instead.
              </p>
            ) : null
          )}
          {!state.canSend && (
            <p className="text-[10px] text-amber-700">
              This lead has no email address and no phone number, so the link cannot be sent. Add one on the record first.
            </p>
          )}
        </>
      )}

      {state.lastSent && (
        <p className="text-[10px] text-gray-500">
          Last sent by {state.lastSent.by}{state.lastSent.channel === 'whatsapp' ? ' on WhatsApp' : ' by email'}.
        </p>
      )}
      {msg && <p className="text-[11px] font-medium text-green-700">{msg}</p>}
      {err && <p className="text-[11px] font-medium text-red-700">{err}</p>}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-gray-500">{label}</dt>
      <dd className={`min-w-0 break-words ${value ? 'text-gray-800' : 'text-gray-300'}`}>{value || '—'}</dd>
    </div>
  )
}
