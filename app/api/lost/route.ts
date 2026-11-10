import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite, HARDCODED_ACCOUNTS } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { isOwnLeadsOnly } from '@/lib/ownleads'
import { loadLost } from '@/lib/lost'
import { supabase } from '@/lib/supabase'
import { storedMemberNames } from '@/lib/membername'
import { agentDisplayName } from '@/lib/agentname'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The Lost page's data (lib/lost.ts). Packaging only. Who sees which lead is
// decided inside loadLost by the same rules as the board, so an own-leads-only
// member gets only their own Lost leads.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'lost')) {
    return NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 })
  }
  const sp = req.nextUrl.searchParams
  try {
    const result = await loadLost(member, {
      siteId: sp.get('site') || undefined,
      owner: sp.get('owner') || undefined,
      reason: sp.get('reason') || undefined,
      age: sp.get('age') || undefined,
      days: Number(sp.get('days')) || undefined,
    })
    // Who a recovered lead can be handed to. An own-leads-only member can only
    // take it back themselves (handing it on would be reaching a colleague's
    // pool); everyone else picks any member of the workspace — the recover
    // route re-checks that member can reach the lead's site.
    const names = await storedMemberNames()
    let agents: { email: string; name: string; sites: string[] | null }[]
    if (isOwnLeadsOnly(member)) {
      agents = [{ email: member.email, name: names.get(member.email.toLowerCase()) || agentDisplayName(member.email), sites: null }]
    } else {
      const { data } = await supabase.from('members').select('id, email, role, assigned_sites').eq('workspace', member.workspace)
      agents = (data ?? []).map((m) => ({
        email: String(m.email).toLowerCase(),
        name: names.get(String(m.email).toLowerCase()) || agentDisplayName(m.email),
        // null = every site; otherwise the sites they can be handed a lead on
        sites: m.role === 'admin' || !(m.assigned_sites ?? []).length ? null
          : (m.assigned_sites as string[]).filter((s) => canAccessSite({ id: String(m.id), email: m.email, workspace: member.workspace, role: 'standard', assigned_sites: m.assigned_sites }, s)),
      }))
      for (const a of HARDCODED_ACCOUNTS) if (a.workspace === member.workspace && !agents.some((x) => x.email === a.email)) agents.push({ email: a.email, name: agentDisplayName(a.email), sites: null })
      agents.sort((a, b) => a.name.localeCompare(b.name))
    }
    return NextResponse.json({ ...result, me: member.email, ownLeadsOnly: isOwnLeadsOnly(member), agents })
  } catch (err) {
    console.error('[lost] load failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to load Lost leads' }, { status: 500 })
  }
}
