import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import type { Workspace } from '@/lib/workspaces'
import { readSales, writeSale, suggestedRates, leadFactsFor } from '@/lib/sales'
import {
  STREAMS, STREAM_ORDER, streamsForWorkspace, canUseSales, isSalesOwner, cleanSale,
  figures, totals, type SaleView, type SalesStream,
} from '@/lib/salescore'

export const dynamic = 'force-dynamic'

// The sales ledger.
//
// ADMINS ONLY, and only their own workspace — refused here, not just hidden in
// the nav: order value, production cost and profit are not an agent's to read.
// `?scope=master` is the one read that spans both businesses, and only the
// owner accounts in SALES_OWNERS get it. The master view is read-only: a sale
// is edited from its own workspace's dashboard, so nothing written on one
// domain can land in the other business's ledger.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const owner = isSalesOwner(member)
  const master = req.nextUrl.searchParams.get('scope') === 'master'
  if (master && !owner) return NextResponse.json({ error: 'The master view is for the owner accounts only.' }, { status: 403 })

  const workspaces: Workspace[] = master ? ['packaging', 'sports'] : [member.workspace]
  const [lists, rateInfo, membersRes] = await Promise.all([
    Promise.all(workspaces.map(readSales)),
    suggestedRates(),
    supabase.from('members').select('email').eq('workspace', member.workspace),
  ])
  const suggested = rateInfo?.rates ?? null

  // Which site each sale came from, read from its lead rather than stored on
  // the sale — a lead can be re-filed under the right site later, and the
  // ledger should follow it instead of keeping the old answer.
  const withLead = lists.flat()
  // The same lookup says how the lead arrived: a `quote-` id carries the
  // leads row (quote form, phone call, WhatsApp, checkout — leadSource reads
  // it off the message, as the record page does); a bare session id is a chat.
  const facts = await leadFactsFor(withLead.map((s) => s.leadId))
  const views: SaleView[] = withLead.map((sale) => ({
    sale: {
      ...sale,
      siteId: sale.leadId ? facts.get(sale.leadId)?.siteId ?? null : null,
      leadKind: sale.leadId ? facts.get(sale.leadId)?.kind ?? null : null,
    },
    fig: figures(sale, suggested),
  }))

  const streams: SalesStream[] = master ? STREAM_ORDER : streamsForWorkspace(member.workspace)
  const byStream = Object.fromEntries(
    streams.map((k) => [k, totals(views.filter((v) => v.sale.stream === k), suggested)]),
  )

  return NextResponse.json({
    scope: master ? 'master' : member.workspace,
    workspace: member.workspace,
    owner,
    streams: streams.map((k) => STREAMS[k]),
    sales: views,
    totals: byStream,
    all: totals(views.filter((v) => streams.includes(v.sale.stream)), suggested),
    rates: rateInfo,
    members: (membersRes.data ?? []).map((m) => String(m.email)).sort(),
  })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const raw = (body?.sale ?? {}) as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''

  // An id means an edit, and the sale must already be in THIS workspace's
  // ledger. Without the lookup a browser could name an id and a stream and
  // write a sale into a ledger it was never allowed to read.
  let prev = null
  if (id) {
    prev = (await readSales(member.workspace)).find((s) => s.id === id) ?? null
    if (!prev) return NextResponse.json({ error: 'That sale is not in this workspace.' }, { status: 404 })
  }

  const cleaned = cleanSale(raw, prev, member.email, member.workspace)
  if ('error' in cleaned) return NextResponse.json({ error: cleaned.error }, { status: 400 })

  const failed = await writeSale(cleaned.sale)
  if (failed) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })

  const rates = (await suggestedRates())?.rates ?? null
  return NextResponse.json({ ok: true, sale: cleaned.sale, fig: figures(cleaned.sale, rates) })
}

export async function DELETE(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canUseSales(member)) return NextResponse.json({ error: 'Sales are for admins only.' }, { status: 403 })

  const id = req.nextUrl.searchParams.get('id') ?? ''
  const prev = id ? (await readSales(member.workspace)).find((s) => s.id === id) : null
  if (!prev) return NextResponse.json({ error: 'That sale is not in this workspace.' }, { status: 404 })

  // A further snapshot, not a delete: the ledger keeps what the sale was and
  // who removed it.
  const failed = await writeSale({
    ...prev, deleted: true, updatedAt: new Date().toISOString(), updatedBy: member.email,
  })
  if (failed) return NextResponse.json({ error: 'That did not delete.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
