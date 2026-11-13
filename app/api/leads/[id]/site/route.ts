import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { CRM_NOTE_ROLE } from '@/lib/crm'
import { isQuoteSessionId } from '@/lib/quoteintake'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// Move a form or phone lead to the site it really belongs to.
//
// A call on the shared number is filed on the workspace's first site as a
// placeholder ("Site not identified … please set the right one", lib/inbound.ts),
// and until now nothing could set it: the record, the signature and the logo
// all said Shop Cardboard Boxes for a The Custom Folders caller (Saifullah,
// 2026-11-13). The lead row AND every chat_logs row of the session move together,
// because routes read the site from either (resolveLeadSite, the bot drafts).
// Chat leads are refused: they came from one widget, so their site is a fact.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  if (!isQuoteSessionId(id)) {
    return NextResponse.json({ error: 'A chat lead stays on the site its chat came from.' }, { status: 400 })
  }
  const body = await req.json().catch(() => ({}))
  const target = String(body.siteId ?? '').trim()
  if (!target) return NextResponse.json({ error: 'Pick a site.' }, { status: 400 })
  if (target === access.siteId) return NextResponse.json({ ok: true, siteId: target })
  if (!memberSites(access.member).includes(target)) {
    return NextResponse.json({ error: 'You do not work that site.' }, { status: 403 })
  }

  const { error: e1 } = await supabase.from('leads').update({ site_id: target }).eq('id', id.slice('quote-'.length))
  if (e1) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })
  const { error: e2 } = await supabase.from('chat_logs').update({ site_id: target }).eq('session_id', id)
  if (e2) {
    // Put the lead row back so the two never disagree.
    await supabase.from('leads').update({ site_id: access.siteId }).eq('id', id.slice('quote-'.length))
    return NextResponse.json({ error: 'That did not save.' }, { status: 500 })
  }
  await writeControlRow({
    sessionId: id, siteId: target, role: CRM_NOTE_ROLE,
    message: JSON.stringify({ id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, body: `Site changed from ${access.siteId} to ${target}.`, author: access.member.email, at: new Date().toISOString() }),
  })
  return NextResponse.json({ ok: true, siteId: target })
}
