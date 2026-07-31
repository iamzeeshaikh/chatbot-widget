import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { loadMemberTasks, groupTasks, applyFilters } from '@/lib/taskquery'
import { isTaskType, type TaskType } from '@/lib/tasks'

export const dynamic = 'force-dynamic'

// The global task queue behind /tasks.
//
// Site scope is applied inside loadMemberTasks(), in the query itself — a
// member physically cannot receive a task belonging to a site they are not
// assigned to, whatever they put in the filters. The `site` filter can only
// ever NARROW that set.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const rawAssignee = sp.get('assignee') ?? 'me'
  const rawSite = sp.get('site') ?? ''
  const rawType = sp.get('type') ?? 'all'

  // 'me' is resolved here rather than sent by the client, so the default view
  // is always genuinely this member's queue.
  const assignee = rawAssignee === 'me' ? member.email : rawAssignee === 'all' ? '' : rawAssignee
  const type: TaskType | 'all' = isTaskType(rawType) ? rawType : 'all'

  const allowed = memberSites(member)
  // A site filter naming a site outside scope is ignored rather than honoured,
  // so it can never widen the result set.
  const siteId = rawSite && allowed.includes(rawSite) ? rawSite : ''

  const all = await loadMemberTasks(member)
  const filtered = applyFilters(all, { assignee, siteId, type })

  // Filter options come from the tasks the member can actually see, so the
  // dropdowns never advertise a site or colleague outside their scope.
  const sites = Array.from(new Set(all.map((t) => t.siteId)))
    .map((id) => ({ siteId: id, name: all.find((t) => t.siteId === id)?.siteName ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const assignees = Array.from(new Set(all.map((t) => t.assignee).filter(Boolean))).sort()

  return NextResponse.json({
    groups: groupTasks(filtered),
    total: filtered.length,
    me: member.email,
    filters: { assignee: rawAssignee, site: siteId, type },
    options: { sites, assignees, members: await assignableMembers(member, allowed) },
  })
}

// Everyone in the workspace who can see at least one of this member's sites —
// the set a task may be reassigned to from the global view.
async function assignableMembers(
  member: { workspace: string; email: string },
  allowed: string[],
): Promise<string[]> {
  const { data } = await supabase
    .from('members')
    .select('email, role, assigned_sites')
    .eq('workspace', member.workspace)
  const out = new Set<string>([member.email])
  for (const m of data ?? []) {
    if (m.role === 'admin' || (m.assigned_sites ?? []).some((s: string) => allowed.includes(s))) {
      out.add(m.email)
    }
  }
  return Array.from(out).sort()
}
