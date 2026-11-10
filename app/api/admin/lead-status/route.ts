import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'
import { ownsSession } from '@/lib/ownleads'
import { LEAD_STATUS_ROLE, isLeadStatus } from '@/lib/leadstatus'

// Set a lead's pipeline status (new/contacted/quoted/won/lost) — appended as a
// chat_logs control row; the latest row per session wins.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sessionId, siteId, status } = await req.json()
  if (!sessionId || !siteId || !isLeadStatus(status)) {
    return NextResponse.json({ error: 'Missing or invalid fields' }, { status: 400 })
  }
  // Own-leads-only (lib/ownleads.ts): only a chat already assigned to him —
  // he cannot claim the queue or a colleague's chat.
  if (!canAccessSite(member, siteId) || !(await ownsSession(member, sessionId))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error } = await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: LEAD_STATUS_ROLE,
    message: JSON.stringify({ status, by: member.email, at: new Date().toISOString() }),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
