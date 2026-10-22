import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, loadLeadRecord } from '@/lib/leadrecord'
import { normalizeQuote, quoteProblems } from '@/lib/pricequote'
import { quotePdfFor } from '@/lib/quotepdfload'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST { quote }: the quotation PDF for the quote being written, so the agent
// can look at (or send on WhatsApp) exactly what the email will attach.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const body = await req.json().catch(() => ({}))
  if (!body.quote || typeof body.quote !== 'object') return NextResponse.json({ error: 'Nothing to print' }, { status: 400 })
  const q = normalizeQuote(body.quote)
  const problems = quoteProblems(q)
  if (problems.length) return NextResponse.json({ error: `Add ${problems.join(' and ')}.` }, { status: 400 })
  const record = await loadLeadRecord(access.member, id)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // The record's contact is already masked for a member who may not read it.
  const to = /^[^\s@*]+@[^\s@*]+\.[a-z]{2,}$/i.test(record.contact.email) ? record.contact.email : ''
  const name = String(body.customerName ?? '').trim() || record.contact.name || q.greetingName
  const pdf = await quotePdfFor({ siteId: access.siteId, siteName: record.siteName, customerName: name, customerEmail: to, quote: q })
  return new NextResponse(Buffer.from(pdf.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${pdf.name.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  })
}
