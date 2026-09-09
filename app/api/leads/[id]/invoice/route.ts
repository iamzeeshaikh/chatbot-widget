import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, loadLeadRecord } from '@/lib/leadrecord'
import {
  buildSheet, cleanInvoice, readInvoice, sheetToText, suggestFromTimeline, writeInvoice,
} from '@/lib/invoice'

export const dynamic = 'force-dynamic'

/**
 * The invoice sheet for one lead.
 *
 * Contact details come from loadLeadRecord rather than from the database
 * directly, and that is load-bearing: loadLeadRecord is the read edge where
 * lib/pii.ts masks the address and number for a member who may not see them.
 * Assembling this sheet from raw rows would hand an agent the address the
 * workspace hid — and a sheet built to be copied elsewhere is the worst
 * possible shape for that leak.
 */
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
  const c = await context(req, id)
  if ('error' in c) return c.error

  const draft = await readInvoice(id)
  const sheet = buildSheet(c.record, draft)
  return NextResponse.json({
    ok: true,
    sheet,
    text: sheetToText(sheet),
    draft: draft ?? null,
    // Read out of the conversation and offered, never applied: "8 sets" in a
    // thread might be what was ordered or what was first asked about.
    suggestions: suggestFromTimeline(c.record.timeline ?? []),
    contactsHidden: Boolean(c.record.contactsHidden),
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await context(req, id)
  if ('error' in c) return c.error

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Nothing to save.' }, { status: 400 })
  }
  const draft = cleanInvoice(body, c.access.member.email)
  const { error } = await writeInvoice(id, c.access.siteId, draft)
  if (error) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })

  const sheet = buildSheet(c.record, draft)
  return NextResponse.json({ ok: true, sheet, text: sheetToText(sheet), draft })
}
