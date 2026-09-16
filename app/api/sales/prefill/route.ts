import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, loadLeadRecord } from '@/lib/leadrecord'
import { readInvoice, buildSheet, suggestFromTimeline } from '@/lib/invoice'
import { pktDayKey } from '@/lib/datetime'
import { readSales } from '@/lib/sales'
import { canUseSales, parseAmount } from '@/lib/salescore'

export const dynamic = 'force-dynamic'

// A new sale, filled in from a won lead.
//
// The lead already carries everything a sale needs — the contact, and the
// invoice sheet with what was sold, how many and for how much — so "Add to
// sales" starts from that instead of a blank form somebody retypes. Nothing is
// written here; the sale only exists once an admin saves it.
//
// If the lead is ALREADY in the ledger the existing sale's id comes back
// instead, so pressing the button twice opens the sale rather than making a
// duplicate that would double the month's total.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const leadId = req.nextUrl.searchParams.get('lead') ?? ''
  const access = await guardLeadAccess(member, leadId, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const existing = (await readSales(member.workspace)).find((s) => s.leadId === leadId)
  if (existing) return NextResponse.json({ existingId: existing.id })

  const record = await loadLeadRecord(access.member, leadId)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const sheet = buildSheet(record, await readInvoice(leadId), suggestFromTimeline(record.timeline ?? []))

  return NextResponse.json({
    draft: {
      stream: member.workspace === 'sports' ? 'sp_direct' : 'pk_direct',
      leadId,
      customer: sheet.name,
      // The invoice's bill-to defaults to the contact's own name; only a
      // DIFFERENT one says anything about a company.
      company: sheet.billTo && sheet.billTo !== sheet.name ? sheet.billTo : '',
      email: sheet.email,
      phone: sheet.phone,
      country: record.country ?? '',
      orderDate: pktDayKey(new Date()),
      product: sheet.item,
      quantity: sheet.quantity,
      currency: sheet.currency,
      orderAmount: parseAmount(sheet.amount) ?? '',
      salesPerson: record.owner ?? '',
      source: `ZeeOps lead — ${record.siteName}`,
      notes: sheet.notes,
    },
  })
}
