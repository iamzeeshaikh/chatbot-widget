import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, leadPhone, leadRecipient } from '@/lib/leadrecord'
import { hasFeature } from '@/lib/workspaces'
import { cleanPayLink, payChannels, payLinkFor, readPayLink, savePayLink, whatsappWindowOpen } from '@/lib/paylink'

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

/**
 * The state, including WHICH WAY this customer can be reached.
 *
 * Resolved here rather than in the browser because both halves of it are
 * hidden from the member who needs it: a masked agent is shown "•••••• hidden"
 * for the address and the number alike, so only the server can say whether
 * either exists.
 */
async function stateFor(member: Parameters<typeof payLinkFor>[0] & { workspace: 'sports' | 'packaging' }, id: string) {
  const [{ link, sent }, to, phone] = await Promise.all([readPayLink(id), leadRecipient(id), leadPhone(id)])
  const channels = payChannels({
    email: Boolean(to), phone: Boolean(phone),
    canEmail: hasFeature(member.workspace, 'email'),
    canWhatsApp: hasFeature(member.workspace, 'telephony'),
  })
  const waOpen = channels.includes('whatsapp') ? await whatsappWindowOpen(id) : null
  return payLinkFor(member, link, sent, channels, waOpen)
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await ctxFor(req, id)
  if ('error' in c) return c.error
  return NextResponse.json({ ok: true, ...(await stateFor(c.access.member, id)) })
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

  return NextResponse.json({ ok: true, ...(await stateFor(c.access.member, id)) })
}
