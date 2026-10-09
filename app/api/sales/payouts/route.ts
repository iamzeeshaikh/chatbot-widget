import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { readSales, writeSale } from '@/lib/sales'
import { readPayouts, writePayout } from '@/lib/payouts'
import { canUseSales, cleanPayout, allocatePayout, payoutRate, type Payout, type Sale } from '@/lib/salescore'

export const dynamic = 'force-dynamic'

// Payouts: the withdrawals that turned dollars into rupees.
//
// ADMINS ONLY and only their own workspace, exactly like the sales ledger.
// Recording one does two writes, in this order:
//   1. the payout snapshot, carrying the list of payments it settled;
//   2. one sale snapshot per settled payment, with that payment's rate set to
//      the payout's effective rate (PKR in ÷ USD out) and the payout id in
//      the payment's note.
// A crash between the two leaves a payout that says what it covered and
// payments that still read "est." — visible, and repaired by deleting and
// re-entering the payout. Nothing here can double-lock: allocation only ever
// considers payments with no rate.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })
  const payouts = await readPayouts(member.workspace)
  return NextResponse.json({ payouts: payouts.map((p) => ({ ...p, rate: payoutRate(p) })) })
}

function lockPayments(sales: Sale[], payout: Payout, rate: number, by: string): Sale[] {
  const at = new Date().toISOString()
  const touched: Sale[] = []
  for (const s of sales) {
    const mine = payout.settled.filter((x) => x.saleId === s.id)
    if (mine.length === 0) continue
    const ids = new Set(mine.map((x) => x.paymentId))
    touched.push({
      ...s,
      payments: s.payments.map((p) => ids.has(p.id)
        ? { ...p, rate, note: [p.note, `Rate locked by payout ${payout.id} (${payout.date})`].filter(Boolean).join(' · ') }
        : p),
      updatedAt: at, updatedBy: by,
    })
  }
  return touched
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const raw = (body?.payout ?? {}) as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id) return NextResponse.json({ error: 'A payout cannot be edited once it has locked rates — delete it and enter it again.' }, { status: 400 })

  const cleaned = cleanPayout(raw, null, member.email, member.workspace)
  if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 })
  const rate = payoutRate(cleaned.payout)
  if (!rate) return NextResponse.json({ error: 'The amounts do not give a rate.' }, { status: 400 })

  const sales = await readSales(member.workspace)
  const alloc = allocatePayout(cleaned.payout, sales)
  const payout: Payout = { ...cleaned.payout, settled: alloc.settled, leftover: alloc.leftover }

  const failed = await writePayout(payout)
  if (failed) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })

  const results = await Promise.all(lockPayments(sales, payout, rate, member.email).map(writeSale))
  const lockFailed = results.filter(Boolean).length

  return NextResponse.json({
    ok: true, payout: { ...payout, rate }, lockedPayments: alloc.settled.length, lockFailed,
    nextUncovered: alloc.nextUncovered,
  })
}

export async function DELETE(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id') ?? ''
  const prev = id ? (await readPayouts(member.workspace)).find((p) => p.id === id) : null
  if (!prev) return NextResponse.json({ error: 'That payout is not in this workspace.' }, { status: 404 })

  // A compensating write, not a rollback: the payout is marked deleted and
  // every payment it locked goes back to "no rate", so the next payout can
  // cover it again. Both stay in history.
  const at = new Date().toISOString()
  const failed = await writePayout({ ...prev, deleted: true, updatedAt: at, updatedBy: member.email })
  if (failed) return NextResponse.json({ error: 'That did not delete.' }, { status: 500 })

  const sales = await readSales(member.workspace)
  const marker = `Rate locked by payout ${prev.id}`
  const unlock: Sale[] = []
  for (const s of sales) {
    const ids = new Set(prev.settled.filter((x) => x.saleId === s.id).map((x) => x.paymentId))
    if (ids.size === 0) continue
    unlock.push({
      ...s,
      payments: s.payments.map((p) => ids.has(p.id)
        ? { ...p, rate: null, note: p.note.split(' · ').filter((t) => !t.startsWith(marker)).join(' · ') }
        : p),
      updatedAt: at, updatedBy: member.email,
    })
  }
  const results = await Promise.all(unlock.map(writeSale))
  return NextResponse.json({ ok: true, unlockedPayments: prev.settled.length, unlockFailed: results.filter(Boolean).length })
}
