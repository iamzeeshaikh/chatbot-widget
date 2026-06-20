// Agent-reply authorship — recorded WITHOUT any schema change (no DDL access).
//
// Each agent reply is a chat_logs row with role 'admin'. To know WHICH member
// sent it, we write a companion control row alongside it:
//   role = REPLY_AUTHOR_ROLE, message = JSON { id, email }, and — crucially — the
//   SAME created_at as the admin reply it describes. chat_logs.created_at can be
//   set explicitly on insert (see scripts/backfill-leads.mjs), so the two rows
//   pair up exactly by (session_id, created_at).
//
// This lets the Performance dashboard attribute each reply to the member who
// sent it. Replies made BEFORE this tracking existed have no author row and stay
// unattributed (a historical gap) — everything going forward is exact.

import { supabase } from './supabase'
import type { Member } from './auth'

export const REPLY_AUTHOR_ROLE = 'reply_author'

// The response-time SLA: a visitor message must get an agent reply within this
// window or the conversation counts as slow/missed. Same 2-minute threshold the
// widget uses for its safety-net lead form (SAFETY_NET_DELAY_MS in widget.js).
export const RESPONSE_SLA_MS = 2 * 60 * 1000

// Outlier cap for the AVERAGE response-time metric. A reply that lands more than
// this long after the visitor's message isn't a "response" any more — it's a
// next-day / overnight re-engagement, and including it badly skews the average
// (one ~19h reply alone dragged the packaging workspace avg from ~13m to 1h40m).
// Pairs beyond the cap are EXCLUDED from the average only — they still count as
// slow/missed where applicable. Negative diffs (reply before message, i.e. a
// corrupt/naive-shifted timestamp) are always dropped, never averaged.
export const RESPONSE_OUTLIER_CAP_MS = 8 * 60 * 60 * 1000 // 8 hours

export interface ReplyAuthor {
  id: string
  email: string
}

export function parseReplyAuthor(message: string | null | undefined): ReplyAuthor | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && typeof o.id === 'string') {
      return { id: o.id, email: typeof o.email === 'string' ? o.email : '' }
    }
  } catch { /* not an author row */ }
  return null
}

// Record who sent an agent reply, pairing to the reply row by an identical
// created_at. Best-effort: never throws (must not break sending a reply). Pass
// the SAME `at` string used as the admin reply's created_at.
export async function recordReplyAuthor(
  sessionId: string,
  siteId: string,
  member: Member,
  at: string,
): Promise<void> {
  try {
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: REPLY_AUTHOR_ROLE,
      message: JSON.stringify({ id: member.id, email: member.email }),
      created_at: at,
    })
  } catch (err) {
    console.error('[replyauthor] recordReplyAuthor failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}
