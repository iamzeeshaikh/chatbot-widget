'use client'

// The customer's billing form — /billing/<token>.
//
// An agent sends this link instead of typing a checklist into WhatsApp and
// then re-typing the answers into an invoice. Everything the form asks for is
// something accounts payable will refuse an invoice without.
//
// Two rules are visible in the page, not just in the code:
//  - The PO number is asked for with the reason attached, because a US school
//    or university rejects an invoice that has no PO on it and nobody finds out
//    until the payment is three weeks late.
//  - No card number, and the form says so. A card number typed into a form is
//    a card number sitting in a database and an inbox with no defence against
//    a chargeback. Payment goes through a link from the processor.
//
// Unauthenticated by necessity: the customer has no login. The signed token in
// the URL is the credential, and the API verifies it on every request.

import { use, useEffect, useState } from 'react'

interface Details {
  billTo: string
  contactName: string
  contactEmail: string
  contactPhone: string
  billingAddress: string
  shipAddress: string
  poNumber: string
  taxExempt: string
  taxExemptId: string
  paymentMethod: string
  notes: string
}

const BLANK: Details = {
  billTo: '', contactName: '', contactEmail: '', contactPhone: '',
  billingAddress: '', shipAddress: '', poNumber: '', taxExempt: '',
  taxExemptId: '', paymentMethod: '', notes: '',
}

const LABEL = 'block text-sm font-medium text-gray-700'
const INPUT =
  'mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-[16px] ' +
  'text-gray-900 outline-none transition focus:border-gray-900 focus:ring-2 focus:ring-gray-900/10'

