import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { storedMemberNames, setMemberDisplayName, MAX_MEMBER_NAME } from '@/lib/membername'
import { agentDisplayName } from '@/lib/agentname'
import { getMember, revokeSessions, Member } from '@/lib/auth'
import { workspaceSites } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

// Every endpoint here is admin-only and strictly scoped to the caller's own
// workspace — a sports admin can never touch packaging members and vice versa.
async function requireAdmin(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (member.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { admin: member }
}

// Keep only sites that actually belong to the admin's workspace.
function sanitizeSites(admin: Member, sites: unknown): string[] {
  const allowed = new Set(workspaceSites(admin.workspace))
  return Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string' && allowed.has(s)) : []
}

// ── List members (this workspace only) ───────────────────────────────────────
export async function GET(req: NextRequest) {
  const { admin, error } = await requireAdmin(req)
  if (error) return error

  const { data, error: dbErr } = await supabase
    .from('members')
    .select('id, email, workspace, role, assigned_sites, created_at')
    .eq('workspace', admin!.workspace)
    .order('created_at', { ascending: true })

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  // `display_name` is what a CUSTOMER sees when this member answers in the
  // widget. `display_name_source` says whether it was set by hand or derived
  // from the address, so the page can show the derived one as a placeholder
  // rather than pretending somebody chose it.
  const names = await storedMemberNames()
  const members = (data ?? []).map((m) => {
    const set = names.get(String(m.email).toLowerCase())
    return {
      ...m,
      display_name: set ?? agentDisplayName(m.email),
      display_name_source: set ? 'set' : 'derived',
    }
  })
  return NextResponse.json({ members })
}

// ── Add member (into this workspace) ─────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { admin, error } = await requireAdmin(req)
  if (error) return error

  const { email, password, role, assigned_sites } = await req.json()
  if (!email || !password || !['admin', 'standard'].includes(role)) {
    return NextResponse.json({ error: 'email, password and a valid role are required' }, { status: 400 })
  }
  if (password.length < 6) {
    return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
  }

  const sites = role === 'admin' ? [] : sanitizeSites(admin!, assigned_sites)

  const { data: created, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (authErr || !created.user) {
    return NextResponse.json({ error: authErr?.message || 'Could not create user' }, { status: 400 })
  }

  const { error: dbErr } = await supabase.from('members').insert({
    id: created.user.id,
    email,
    workspace: admin!.workspace,
    role,
    assigned_sites: sites,
  })
  if (dbErr) {
    await supabase.auth.admin.deleteUser(created.user.id) // roll back orphaned auth user
    return NextResponse.json({ error: dbErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id: created.user.id })
}

// Confirm the target member exists and lives in the admin's workspace.
async function loadSameWorkspace(admin: Member, id: string) {
  // `email` comes back too: a display name is stored against the member's
  // address (no DDL, so it cannot live on the row itself).
  const { data } = await supabase.from('members').select('id, workspace, email').eq('id', id).maybeSingle()
  if (!data || data.workspace !== admin.workspace) return null
  return data
}

// ── Edit member (role / sites / optional password) ───────────────────────────
export async function PATCH(req: NextRequest) {
  const { admin, error } = await requireAdmin(req)
  if (error) return error

  const { id, role, assigned_sites, password, display_name } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (role && !['admin', 'standard'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }
  if (!(await loadSameWorkspace(admin!, id))) {
    return NextResponse.json({ error: 'Member not found in your workspace' }, { status: 403 })
  }

  const update: Record<string, unknown> = {}
  if (role) update.role = role
  if (assigned_sites !== undefined) {
    update.assigned_sites = role === 'admin' ? [] : sanitizeSites(admin!, assigned_sites)
  }

  if (Object.keys(update).length > 0) {
    const { error: dbErr } = await supabase.from('members').update(update).eq('id', id)
    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  }

  // The widget-facing name. Empty string CLEARS it, falling back to the name
  // derived from the address — that is why undefined and '' mean different
  // things here.
  if (typeof display_name === 'string') {
    const target = await loadSameWorkspace(admin!, id)
    if (!target) return NextResponse.json({ error: 'Member not found in your workspace' }, { status: 403 })
    if (display_name.length > MAX_MEMBER_NAME) {
      return NextResponse.json({ error: `A display name can be at most ${MAX_MEMBER_NAME} characters.` }, { status: 400 })
    }
    const nameErr = await setMemberDisplayName(target.email, display_name, admin!.email)
    if (nameErr) return NextResponse.json({ error: nameErr }, { status: 500 })
  }

  if (password) {
    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
    }
    const { error: pwErr } = await supabase.auth.admin.updateUserById(id, { password })
    if (pwErr) return NextResponse.json({ error: pwErr.message }, { status: 500 })
    // A new password only means something if the old one stops granting access:
    // signed-in browsers keep their week-long cookie otherwise.
    await revokeSessions(id)
  }

  return NextResponse.json({ ok: true })
}

// ── Remove member ────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const { admin, error } = await requireAdmin(req)
  if (error) return error

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (id === admin!.id) {
    return NextResponse.json({ error: 'You cannot remove your own account' }, { status: 400 })
  }
  if (!(await loadSameWorkspace(admin!, id))) {
    return NextResponse.json({ error: 'Member not found in your workspace' }, { status: 403 })
  }

  const { error: authErr } = await supabase.auth.admin.deleteUser(id)
  if (authErr) return NextResponse.json({ error: authErr.message }, { status: 500 })
  await supabase.from('members').delete().eq('id', id)

  return NextResponse.json({ ok: true })
}
