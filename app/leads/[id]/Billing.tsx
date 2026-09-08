'use client'

// Billing details, on the lead record.
//
// The agent's job here is one click: copy a link, send it, and later read back
// what the customer filled in. They do not type any of it, which is the whole
// point — a PO number transcribed out of a WhatsApp thread is a PO number with
// a digit wrong in it, and accounts payable rejects the invoice.
//
// The panel leads with what is MISSING rather than with what was supplied,
// because "we have their address" is not the question anybody has. The question
// is "can I raise the invoice yet", and the gaps answer it.

import { useCallback, useEffect, useState } from 'react'
import { Receipt, Copy, Check, RefreshCw } from 'lucide-react'
import { Card, EmptyState } from './ui'

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
  submittedAt: string
}

interface Payload {
  url: string
  details: Details | null
  gaps: string[]
}

export default function Billing({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/billing`, { cache: 'no-store' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(String(j.error || 'Could not load billing details.')); return }
      setError('')
      setData({ url: String(j.url || ''), details: j.details ?? null, gaps: Array.isArray(j.gaps) ? j.gaps : [] })
    } catch {
      setError('Could not load billing details.')
    } finally {
      setLoading(false)
    }
  }, [leadId])

  useEffect(() => { void load() }, [load])

  async function copy() {
    if (!data?.url) return
    try {
      await navigator.clipboard.writeText(data.url)
    } catch {
      // Clipboard is blocked outside a secure context and in some embedded
      // browsers. Falling through to the visible input is better than a
      // silent no-op — the agent can still select it by hand.
      setError('Copy was blocked — select the link below instead.')
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const d = data?.details ?? null
  const ready = Boolean(d) && (data?.gaps.length ?? 1) === 0

  return (
    <Card
      title="Billing details"
      icon={Receipt}
      action={
        <button type="button" onClick={() => void load()}
          className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label="Refresh billing details">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      }>
      <div className="px-3 py-2.5 space-y-3">
        {error && <p className="text-xs font-medium text-red-700">{error}</p>}

        {/* The link, always available — a customer correcting a PO number
            reopens the same one rather than needing a new one. */}
        <div>
          <div className="flex items-center gap-1.5">
            <input readOnly value={data?.url ?? ''} onFocus={(e) => e.currentTarget.select()}
              aria-label="Billing form link"
              className="flex-1 min-w-0 text-[11px] font-mono bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" />
            <button type="button" onClick={copy} disabled={!data?.url}
              className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-gray-900 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-gray-800 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              {copied ? <Check className="w-3 h-3" aria-hidden /> : <Copy className="w-3 h-3" aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-gray-500">
            Send this to the customer. It asks for no card details, and it stays live if they need to
            correct something.
          </p>
        </div>

        {!d && !loading && (
          <EmptyState icon={Receipt} title="Nothing submitted yet"
            hint="Send the link above and the details land here." />
        )}

        {d && (
          <>
            <div
              className={`rounded-lg px-2.5 py-2 text-[11px] font-semibold ${
                ready ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'
              }`}>
              {ready
                ? 'Everything an invoice needs is here.'
                : `Still missing: ${data?.gaps.join(', ')}`}
            </div>

            <dl className="space-y-1.5 text-xs">
              <Row label="Bill to" value={d.billTo} />
              <Row label="Contact" value={[d.contactName, d.contactEmail, d.contactPhone].filter(Boolean).join(' · ')} />
              <Row label="Billing address" value={d.billingAddress} />
              <Row label="Ship to" value={d.shipAddress || (d.billingAddress ? 'Same as billing' : '')} />
              <Row label="PO number" value={d.poNumber} strong />
              <Row
                label="Sales tax"
                value={
                  d.taxExempt === 'yes' ? `Exempt${d.taxExemptId ? ` · ${d.taxExemptId}` : ''}`
                    : d.taxExempt === 'no' ? 'Not exempt' : ''
                }
              />
              <Row label="Pays by" value={d.paymentMethod} />
              <Row label="Notes" value={d.notes} />
            </dl>

            {d.submittedAt && (
              <p className="text-[11px] text-gray-400">
                Submitted {new Date(d.submittedAt).toLocaleString()}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  if (!value) {
    return (
      <div className="flex gap-2">
        <dt className="w-28 shrink-0 text-gray-400">{label}</dt>
        <dd className="text-gray-300">—</dd>
      </div>
    )
  }
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-gray-500">{label}</dt>
      <dd className={`min-w-0 break-words ${strong ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>
        {value}
      </dd>
    </div>
  )
}
