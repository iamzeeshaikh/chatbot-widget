import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { currentStateForIds } from '@/lib/leadstate'
import { CRM_LOST_ROLE, CRM_NOTE_ROLE, type CrmNoteEntry } from '@/lib/crm'
import { isLostReason, lostReasonLabel, MAX_LOST_NOTE, type CrmLostEntry } from '@/lib/lostreasons'

export const dynamic = 'force-dynamic'

// Why a Lost lead was lost (lib/lostreasons.ts). Asked for when a lead is
// moved to Lost on its record, and settable afterwards from the Lost page for
// the leads that never got one. Writes a `crm_lost` row (what /lost reads) and
// a CRM note, so the reason is on the timeline too.
//
// Body: { ids: string[] (≤ 10), reason, note? }. Only leads currently Lost.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'lost')) {
    return NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const ids: string[] = Array.from(new Set<string>((Array.isArray(body.ids) ? body.ids : []).filter((x: unknown): x is string => typeof x === 'string' && !!x))).slice(0, 10)
  if (ids.length === 0) return NextResponse.json({ error: 'Nothing selected' }, { status: 400 })
  if (!isLostReason(body.reason)) return NextResponse.json({ error: 'Pick a reason.' }, { status: 400 })
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_LOST_NOTE) : ''

  const states = await currentStateForIds(ids)
  const at = new Date().toISOString()
  const saved: string[] = []
  const skipped: { id: string; why: string }[] = []
  for (const id of ids) {
    const access = await guardLeadAccess(member, id, 'records')
    if (!access.ok) { skipped.push({ id, why: 'not allowed' }); continue }
    if (states.get(id)?.stage !== 'lost') { skipped.push({ id, why: 'not Lost' }); continue }
    const entry: CrmLostEntry = { reason: body.reason, note, by: member.email, at }
    const { error } = await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_LOST_ROLE, message: JSON.stringify(entry) })
    if (error) { skipped.push({ id, why: error }); continue }
    const n: CrmNoteEntry = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      body: `Lost reason: ${lostReasonLabel(body.reason)}${note ? ` — ${note}` : ''}`,
      author: member.email, at,
    }
    await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(n) })
    saved.push(id)
  }
  return NextResponse.json({ ok: saved.length > 0, saved, skipped })
}
