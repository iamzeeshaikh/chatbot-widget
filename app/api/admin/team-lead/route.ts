import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { teamLeads, setTeamLead } from '@/lib/teamlead'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// Who on this team may see every lead, without being an admin.
//
// ADMIN ONLY to change, deliberately: this decides who reads other people's
// customers. GET is open to any signed-in member so the Members page can show
// the badge, and it returns nothing but a list of emails already visible there.

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const leads = await teamLeads()
  // Scoped to this workspace's own members — an email from the other business
  // is not this dashboard's business to name.
  const { data } = await supabase.from('members').select('email').eq('workspace', member.workspace)
  const mine = new Set((data ?? []).map((m) => String(m.email).trim().toLowerCase()))
  return NextResponse.json({ leads: Array.from(leads).filter((e) => mine.has(e)) })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (member.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin can set a team lead.' }, { status: 403 })
  }
  const body = await req.json().catch(() => ({}))
  const email = String(body.email ?? '').trim().toLowerCase()
  const lead = body.lead !== false
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })

  // The target has to be a member of THIS workspace. Without the check an admin
  // could hand the other business's leads to somebody by typing an address.
  const { data } = await supabase.from('members')
    .select('email').eq('workspace', member.workspace).ilike('email', email).maybeSingle()
  if (!data) return NextResponse.json({ error: 'That is not a member of this workspace.' }, { status: 404 })

  await setTeamLead(email, lead, member.email)
  return NextResponse.json({ ok: true, email, lead })
}
