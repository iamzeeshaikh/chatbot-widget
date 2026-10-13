import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, loadLeadRecord } from '@/lib/leadrecord'
import { buildSheet, readInvoice, suggestFromTimeline } from '@/lib/invoice'
import { listInvoices, saveInvoice } from '@/lib/invoicestore'
import { loadAgentSignatures } from '@/lib/signature'
import { pktDayKey } from '@/lib/datetime'
import {
  blankInvoice, cleanInvoiceDoc, newInvoiceId, poNumber, sitePrefix, type InvoiceDoc,
} from '@/lib/invoicedoc'

export const dynamic = 'force-dynamic'

// The invoices on one lead (lib/invoicedoc.ts), and a pre-filled new one.
//
// Contact details come through loadLeadRecord, the read edge where lib/pii.ts
// masks what a member may not see — the same reason the older invoice sheet
// route gives. An invoice is built to be copied elsewhere; it must never be the
// way an address leaks.
async function context(req: NextRequest, id: string) {
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return { error: NextResponse.json({ error: 'Not allowed' }, { status: access.status }) }
  const record = await loadLeadRecord(access.member, id)
  if (!record) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { access, record }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  // The record page's card only needs the list. Loading the whole record for
  // it (the prefill below) cost ~4s on every record open.
  if (req.nextUrl.searchParams.get('list') === '1') {
    const access = await guardLeadAccess(await getMember(req), id, 'records')
    if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
    return NextResponse.json({ ok: true, invoices: await listInvoices(id) })
  }
  const c = await context(req, id)
  if ('error' in c) return c.error
  const { access, record } = c

  const [invoices, draft, sigs] = await Promise.all([listInvoices(id), readInvoice(id), loadAgentSignatures()])
  const sheet = buildSheet(record, draft, suggestFromTimeline(record.timeline ?? []))
  const agentName = sigs.get(access.member.email.toLowerCase())?.name || ''
  const prefix = sitePrefix(record.siteName || record.siteId)
  const today = pktDayKey(new Date())

  // A new invoice starts from what the CRM already knows: the customer, the
  // address and item the conversation mentioned, the agent's own name.
  const prefill: InvoiceDoc = blankInvoice()
  prefill.agentName = agentName
  prefill.date = today
  prefill.dueDate = today
  prefill.poNumber = poNumber(prefix, agentName, today)
  prefill.billTo = {
    name: sheet.billTo || sheet.name || record.contact.name || '',
    company: '', address: sheet.shipTo || '', phone: sheet.phone || record.contact.phone || '',
  }
  // The rate is never guessed: a dollar figure in the thread may be a total, a
  // budget or a competitor's price, and dividing it by a quantity once put
  // $0.004 per box on an invoice. The agent types the rate they quoted.
  const qty = sheet.quantity.replace(/[^\d.,]/g, '').replace(/,/g, '')
  prefill.items = [{ name: sheet.item || '', details: '', quantity: qty, rate: '' }]
  if (sheet.currency) prefill.currency = sheet.currency

  return NextResponse.json({
    ok: true, invoices, prefill,
    lead: { id, name: record.contact.name, email: record.contact.email, siteId: record.siteId, siteName: record.siteName },
    prefix, logoUrl: `/api/logo/${encodeURIComponent(record.siteId)}`,
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await context(req, id)
  if ('error' in c) return c.error
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 })

  const doc = cleanInvoiceDoc((body as { doc?: unknown }).doc ?? body)
  if (!doc.number) return NextResponse.json({ error: 'Add the invoice number first (for example TPC-018).' }, { status: 400 })
  const existing = doc.id ? (await listInvoices(id)).find((d) => d.id === doc.id) : undefined
  const now = new Date().toISOString()
  const saved: InvoiceDoc = {
    ...doc,
    id: existing?.id ?? newInvoiceId(),
    createdBy: existing?.createdBy ?? c.access.member.email,
    createdAt: existing?.createdAt ?? now,
    updatedBy: c.access.member.email,
    updatedAt: now,
  }
  const { error } = await saveInvoice(id, c.access.siteId, saved)
  if (error) return NextResponse.json({ error: 'The invoice did not save.' }, { status: 500 })
  return NextResponse.json({ ok: true, invoice: saved })
}

// Removing is a row too: the trail keeps that an invoice existed.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await context(req, id)
  if ('error' in c) return c.error
  const inv = req.nextUrl.searchParams.get('inv') ?? ''
  const existing = (await listInvoices(id)).find((d) => d.id === inv)
  if (!existing) return NextResponse.json({ error: 'No such invoice' }, { status: 404 })
  const now = new Date().toISOString()
  const { error } = await saveInvoice(id, c.access.siteId, { ...existing, deleted: true, updatedBy: c.access.member.email, updatedAt: now })
  if (error) return NextResponse.json({ error: 'Could not remove it.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
