import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { readSales, writeSale, suggestedRates } from '@/lib/sales'
import { figures } from '@/lib/salescore'
import { canUseCosting, costingBucket, costingItem, cleanCostLines, type CostingItem } from '@/lib/costing'
import { closeCostingTask } from '@/lib/costingsweep'

export const dynamic = 'force-dynamic'

// The costing page (lib/costing.ts). Packaging admins and the costing person.
//   GET                       the orders, without any money
//   POST {saleId, costs[]}    replace that sale's PKR cost lines
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseCosting(member)) return NextResponse.json({ error: 'Costing is not open to this account.' }, { status: 403 })
  const [sales, rates] = await Promise.all([readSales('packaging'), suggestedRates()])
  const suggested = rates?.rates ?? null
  const items: CostingItem[] = []
  const cutoff = new Date(Date.now() - 45 * 86400 * 1000).toISOString().slice(0, 10)
  for (const s of sales) {
    const b = costingBucket(s, figures(s, suggested))
    if (!b) continue
    // Costed ones stay visible for a while so a slip can be corrected.
    if (b === 'done' && (s.orderDate || '') < cutoff) continue
    items.push(costingItem(s, b))
  }
  return NextResponse.json({ items })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseCosting(member)) return NextResponse.json({ error: 'Costing is not open to this account.' }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const saleId = String(body?.saleId ?? '').trim()
  const sale = (await readSales('packaging')).find((s) => s.id === saleId)
  if (!sale || sale.stream !== 'pk_direct') return NextResponse.json({ error: 'Order not found.' }, { status: 404 })
  if (!sale.costs.every((c) => c.currency === 'PKR')) {
    return NextResponse.json({ error: 'This order has costs in another currency. Ask the owner to change it from Sales.' }, { status: 409 })
  }
  const costs = cleanCostLines(body?.costs)
  const now = new Date().toISOString()
  const err = await writeSale({ ...sale, costs, updatedAt: now, updatedBy: member.email })
  if (err) return NextResponse.json({ error: err }, { status: 500 })
  if (costs.length > 0) await closeCostingTask(sale.id, member.email).catch(() => false)
  const rates = await suggestedRates()
  const next = { ...sale, costs, updatedAt: now, updatedBy: member.email }
  const b = costingBucket(next, figures(next, rates?.rates ?? null))
  return NextResponse.json({ item: b ? costingItem(next, b) : null })
}
