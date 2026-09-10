import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { cleanPayLink, payLinkFor, readPayLink, savePayLink } from '@/lib/paylink'

export const dynamic = 'force-dynamic'

// Read and set the payment link for one lead.
//
// GET answers everyone who can open the lead, but the URL itself is in the
// response ONLY for a member who may see contacts. Everybody else is told that
// a link exists and who saved it — which is all they need in order to press
// Send, and nothing they could reconstruct the link from. See lib/paylink.ts
// for why the link is PII at all.
//
// POST is admins only, and not merely because of the UI: a value written here
// is mailed to a customer from the company's own mailbox, so the one person who
// may not read it is certainly not the one who gets to set it.
async function ctxFor(req: NextRequest, id: string) {
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return { error: NextResponse.json({ error: 'Not allowed' }, { status: access.status }) }
  return { access }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await ctxFor(req, id)
  if ('error' in c) return c.error
  const { link, sent } = await readPayLink(id)
  return NextResponse.json({ ok: true, ...payLinkFor(c.access.member, link, sent) })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await ctxFor(req, id)
  if ('error' in c) return c.error
  if (c.access.member.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin can set the payment link.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const raw = String(body?.url ?? '').trim()
  // An empty string clears it — stored as a further row, never a delete, so the
  // history of who set what stays readable.
  const url = raw ? cleanPayLink(raw) : null
  if (raw && !url) {
    return NextResponse.json({ error: 'That does not look like a payment link — it must be a full https:// address.' }, { status: 400 })
  }

  const { error } = await savePayLink(id, c.access.siteId, url, c.access.member.email)
  if (error) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })

  const { link, sent } = await readPayLink(id)
  return NextResponse.json({ ok: true, ...payLinkFor(c.access.member, link, sent) })
}
