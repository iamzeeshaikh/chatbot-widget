import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite, HARDCODED_ACCOUNTS, type Member } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { setAssignment } from '@/lib/assignment'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// The record's owner IS the conversation assignee — the same `assignment`
// control row the Conversations view reads and writes. Reusing it (instead of
// inventing a second owner field) is what keeps "who has this chat" and "who
// owns this lead" from drifting apart.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { email } = await req.json().catch(() => ({}))
  const target = typeof email === 'string' ? email.trim().toLowerCase() : ''

  if (!target) {
    await setAssignment(id, access.siteId, null) // unassign
    return NextResponse.json({ ok: true, owner: null })
  }

  // The new owner must be a real member of THIS workspace who can reach this
  // site — otherwise a lead could be parked on someone who can never open it.
  const builtin = HARDCODED_ACCOUNTS.some((a) => a.email === target && a.workspace === access.member.workspace)
  if (!builtin) {
    const { data } = await supabase
      .from('members')
      .select('email, role, assigned_sites')
      .eq('workspace', access.member.workspace)
      .ilike('email', target)
      .maybeSingle()
    // canAccessSite, not a hand-written copy of it. The copy said "admin, or the
    // site is in their list" — and a member with NO sites picked covers the whole
    // workspace (memberSites, lib/auth.ts). Every packaging agent has an empty
    // list, so every one of them was refused as an owner: the dropdown offered
    // them, the server said no, and the UI swallowed the no. A team lead
    // assigning a lead to an agent simply saw nothing happen.
    const candidate: Member | null = data
      ? { id: '', email: data.email, workspace: access.member.workspace, role: data.role, assigned_sites: data.assigned_sites ?? [] }
      : null
    if (!candidate || !canAccessSite(candidate, access.siteId)) {
      return NextResponse.json({ error: `${candidate?.email ?? target} does not work this site, so this lead cannot be assigned to them.` }, { status: 400 })
    }
  }

  await setAssignment(id, access.siteId, target)
  return NextResponse.json({ ok: true, owner: target })
}
