import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { isOwnLeadsOnly, ownLeadsRefusal } from '@/lib/ownleads'
import { readSales, writeSale, suggestedRates } from '@/lib/sales'
import { figures, type Sale } from '@/lib/salescore'
import { canUseCosting, costingBucket, costingItem, cleanShipping } from '@/lib/costing'
import { addTracking, carrierFor, paypalConfigured } from '@/lib/paypalapi'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Shipping status + tracking, from the Costing page (owner, 2026-11-05: the
// production side updates tracking IN ZeeOps; the owner looks nowhere else).
//   POST {saleId, production, tracking}
// Writes the sale and puts the tracking on every PayPal transaction the sale
// was paid on — that is what lifts PayPal's new-account hold after delivery.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Own-leads-only (lib/ownleads.ts): this screen is about everybody's leads.
  if (isOwnLeadsOnly(member)) return ownLeadsRefusal()
  if (!canUseCosting(member)) return NextResponse.json({ error: 'Costing is not open to this account.' }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const saleId = String(body?.saleId ?? '').trim()
  const sale = (await readSales('packaging')).find((s) => s.id === saleId)
  if (!sale || sale.stream !== 'pk_direct') return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  if (sale.statusOverride) return NextResponse.json({ error: 'This order is refunded or cancelled.' }, { status: 409 })
  const { production, tracking } = cleanShipping(body)
  if (!production) return NextResponse.json({ error: 'Choose In production, Shipped or Delivered.' }, { status: 400 })
  if (production !== 'in_production' && !tracking && !sale.tracking) {
    return NextResponse.json({ error: 'Add the courier’s tracking number for a shipped order.' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const day = now.slice(0, 10)
  const nextTracking = tracking || sale.tracking || ''
  const lines: string[] = []
  if (production !== sale.production) lines.push(`${day}: ${member.email.split('@')[0]} set production to ${production}${sale.production ? ` (was ${sale.production})` : ''}.`)
  let paypalNote = ''
  if (nextTracking && nextTracking !== (sale.tracking ?? '')) {
    const carrier = carrierFor(nextTracking)
    const done: string[] = [], failed: string[] = []
    if (paypalConfigured()) {
      for (const p of sale.payments) {
        if (p.method !== 'paypal' || !p.id.startsWith('pay_pp_')) continue
        const txn = p.id.slice('pay_pp_'.length)
        const err = await addTracking(txn, nextTracking, production === 'delivered' ? 'DELIVERED' : 'SHIPPED').catch((e: unknown) => (e instanceof Error ? e.message : 'failed'))
        if (err) failed.push(`${txn} (${err.slice(0, 80)})`); else done.push(txn)
      }
    }
    lines.push(`${day}: SHIPPED — ${carrier} tracking ${nextTracking} (entered by ${member.email.split('@')[0]} on Costing)${done.length ? `; PayPal tracking added on ${done.join(', ')}` : ''}${failed.length ? `; PayPal refused on ${failed.join(', ')}` : ''}.`)
    paypalNote = done.length ? `Tracking added to ${done.length} PayPal payment${done.length === 1 ? '' : 's'}.` : failed.length ? `PayPal did not take the tracking: ${failed[0]}` : ''
  }
  const updated: Sale = {
    ...sale,
    production,
    tracking: nextTracking,
    shippedAt: sale.shippedAt || (production !== 'in_production' ? day : ''),
    notes: lines.length ? `${sale.notes ?? ''}\n${lines.join('\n')}`.trim() : sale.notes,
    updatedAt: now, updatedBy: member.email,
  }
  const err = await writeSale(updated)
  if (err) return NextResponse.json({ error: err }, { status: 500 })
  const rates = await suggestedRates()
  const b = costingBucket(updated, figures(updated, rates?.rates ?? null))
  return NextResponse.json({ item: b ? costingItem(updated, b) : null, paypal: paypalNote })
}
