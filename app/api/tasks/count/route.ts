import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { loadMemberTasks } from '@/lib/taskquery'
import { needsAttentionCount } from '@/lib/tasks'
import { unreadRepliesFor } from '@/lib/unread'

export const dynamic = 'force-dynamic'

// The navigation badge: how many of THIS member's open tasks are overdue or
// due today, in Pakistan time.
//
// This is the only task endpoint the dashboard polls, so it stays deliberately
// small — it reuses the same scoped, windowed, capped query as /api/tasks and
// returns a single number. The dashboard polls it every 60s, far slower than
// the visitor/conversation polls, because a due-date badge does not need to be
// second-accurate and chat_logs has no index on `role` (CLAUDE.md §6).
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'tasks')) {
    return NextResponse.json({ error: 'Tasks are not enabled for this workspace' }, { status: 403 })
  }

  // Unread replies ride on this same 60s poll rather than adding a second one.
  const [tasks, unread] = await Promise.all([loadMemberTasks(member), unreadRepliesFor(member)])
  const mine = tasks.filter((t) => t.assignee === member.email)
  return NextResponse.json({
    count: needsAttentionCount(mine),
    overdue: mine.filter((t) => t.status === 'open' && t.bucket === 'overdue').length,
    today: mine.filter((t) => t.status === 'open' && t.bucket === 'today').length,
    unreadReplies: unread.reduce((n, u) => n + u.count, 0),
    unreadLeads: unread.slice(0, 10),
  })
}
