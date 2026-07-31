import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { CRM_VALUE_ROLE, isCrmCurrency, DEFAULT_CURRENCY } from '@/lib/crm'

export const dynamic = 'force-dynamic'

const MAX_AMOUNT = 1_000_000_000

// Accepts a number, a numeric string ("12,500" / "$12500"), or null/'' to clear.
function amount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]/g, ''))
  if (!isFinite(n) || n < 0 || n > MAX_AMOUNT) return null
  return Math.round(n * 100) / 100
}

// Estimated deal value, and the won revenue (only meaningful once the stage is
// Won — the UI only offers it there, but a stale value is harmless: it's just
// another field on the newest crm_value row).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const payload = await req.json().catch(() => ({}))
  const at = new Date().toISOString()
  const entry = {
    estimated: amount(payload.estimated),
    won: amount(payload.won),
    currency: isCrmCurrency(payload.currency) ? payload.currency : DEFAULT_CURRENCY,
    updated_by: access.member.email,
    at,
  }

  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_VALUE_ROLE, message: JSON.stringify(entry),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, value: entry })
}
