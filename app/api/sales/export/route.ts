import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import type { Workspace } from '@/lib/workspaces'
import { pktDayKey } from '@/lib/datetime'
import { toCsv } from '@/lib/reportexport'
import { readSales, suggestedRates } from '@/lib/sales'
import {
  STREAMS, canUseSales, isSalesOwner, isSalesStream, figures,
  PAYMENT_STATUS_LABEL, PRODUCTION_LABEL,
} from '@/lib/salescore'

export const dynamic = 'force-dynamic'

// The ledger as a spreadsheet — the same rows and the same arithmetic as the
// page, because both come from lib/salescore.ts. Same access rules as
// /api/sales: admins, own workspace; `scope=master` for the owners only;
// `stream=` narrows it to one stream.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const master = req.nextUrl.searchParams.get('scope') === 'master'
  if (master && !isSalesOwner(member)) {
    return NextResponse.json({ error: 'The master view is for the owner accounts only.' }, { status: 403 })
  }
  const streamParam = req.nextUrl.searchParams.get('stream')
  const stream = isSalesStream(streamParam) ? streamParam : null

  const workspaces: Workspace[] = master ? ['packaging', 'sports'] : [member.workspace]
  const [lists, rateInfo] = await Promise.all([Promise.all(workspaces.map(readSales)), suggestedRates()])
  const rates = rateInfo?.rates ?? null
  const sales = lists.flat().filter((s) => !stream || s.stream === stream)

  const headers = [
    'Stream', 'Reference', 'Customer', 'Company', 'Email', 'Phone', 'Country', 'Order date',
    'Product', 'Size', 'Material', 'Printing', 'Quantity', 'Currency', 'Order amount',
    'Received', 'Fees', 'Net received', 'Outstanding', 'Payment status', 'Payments',
    'Net received PKR', 'Outstanding PKR (est.)', 'Cost PKR', 'Profit PKR', 'PKR figures estimated',
    'Production', 'Sales person', 'Source', 'Owed by', 'Notes',
  ]
  const rows = sales.map((s) => {
    const f = figures(s, rates)
    return [
      STREAMS[s.stream].label, s.reference, s.customer, s.company, s.email, s.phone, s.country, s.orderDate,
      s.product, s.size, s.material, s.printing, s.quantity, s.currency, s.orderAmount,
      f.received, f.fees, f.net, f.outstanding, PAYMENT_STATUS_LABEL[f.status],
      s.payments.map((p) => `${p.date} ${p.amount} (fee ${p.fee}, ${p.method}${p.rate ? `, @${p.rate}` : ''})`).join('; '),
      f.netPkr, f.outstandingPkr, f.costPkr, f.profitPkr, f.estimated || f.incomplete ? 'yes' : 'no',
      s.production ? PRODUCTION_LABEL[s.production] : '', s.salesPerson, s.source, s.counterparty, s.notes,
    ]
  })

  const name = `sales-${master ? 'master' : member.workspace}${stream ? `-${stream}` : ''}-${pktDayKey(new Date())}.csv`
  return new NextResponse(toCsv(headers, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  })
}
