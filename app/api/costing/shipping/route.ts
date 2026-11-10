import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { isOwnLeadsOnly, ownLeadsRefusal } from '@/lib/ownleads'
import { readSales, suggestedRates } from '@/lib/sales'
import { figures } from '@/lib/salescore'
import { canUseCosting, costingBucket, costingItem, cleanShipping } from '@/lib/costing'
import { applySaleShipping } from '@/lib/saleshipping'

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

  // Shared with production jobs (lib/saleshipping.ts), so both doors write the
  // same note and put the same tracker on PayPal.
  const r = await applySaleShipping(sale, { production, tracking, by: member.email, source: 'Costing' })
  if (r.error) return NextResponse.json({ error: r.error }, { status: 500 })
  const updated = r.updated
  const paypalNote = r.paypalNote
  const rates = await suggestedRates()
  const b = costingBucket(updated, figures(updated, rates?.rates ?? null))
  return NextResponse.json({ item: b ? costingItem(updated, b) : null, paypal: paypalNote })
}
