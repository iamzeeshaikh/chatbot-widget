import { NextRequest, NextResponse } from 'next/server'
import { resolveLeadSite } from '@/lib/leadrecord'
import {
  cleanBilling, leadFromToken, readBilling, writeBilling, type BillingDetails,
} from '@/lib/billing'

export const dynamic = 'force-dynamic'

/**
 * The customer's own billing form. Deliberately unauthenticated — the customer
 * has no login and never will — so the signed token IS the credential and every
 * handler here starts by verifying it.
 *
 * What this route will not do:
 *  - It never returns the lead's message history, owner or notes. A billing
 *    link handed to a purchasing clerk must not become a window into the CRM.
 *  - It never accepts a card number. There is no field for one, and nothing
 *    here would store it if there were.
 */
function resolve(token: string): string | null {
  return leadFromToken(decodeURIComponent(String(token ?? '')))
}

// What the form needs to render: does this link point at something real, and
// has it already been filled in? Nothing else.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const leadId = resolve(token)
  if (!leadId) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })

  const site = await resolveLeadSite(leadId)
  if (!site) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })

  const existing = await readBilling(leadId)
  return NextResponse.json({
    ok: true,
    // The customer's own name, so the form can greet them. Nothing else off
    // the record travels to an unauthenticated page.
    customerName: site.lead?.name ?? '',
    submitted: Boolean(existing),
    details: existing ?? null,
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const leadId = resolve(token)
  if (!leadId) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })

  const site = await resolveLeadSite(leadId)
  if (!site) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Nothing was submitted.' }, { status: 400 })
  }

  const details: BillingDetails = cleanBilling(body)
  if (!details.billTo || !details.contactEmail) {
    return NextResponse.json(
      { error: 'The bill-to name and a billing email are both needed.' }, { status: 400 },
    )
  }

  const { error } = await writeBilling(leadId, site.siteId, details)
  if (error) return NextResponse.json({ error: 'That did not save. Please try again.' }, { status: 500 })

  return NextResponse.json({ ok: true })
}
