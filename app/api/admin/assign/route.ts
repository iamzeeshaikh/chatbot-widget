import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { getAssignment, setAssignment } from '@/lib/assignment'

// Claim ("pick up") or release a conversation. The assignee is recorded by
// email so every agent's dashboard can show who is handling the chat. Soft by
// design — this never blocks anyone from replying, it just makes ownership
// visible so two agents don't answer the same visitor at once.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, siteId, action, onlyIfFree } = await req.json()
  if (!sessionId || !siteId || (action !== 'claim' && action !== 'release')) {
    return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 })
  }
  if (!canAccessSite(member, siteId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // onlyIfFree (used by auto-claim-on-open): pick the chat up ONLY if nobody
  // holds it, so merely opening a chat another agent is handling never steals it.
  if (action === 'claim' && onlyIfFree) {
    const current = await getAssignment(sessionId)
    if (current) return NextResponse.json({ assignedTo: current })
    await setAssignment(sessionId, siteId, member.email)
    return NextResponse.json({ assignedTo: member.email })
  }

  if (action === 'release') {
    // Only the current assignee may release it (so one agent can't yank a chat
    // out from under another). If someone else holds it, leave it untouched.
    const current = await getAssignment(sessionId)
    if (current && current !== member.email) {
      return NextResponse.json({ assignedTo: current })
    }
    await setAssignment(sessionId, siteId, null)
    return NextResponse.json({ assignedTo: null })
  }

  // claim — always allowed (an agent can take over a chat another agent left
  // unfinished); the previous assignee simply sees ownership move to this agent.
  await setAssignment(sessionId, siteId, member.email)
  return NextResponse.json({ assignedTo: member.email })
}