export default function BillingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [state, setState] = useState<'loading' | 'bad' | 'form' | 'done'>('loading')
  const [customerName, setCustomerName] = useState('')
  const [v, setV] = useState<Details>(BLANK)
  const [sameAddress, setSameAddress] = useState(true)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/billing/${encodeURIComponent(token)}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!live) return
        if (!ok) { setState('bad'); return }
        setCustomerName(String(j.customerName || ''))
        // A link that has already been used stays usable — a purchasing clerk
        // correcting a PO number should not need a new one — but it opens
        // showing what was sent rather than an empty form.
        if (j.details) setV({ ...BLANK, ...j.details })
        if (j.details?.shipAddress) setSameAddress(false)
        setState('form')
      })
      .catch(() => live && setState('bad'))
    return () => { live = false }
  }, [token])

  const set = (k: keyof Details) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!v.billTo.trim() || !v.contactEmail.trim()) {
      setError('The bill-to name and a billing email are both needed.')
      return
    }
    setSending(true)
    try {
      const res = await fetch(`/api/billing/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...v, shipAddress: sameAddress ? '' : v.shipAddress }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(String(j.error || 'That did not save. Please try again.')); return }
      setState('done')
    } catch {
      setError('That did not send. Please check your connection and try again.')
    } finally {
      setSending(false)
    }
  }

  if (state === 'loading') {
    return <Shell><p className="text-gray-500">Loading…</p></Shell>
  }

  if (state === 'bad') {
    return (
      <Shell>
        <h1 className="text-xl font-semibold text-gray-900">This link is not valid</h1>
        <p className="mt-2 text-gray-600">
          It may have been mistyped or replaced. Ask the person who sent it for a fresh link.
        </p>
      </Shell>
    )
  }

  if (state === 'done') {
    return (
      <Shell>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-emerald-700" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.8 12.6l4.4 4.4L19.2 7" /></svg>
        </div>
        <h1 className="mt-4 text-xl font-semibold text-gray-900">Thank you — we have what we need</h1>
        <p className="mt-2 text-gray-600">
          Your invoice will be raised against these details. If anything changes, open this link again
          and send it through — it stays live.
        </p>
      </Shell>
    )
  }

  return (
    <Shell wide>
      <h1 className="text-2xl font-semibold text-gray-900">Billing details</h1>
      <p className="mt-2 max-w-2xl text-gray-600">
        {customerName ? `${customerName.split(' ')[0]}, ` : ''}we need these to raise your invoice
        correctly the first time. It takes about two minutes.
      </p>

      {/* Said before the first field rather than in small print at the bottom. */}
      <p className="mt-4 flex max-w-2xl items-start gap-2 rounded-lg bg-gray-100 px-3.5 py-3 text-sm text-gray-600">
        <svg viewBox="0 0 24 24" className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /></svg>
        <span>
          This form never asks for card details, and you should not send them by email or WhatsApp
          either. When it is time to pay, we send a payment link.
        </span>
      </p>

      <form onSubmit={submit} className="mt-8 max-w-2xl space-y-6" noValidate>
        <section className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Who is paying</h2>

          <div>
            <label htmlFor="billTo" className={LABEL}>
              Bill to <span className="text-red-600">*</span>
            </label>
            <input id="billTo" className={INPUT} value={v.billTo} onChange={set('billTo')}
              autoComplete="organization" required />
            <p className="mt-1 text-xs text-gray-500">
              The organisation that pays — the school district, university or booster club. Often not
              the person who asked for the quote.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="contactName" className={LABEL}>Billing contact</label>
              <input id="contactName" className={INPUT} value={v.contactName} onChange={set('contactName')} autoComplete="name" />
            </div>
            <div>
              <label htmlFor="contactEmail" className={LABEL}>
                Billing email <span className="text-red-600">*</span>
              </label>
              <input id="contactEmail" type="email" className={INPUT} value={v.contactEmail}
                onChange={set('contactEmail')} autoComplete="email" required />
            </div>
          </div>

          <div>
            <label htmlFor="contactPhone" className={LABEL}>Billing phone</label>
            <input id="contactPhone" type="tel" className={INPUT} value={v.contactPhone}
              onChange={set('contactPhone')} autoComplete="tel" />
          </div>
        </section>

        <section className="space-y-4 border-t border-gray-200 pt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Where it goes</h2>

          <div>
            <label htmlFor="billingAddress" className={LABEL}>Billing address</label>
            <textarea id="billingAddress" rows={3} className={INPUT} value={v.billingAddress}
              onChange={set('billingAddress')} autoComplete="street-address" />
          </div>

          <label className="flex items-center gap-2.5 text-sm text-gray-700">
            <input type="checkbox" className="h-4 w-4 rounded border-gray-300"
              checked={sameAddress} onChange={(e) => setSameAddress(e.target.checked)} />
            Ship to the same address
          </label>

          {!sameAddress && (
            <div>
              <label htmlFor="shipAddress" className={LABEL}>Delivery address</label>
              <textarea id="shipAddress" rows={3} className={INPUT} value={v.shipAddress}
                onChange={set('shipAddress')} />
              <p className="mt-1 text-xs text-gray-500">
                Where the kit itself should arrive, if that is not the billing address.
              </p>
            </div>
          )}
        </section>

        <section className="space-y-4 border-t border-gray-200 pt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Paperwork</h2>

          <div>
            <label htmlFor="poNumber" className={LABEL}>Purchase order number</label>
            <input id="poNumber" className={INPUT} value={v.poNumber} onChange={set('poNumber')} />
            <p className="mt-1 text-xs text-gray-500">
              If your organisation issues POs, we need the number on the invoice. Without it, accounts
              payable will usually reject the invoice and the payment stalls. Leave blank if you do not
              use them.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="taxExempt" className={LABEL}>Sales tax exempt?</label>
              <select id="taxExempt" className={INPUT} value={v.taxExempt} onChange={set('taxExempt')}>
                <option value="">Not sure</option>
                <option value="yes">Yes — we are exempt</option>
                <option value="no">No</option>
              </select>
            </div>
            {v.taxExempt === 'yes' && (
              <div>
                <label htmlFor="taxExemptId" className={LABEL}>Exemption certificate number</label>
                <input id="taxExemptId" className={INPUT} value={v.taxExemptId} onChange={set('taxExemptId')} />
              </div>
            )}
          </div>
          {v.taxExempt === 'yes' && (
            <p className="text-xs text-gray-500">
              Please email the certificate itself to your contact as well — we have to keep a copy on file.
            </p>
          )}

          <div>
            <label htmlFor="paymentMethod" className={LABEL}>How you expect to pay</label>
            <select id="paymentMethod" className={INPUT} value={v.paymentMethod} onChange={set('paymentMethod')}>
              <option value="">Not sure yet</option>
              <option value="ACH / bank transfer">ACH / bank transfer</option>
              <option value="Check">Check</option>
              <option value="Card (payment link)">Card — we will send a payment link</option>
              <option value="Other">Something else</option>
            </select>
          </div>

          <div>
            <label htmlFor="notes" className={LABEL}>Anything else we should put on the invoice</label>
            <textarea id="notes" rows={3} className={INPUT} value={v.notes} onChange={set('notes')} />
            <p className="mt-1 text-xs text-gray-500">
              Department name, cost centre, a reference your finance team needs, an AP email that is
              different from the one above.
            </p>
          </div>
        </section>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3.5 py-3 text-sm font-medium text-red-700">
            {error}
          </p>
        )}

        <div className="border-t border-gray-200 pt-6">
          <button type="submit" disabled={sending}
            className="min-h-[44px] w-full rounded-lg bg-gray-900 px-6 py-3 font-semibold text-white transition hover:bg-gray-800 disabled:opacity-60 sm:w-auto">
            {sending ? 'Sending…' : 'Send billing details'}
          </button>
          <p className="mt-3 text-xs text-gray-500">
            You can reopen this link later to correct anything.
          </p>
        </div>
      </form>
    </Shell>
  )
}

function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10 sm:px-6 sm:py-16">
      <div className={`mx-auto rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-10 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        {children}
      </div>
    </main>
  )
}
