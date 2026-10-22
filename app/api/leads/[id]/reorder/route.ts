import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, loadLeadRecord, writeControlRow } from '@/lib/leadrecord'
import { setAssignment } from '@/lib/assignment'
import { CRM_NOTE_ROLE } from '@/lib/crm'
import { CRM_BOT_ROLE } from '@/lib/quotebot'
import { REORDER_TAG, quoteSessionId } from '@/lib/quoteintake'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// A repeat order from an existing customer, opened from their old record
// (Saifullah, 2026-10-22). It becomes its own lead — same site, same contact,
// tagged [Reorder] — so it shows on the board and in Opportunities as a new
// deal instead of vanishing into the old won card. The person who opens it
// owns it; the quote bot is told to leave it alone; both records note the link.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'pipeline')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const record = await loadLeadRecord(access.member, id)
  if (!record) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const details = String(body.details ?? '').trim().slice(0, 4000)
  if (!details) return NextResponse.json({ error: 'Write what they are reordering.' }, { status: 400 })

  const c = record.contact
  const message = `${REORDER_TAG}Reorder from ${c.name || c.email || 'an existing customer'} (previous record: ${id})\n\n${details}`
  const { data: row, error } = await supabase.from('leads').insert({
    site_id: record.siteId, name: c.name || null, email: c.email || null, phone: c.phone || null,
    message, product: details.slice(0, 120),
  }).select('id').single()
  if (error || !row) return NextResponse.json({ error: 'Could not create the reorder' }, { status: 500 })
  const newId = quoteSessionId(row.id)
  const at = new Date().toISOString()
  const by = access.member.email

  await setAssignment(newId, record.siteId, (typeof body.owner === 'string' && body.owner) || record.owner || by)
  // The bot never writes first on a reorder: the agent already knows them.
  await writeControlRow({ sessionId: newId, siteId: record.siteId, role: CRM_BOT_ROLE,
    message: JSON.stringify({ step: 'first', state: 'skipped', at, why: 'reorder opened by an agent' }) })
  const note = (body: string) => JSON.stringify({ id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, body, author: by, at })
  await writeControlRow({ sessionId: newId, siteId: record.siteId, role: CRM_NOTE_ROLE, message: note(`Reorder — previous record: /leads/${id}`) })
  await writeControlRow({ sessionId: id, siteId: record.siteId, role: CRM_NOTE_ROLE, message: note(`Reorder opened: /leads/${newId} — ${details.slice(0, 200)}`) })
  return NextResponse.json({ ok: true, id: newId })
}
