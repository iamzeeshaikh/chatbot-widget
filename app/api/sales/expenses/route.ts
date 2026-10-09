import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { suggestedRates } from '@/lib/sales'
import { readExpenses, writeExpense } from '@/lib/expenses'
import { canUseSales, cleanExpense, expensePkr } from '@/lib/salescore'

export const dynamic = 'force-dynamic'

// Expenses — admins only, own workspace only, like the sales ledger.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })
  const [expenses, rateInfo] = await Promise.all([readExpenses(member.workspace), suggestedRates()])
  const rates = rateInfo?.rates ?? null
  return NextResponse.json({ expenses: expenses.map((e) => ({ ...e, pkr: expensePkr(e, rates) })) })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const raw = (body?.expense ?? {}) as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  let prev = null
  if (id) {
    prev = (await readExpenses(member.workspace)).find((e) => e.id === id) ?? null
    if (!prev) return NextResponse.json({ error: 'That expense is not in this workspace.' }, { status: 404 })
  }
  const cleaned = cleanExpense(raw, prev, member.email, member.workspace)
  if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 })
  const failed = await writeExpense(cleaned.expense)
  if (failed) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })
  const rates = (await suggestedRates())?.rates ?? null
  return NextResponse.json({ ok: true, expense: { ...cleaned.expense, pkr: expensePkr(cleaned.expense, rates) } })
}

export async function DELETE(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })
  const id = req.nextUrl.searchParams.get('id') ?? ''
  const prev = id ? (await readExpenses(member.workspace)).find((e) => e.id === id) : null
  if (!prev) return NextResponse.json({ error: 'That expense is not in this workspace.' }, { status: 404 })
  const failed = await writeExpense({ ...prev, deleted: true, updatedAt: new Date().toISOString(), updatedBy: member.email })
  if (failed) return NextResponse.json({ error: 'That did not delete.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
