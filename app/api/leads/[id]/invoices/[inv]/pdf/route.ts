import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { listInvoices } from '@/lib/invoicestore'
import { buildInvoicePdf } from '@/lib/invoicepdf'
import { loadSiteContacts } from '@/lib/signature'
import { bankDetails, isBankTransfer } from '@/lib/bankdetails'
import { siteWorkspace } from '@/lib/workspaces'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// One saved invoice as a PDF download. The logo is fetched server-side from
// the URL stored for the site — the same source /api/logo proxies — so the
// PDF carries the brand without the browser having to reach the site.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; inv: string }> }) {
  const { id, inv } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const doc = (await listInvoices(id)).find((d) => d.id === inv)
  if (!doc) return NextResponse.json({ error: 'No such invoice' }, { status: 404 })

  const [contacts, site] = await Promise.all([
    loadSiteContacts(),
    supabase.from('sites').select('name').eq('site_id', access.siteId).maybeSingle(),
  ])
  let logo: Uint8Array | null = null
  const url = contacts.get(access.siteId)?.logo ?? ''
  if (/^https:\/\//i.test(url)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'ZeeOps-Invoice/1.0' }, signal: AbortSignal.timeout(8000) })
      if (r.ok) logo = new Uint8Array(await r.arrayBuffer())
    } catch { logo = null }
  }
  const bank = isBankTransfer(doc.paymentTerms) ? bankDetails(siteWorkspace(access.siteId) ?? '') : ''
  const bytes = await buildInvoicePdf(doc, { logo, siteName: String(site.data?.name ?? access.siteId), bank })
  const name = `Invoice ${doc.number}`.replace(/[^\w .-]/g, '') || 'Invoice'
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}
