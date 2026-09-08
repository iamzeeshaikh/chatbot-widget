import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { billingGaps, billingToken, readBilling } from '@/lib/billing'

export const dynamic = 'force-dynamic'

/**
 * The agent's side of the billing form: the link to send, and whatever the
 * customer has sent back.
 *
 * Guarded by guardLeadAccess like every other /api/leads/[id]/* route, so an
 * agent cannot mint a billing link for a lead they are not allowed to see —
 * the link is a credential, and handing one out is a disclosure.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const details = await readBilling(id)
  // The origin the agent is actually on, not the one an env var names: this
  // project may serve from chat.zeeops.dev and crm.zeeops.dev at once.
  const base = new URL(req.url).origin || process.env.NEXT_PUBLIC_BASE_URL || ''
  return NextResponse.json({
    ok: true,
    url: `${base.replace(/\/+$/, '')}/billing/${billingToken(id)}`,
    details,
    gaps: billingGaps(details),
  })
}
