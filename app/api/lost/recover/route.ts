import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite, HARDCODED_ACCOUNTS, type Member } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { isOwnLeadsOnly, isOwnedBy } from '@/lib/ownleads'
import { applyStageChange } from '@/lib/stagechange'
import { setAssignment } from '@/lib/assignment'
import { currentStateForIds } from '@/lib/leadstate'
import { CRM_NOTE_ROLE, CRM_STAGE_LABEL, type CrmStage, type CrmNoteEntry } from '@/lib/crm'
import { RECOVER_STAGES } from '@/lib/lostreasons'
import { memberDisplayName } from '@/lib/membername'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// "Recover" on the Lost page: back to a live stage, handed to an agent, with a
// note on the timeline saying who did it.
//
// Every write goes through the existing helpers — the stage through
// applyStageChange (lib/stagechange.ts, the ONE place a stage is written), the
// owner through setAssignment — so a recovered lead is indistinguishable from
// one moved and assigned by hand on its record.
//
// Body: { ids: string[] (the card's id + merged ids, ≤ 10), stage, assignee, dryRun? }
// Each id is decided on its own (guardLeadAccess: site, own-leads-only), and
// only ids whose CURRENT stage is Lost are moved. `dryRun: true` reports the
// exact writes it would make and makes none.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'lost')) {
    return NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const ids: string[] = Array.from(new Set<string>((Array.isArray(body.ids) ? body.ids : []).filter((x: unknown): x is string => typeof x === 'string' && !!x))).slice(0, 10)
  const stage = body.stage as CrmStage
  const assignee = typeof body.assignee === 'string' ? body.assignee.trim().toLowerCase() : ''
  const dryRun = body.dryRun === true
  if (ids.length === 0) return NextResponse.json({ error: 'Nothing selected' }, { status: 400 })
  if (!(RECOVER_STAGES as readonly string[]).includes(stage)) return NextResponse.json({ error: 'Pick a live stage to move it back to.' }, { status: 400 })
  if (!assignee) return NextResponse.json({ error: 'Pick who should work it.' }, { status: 400 })
  // An own-leads-only member may only take it back themselves.
  if (isOwnLeadsOnly(member) && !isOwnedBy(member, assignee)) {
    return NextResponse.json({ error: 'On this account a recovered lead can only be assigned to you.' }, { status: 403 })
  }

  // The assignee must be a real member of this workspace (checked per site below).
  let candidate: Member | null = null
  const builtin = HARDCODED_ACCOUNTS.find((a) => a.email === assignee && a.workspace === member.workspace)
  if (builtin) candidate = { id: '', email: builtin.email, workspace: member.workspace, role: 'admin', assigned_sites: [] }
  else {
    const { data } = await supabase.from('members').select('email, role, assigned_sites').eq('workspace', member.workspace).ilike('email', assignee).maybeSingle()
    if (data) candidate = { id: '', email: String(data.email).toLowerCase(), workspace: member.workspace, role: data.role, assigned_sites: data.assigned_sites ?? [] }
  }
  if (!candidate) return NextResponse.json({ error: `${assignee} is not a member of this workspace.` }, { status: 400 })

  const states = await currentStateForIds(ids)
  const byName = await memberDisplayName(member.email)
  const toName = await memberDisplayName(candidate.email)
  const recovered: string[] = []
  const skipped: { id: string; why: string }[] = []
  const planned: { id: string; siteId: string; stage: CrmStage; previous: CrmStage; assignee: string; note: string }[] = []

  for (const id of ids) {
    const access = await guardLeadAccess(member, id, 'records')
    if (!access.ok) { skipped.push({ id, why: 'not allowed' }); continue }
    const cur = states.get(id)?.stage
    if (cur !== 'lost') { skipped.push({ id, why: `not Lost (it is ${cur ? CRM_STAGE_LABEL[cur] : 'unknown'})` }); continue }
    if (!canAccessSite(candidate, access.siteId)) { skipped.push({ id, why: `${candidate.email} does not work this site` }); continue }
    const note = `Recovered from Lost by ${byName} — moved to ${CRM_STAGE_LABEL[stage]}, assigned to ${toName}.`
    planned.push({ id, siteId: access.siteId, stage, previous: 'lost', assignee: candidate.email, note })
  }

  if (dryRun) return NextResponse.json({ ok: true, dryRun: true, wouldRecover: planned, skipped })

  const failed: { id: string; why: string }[] = []
  for (const p of planned) {
    const res = await applyStageChange({ leadId: p.id, siteId: p.siteId, stage: p.stage, previous: p.previous, actorEmail: member.email })
    if (!res.ok) { failed.push({ id: p.id, why: res.error ?? 'stage not saved' }); continue }
    await setAssignment(p.id, p.siteId, p.assignee)
    const entry: CrmNoteEntry = {
      id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      body: p.note, author: member.email, at: new Date().toISOString(),
    }
    await writeControlRow({ sessionId: p.id, siteId: p.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(entry) })
    recovered.push(p.id)
  }
  return NextResponse.json({ ok: failed.length === 0, recovered, skipped, failed })
}
