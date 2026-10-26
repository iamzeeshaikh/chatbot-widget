import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, leadRecipient, loadLeadRecord, writeControlRow } from '@/lib/leadrecord'
import { listInvoices } from '@/lib/invoicestore'
import { num, totals } from '@/lib/invoicedoc'
import { CRM_NOTE_ROLE, type CrmNoteEntry } from '@/lib/crm'
import { createDraft, sendInvoice, deleteDraft, nextInvoiceNumber, paypalConfigured } from '@/lib/paypalapi'
import { siteWorkspace } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Send one saved ZeeOps invoice through PayPal (owner, 2026-10-26: "khud
// invoice bh bana sako"). PACKAGING only — the PayPal account is ZCB DIGITAL.
// POST { deposit?: number }  → creates the PayPal invoice from the saved doc,
// sends it (PayPal emails the customer), saves the payer link on the lead and
// writes a note. The paid side then arrives by itself (lib/paypalsync.ts).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; inv: string }> }) {
  const { id, inv } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  if (siteWorkspace(access.siteId) !== 'packaging') return NextResponse.json({ error: 'PayPal invoices are for packaging leads.' }, { status: 400 })
  if (!paypalConfigured()) return NextResponse.json({ error: 'PayPal is not connected.' }, { status: 503 })
  const doc = (await listInvoices(id)).find((d) => d.id === inv)
  if (!doc) return NextResponse.json({ error: 'Save the invoice first.' }, { status: 404 })
  const record = await loadLeadRecord(access.member, id)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const to = await leadRecipient(id)
  if (!to) return NextResponse.json({ error: 'This lead has no email address, so PayPal cannot send the invoice.' }, { status: 400 })
  const items = doc.items
    .map((it) => ({ name: it.name.trim(), description: it.details.replace(/\n+/g, ', ').trim(), quantity: num(it.quantity), unitPrice: num(it.rate) }))
    .filter((it) => it.name && it.quantity > 0 && it.unitPrice > 0)
  if (!items.length) return NextResponse.json({ error: 'Add at least one item with a quantity and a price.' }, { status: 400 })
  const body = await req.json().catch(() => ({})) as { deposit?: number }
  const total = totals(doc).total
  const deposit = Number(body.deposit) > 0 && Number(body.deposit) < total ? Math.round(Number(body.deposit) * 100) / 100 : null

  let draftId = ''
  try {
    const number = await nextInvoiceNumber().catch(() => '')
    const draft = await createDraft({
      number, currency: doc.currency || 'USD', date: doc.date, dueDate: doc.dueDate,
      recipient: { email: to, name: doc.billTo.name || record.contact.name, company: doc.billTo.company, address: doc.billTo.address, phone: doc.billTo.phone },
      shipTo: doc.shipSame ? null : { name: doc.shipTo.name, company: doc.shipTo.company, address: doc.shipTo.address },
      items, taxPercent: num(doc.taxPercent), note: doc.notes, terms: doc.terms,
      reference: `${doc.number}${doc.poNumber ? ` · ${doc.poNumber}` : ''}`, minimumDue: deposit,
    })
    draftId = draft.id
    const link = await sendInvoice(draft.id)
    const at = new Date().toISOString()
    await writeControlRow({ sessionId: id, siteId: access.siteId, role: 'crm_pay_link', message: JSON.stringify({ kind: 'link', url: link, by: access.member.email, at }) })
    const note: CrmNoteEntry = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, author: access.member.email, at,
      body: `PayPal invoice ${draft.number} sent to ${to} for invoice ${doc.number} — ${doc.currency || 'USD'} ${total.toFixed(2)}${deposit ? ` (deposit allowed: ${deposit.toFixed(2)})` : ''}. Payer link: ${link}`,
    }
    await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(note) })
    return NextResponse.json({ ok: true, paypalNumber: draft.number, paypalId: draft.id, link })
  } catch (e) {
    // A draft that could not be sent is removed, so PayPal keeps no stray copy.
    if (draftId) await deleteDraft(draftId).catch(() => {})
    return NextResponse.json({ error: e instanceof Error ? e.message : 'PayPal refused the invoice' }, { status: 502 })
  }
}
