import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { loadMemberTasks } from '@/lib/taskquery'
import { needsAttentionCount } from '@/lib/tasks'

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

  const mine = (await loadMemberTasks(member)).filter((t) => t.assignee === member.email)
  return NextResponse.json({
    count: needsAttentionCount(mine),
    overdue: mine.filter((t) => t.status === 'open' && t.bucket === 'overdue').length,
    today: mine.filter((t) => t.status === 'open' && t.bucket === 'today').length,
  })
}
