import { supabase } from './supabase'

// Conversation assignment — which agent has "picked up" a chat — persisted as a
// control row in chat_logs with role 'assignment' (no DDL, same pattern as
// lib/mode.ts). The current assignee is the most recent such row for the
// session: its `message` is the agent's email, or '' when the chat was released
// back to the unassigned pool. This lets every agent see who is handling a chat
// so two agents don't answer the same visitor at once.
export const ASSIGNMENT_ROLE = 'assignment'

// Returns the assignee's email, or null if unassigned / released.
export async function getAssignment(sessionId: string): Promise<string | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('session_id', sessionId)
    .eq('role', ASSIGNMENT_ROLE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const email = data?.message?.trim()
  return email ? email : null
}

// Claim (email) or release (null) a conversation. Writing a new control row —
// last one wins — so history is preserved and no update/delete is needed.
export async function setAssignment(sessionId: string, siteId: string, email: string | null): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: ASSIGNMENT_ROLE,
    message: email ?? '',
  })
}

// Derive each session's current assignee from a batch of chat_logs rows (used by
// the conversations list, which already fetches every log). Rows must be passed
// in ascending created_at order so the last 'assignment' row per session wins.
// A session mapped to '' (released) is omitted, i.e. treated as unassigned.
export function deriveAssignments(logsAscending: { session_id: string; role: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const log of logsAscending) {
    if (log.role !== ASSIGNMENT_ROLE) continue
    const email = (log.message ?? '').trim()
    if (email) out[log.session_id] = email
    else delete out[log.session_id] // released → back to unassigned
  }
  return out
}
