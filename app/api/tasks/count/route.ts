import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { loadMemberTasks } from '@/lib/taskquery'
import { needsAttentionCount } from '@/lib/tasks'
import { unreadRepliesFor } from '@/lib/unread'
import { waWaitingSessions } from '@/lib/wawaiting'
import { memberSites } from '@/lib/auth'
import { canSeeContacts, scrubText, HIDDEN_EMAIL } from '@/lib/pii'

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

  // Unread replies and waiting WhatsApp messages ride on this same 60s poll
  // rather than adding a second and third one.
  //
  // WhatsApp needs to be here because a customer's message lands on the record
  // and NOWHERE ELSE — no conversation row, no email, nothing the dashboard was
  // already watching. An agent only found out by opening leads at random, which
  // is how a real enquiry sat unanswered for an hour on 1 Sep. The badge alone
  // was not enough either: the dashboard has to make a NOISE.
  const [tasks, unread, waiting] = await Promise.all([
    loadMemberTasks(member),
    unreadRepliesFor(member),
    hasFeature(member.workspace, 'telephony')
      ? waWaitingSessions(await memberSites(member))
      : Promise.resolve(new Set<string>()),
  ])
  const mine = tasks.filter((t) => t.assignee === member.email)
  return NextResponse.json({
    count: needsAttentionCount(mine),
    overdue: mine.filter((t) => t.status === 'open' && t.bucket === 'overdue').length,
    today: mine.filter((t) => t.status === 'open' && t.bucket === 'today').length,
    unreadReplies: unread.reduce((n, u) => n + u.count, 0),
    // How many customers are waiting on a WhatsApp reply right now. A COUNT,
    // not a list: the dashboard only has to know that it went up.
    waWaiting: waiting.size,
    // The card names the customer and previews what they wrote — both can
    // carry an address. `from` falls back to the raw address whenever the
    // sender has no display name set, which is most one-person senders, so
    // masking only the preview would have leaked on exactly those.
    unreadLeads: canSeeContacts(member)
      ? unread.slice(0, 10)
      : unread.slice(0, 10).map((u) => ({
          ...u,
          from: u.from.includes('@') ? HIDDEN_EMAIL : u.from,
          subject: scrubText(u.subject) ?? '',
          snippet: scrubText(u.snippet) ?? '',
        })),
  })
}
