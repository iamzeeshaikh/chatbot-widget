import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { isOwnLeadsOnly, ownLeadsRefusal } from '@/lib/ownleads'
import { readSales, suggestedRates } from '@/lib/sales'
import { readExpenses } from '@/lib/expenses'
import { figures, expensePkr, canSeeGrowth } from '@/lib/salescore'
import { firstResponses } from '@/lib/firstresponse'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The growth dashboard (owner, 2026-11-06: "$60k target rakh lo"): one month
// of Model Town direct sales against a target, and the four numbers that move
// it — leads, first-reply time, conversion, average order — plus the margin.
// Leads come from /api/admin/leads-billing (the same billable count the
// Billing tab shows, called with the caller's own cookie so the scope rules
// are identical); money from the sales ledger, exactly as /sales computes it.
//   GET ?month=YYYY-MM   (default: this month, Pakistan time)

const TARGET_USD = 60_000
const PKT_MS = 5 * 3600_000

interface Lead { session_id: string; captured_at: string; source: string }

function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number)
  const from = new Date(Date.UTC(y, m - 1, 1) - PKT_MS)
  const to = new Date(Date.UTC(y, m, 1) - PKT_MS)
  return { from, to, days: new Date(Date.UTC(y, m, 0)).getUTCDate() }
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const h = Math.floor(s.length / 2)
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Own-leads-only (lib/ownleads.ts): this screen is about everybody's leads.
  if (isOwnLeadsOnly(member)) return ownLeadsRefusal()
  if (!canSeeGrowth(member)) return NextResponse.json({ error: 'Not available.' }, { status: 403 })

  const nowPkt = new Date(Date.now() + PKT_MS)
  const month = /^\d{4}-\d{2}$/.test(req.nextUrl.searchParams.get('month') ?? '')
    ? req.nextUrl.searchParams.get('month')!
    : `${nowPkt.getUTCFullYear()}-${String(nowPkt.getUTCMonth() + 1).padStart(2, '0')}`
  const { from, to, days } = monthBounds(month)
  const now = Date.now()
  const elapsedDays = Math.min(days, Math.max(0, (Math.min(now, +to) - +from) / 86400_000))

  // Leads: exactly the Billing tab's numbers.
  const billUrl = new URL('/api/admin/leads-billing', req.nextUrl.origin)
  billUrl.searchParams.set('from', from.toISOString())
  billUrl.searchParams.set('to', to.toISOString())
  const billRes = await fetch(billUrl, { headers: { cookie: req.headers.get('cookie') ?? '' }, cache: 'no-store' })
  const bill = billRes.ok ? await billRes.json() as { billable: number; total: number; leads: Lead[] } : { billable: 0, total: 0, leads: [] as Lead[] }
  const leads = (bill.leads ?? []).filter((l) => l.source !== 'checkout')

  // First reply, per lead (the same rule the leads table uses).
  const fr = await firstResponses(leads.map((l) => ({ key: l.session_id, sessions: [l.session_id], createdAt: l.captured_at })))

  // Money.
  const [sales, expenses, rates] = await Promise.all([readSales('packaging'), readExpenses('packaging'), suggestedRates()])
  const r = rates?.rates ?? null
  const monthSales = sales.filter((s) => s.stream === 'pk_direct' && (s.orderDate || '').startsWith(month))
    .map((s) => ({ s, f: figures(s, r) }))
    .filter(({ f }) => !f.closed)
  const usd = (s: { currency: string; orderAmount: number }) => (s.currency === 'USD' ? s.orderAmount : s.orderAmount * ((r?.[s.currency as 'GBP'] ?? 0) / (r?.USD ?? 1)))
  const orderValue = monthSales.reduce((a, { s }) => a + usd(s), 0)
  const received = monthSales.reduce((a, { s, f }) => a + (s.currency === 'USD' ? f.received : 0), 0)
  // Margin is over orders the customer has actually started paying for: an
  // unpaid invoice (Sydney, Oct 2026) is neither revenue nor profit yet.
  const revenuePkr = monthSales.filter(({ f }) => f.received > 0).reduce((a, { f }) => a + f.revenuePkr, 0)
  const costed = monthSales.filter(({ f }) => f.profitKnown)
  const costedProfit = costed.reduce((a, { f }) => a + f.profitPkr, 0)
  const costedRevenue = costed.reduce((a, { f }) => a + f.revenuePkr, 0)
  const marginCosted = costedRevenue > 0 ? costedProfit / costedRevenue : null
  const uncostedRevenue = monthSales.filter(({ f }) => !f.profitKnown && f.received > 0).reduce((a, { f }) => a + f.revenuePkr, 0)
  const expensePkrTotal = expenses.filter((e) => e.month === month).reduce((a, e) => a + expensePkr(e, r).value, 0)
  const estNet = costedProfit + (marginCosted ?? 0) * uncostedRevenue - expensePkrTotal
  const netMargin = revenuePkr > 0 ? estNet / revenuePkr : null

  // Weeks: Monday-start, inside the month.
  const weeks: { label: string; leads: number; orders: number; sales: number; medianReplyMin: number | null }[] = []
  for (let d = 0; d < days; ) {
    const start = new Date(+from + d * 86400_000)
    const pktDay = new Date(+start + PKT_MS).getUTCDay()
    const len = Math.min(days - d, pktDay === 1 ? 7 : ((8 - pktDay) % 7) || 7)
    const end = new Date(+start + len * 86400_000)
    const inWeek = (iso: string) => { const t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`); return t >= +start && t < +end }
    const wl = leads.filter((l) => inWeek(l.captured_at))
    const wo = monthSales.filter(({ s }) => { const t = Date.parse(`${s.orderDate}T12:00:00Z`) - PKT_MS; return t >= +start && t < +end })
    const replies = wl.map((l) => fr.get(l.session_id)?.minutes).filter((x): x is number => typeof x === 'number')
    const fmt = (dt: Date) => { const p = new Date(+dt + PKT_MS); return `${p.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.getUTCMonth()]}` }
    weeks.push({ label: `${fmt(start)} – ${fmt(new Date(+end - 1))}`, leads: wl.length, orders: wo.length, sales: Math.round(wo.reduce((a, { s }) => a + usd(s), 0)), medianReplyMin: median(replies) })
    d += len
  }

  const replies = leads.map((l) => fr.get(l.session_id)?.minutes).filter((x): x is number => typeof x === 'number')
  const unanswered = leads.filter((l) => !fr.has(l.session_id)).length
  const orders = monthSales.length
  const avgOrder = orders ? orderValue / orders : null
  const conversion = bill.billable > 0 ? orders / bill.billable : null
  const projected = elapsedDays > 0.5 ? (orderValue / elapsedDays) * days : null
  const pace = TARGET_USD * (elapsedDays / days)
  const remainingDays = Math.max(0, days - elapsedDays)
  const needed = Math.max(0, TARGET_USD - orderValue)

  return NextResponse.json({
    month, target: TARGET_USD, days, elapsedDays: Math.round(elapsedDays * 10) / 10,
    orderValue: Math.round(orderValue), received: Math.round(received), orders, avgOrder: avgOrder && Math.round(avgOrder),
    leads: bill.billable, conversion,
    medianReplyMin: median(replies), within15: replies.length ? replies.filter((m) => m <= 15).length / leads.length : null, unanswered,
    revenuePkr: Math.round(revenuePkr), expensesPkr: Math.round(expensePkrTotal), estNetPkr: Math.round(estNet), netMargin,
    costedOrders: costed.length, marginCosted,
    pace: Math.round(pace), projected: projected && Math.round(projected),
    neededPerDay: remainingDays > 0 ? Math.round(needed / remainingDays) : null,
    ordersNeeded: avgOrder ? Math.ceil(needed / avgOrder) : null,
    weeks,
  })
}
