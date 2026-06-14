import { NextRequest, NextResponse } from 'next/server'
import { createAnonClient, supabase } from '@/lib/supabase'
import { signSession, memberSites, HARDCODED_ACCOUNTS, SESSION_COOKIE, UI_COOKIE, Member } from '@/lib/auth'
import { Workspace } from '@/lib/workspaces'

const WEEK = 60 * 60 * 24 * 7

function setCookies(res: NextResponse, session: string, member: Member) {
  res.cookies.set(SESSION_COOKIE, session, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: WEEK })
  const ui = Buffer.from(JSON.stringify({
    email: member.email,
    role: member.role,
    workspace: member.workspace,
    sites: memberSites(member),
  })).toString('base64')
  res.cookies.set(UI_COOKIE, ui, { httpOnly: false, sameSite: 'lax', path: '/', maxAge: WEEK })
}

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password) {
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
    }

    // 1) Built-in workspace admins (always available, no DB needed).
    const builtin = HARDCODED_ACCOUNTS.find((a) => a.email === email && a.password === password)
    if (builtin) {
      const member: Member = { id: `builtin:${builtin.email}`, email: builtin.email, workspace: builtin.workspace, role: 'admin', assigned_sites: [] }
      const res = NextResponse.json({ ok: true, role: 'admin', workspace: builtin.workspace })
      setCookies(res, signSession({ t: 'h', e: builtin.email }), member)
      return res
    }

    // 2) Supabase-auth members.
    const anon = createAnonClient()
    const { data: auth, error: authErr } = await anon.auth.signInWithPassword({ email, password })
    if (authErr || !auth.user) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    const { data: row } = await supabase
      .from('members')
      .select('id, email, workspace, role, assigned_sites')
      .eq('id', auth.user.id)
      .maybeSingle()
    if (!row) {
      return NextResponse.json({ error: 'No access — ask your dashboard admin to add you.' }, { status: 403 })
    }

    const member: Member = {
      id: row.id,
      email: row.email,
      workspace: row.workspace as Workspace,
      role: row.role,
      assigned_sites: row.assigned_sites ?? [],
    }
    const res = NextResponse.json({ ok: true, role: member.role, workspace: member.workspace })
    setCookies(res, signSession({ t: 'm', uid: member.id }), member)
    return res
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
