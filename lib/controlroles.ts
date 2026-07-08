// Single source of truth for chat_logs "control row" roles.
//
// Several features persist non-message metadata as rows in chat_logs (no DDL):
//   mode, contact, tags, lead_capture, reply_author.
// These must NEVER be shown as chat messages or used as a session preview — their
// `message` is internal JSON. This list previously had to be repeated in every
// place that renders messages; when reply_author was added for the Performance
// dashboard it was missed in some of them, so its raw JSON ({"id":...,"email":...})
// leaked into the conversation view and the session-list preview, looking like the
// bot was replying to the agent. Keep every control role here so that can't recur.

import { MODE_ROLE } from './mode'
import { CONTACT_ROLE, TAGS_ROLE } from './visitor'
import { LEAD_CAPTURE_ROLE } from './leadtracking'
import { REPLY_AUTHOR_ROLE } from './replyauthor'
import { LEAD_STATUS_ROLE } from './leadstatus'

export const CONTROL_ROLES = [
  MODE_ROLE,
  CONTACT_ROLE,
  TAGS_ROLE,
  LEAD_CAPTURE_ROLE,
  REPLY_AUTHOR_ROLE,
  LEAD_STATUS_ROLE,
] as const

const CONTROL_ROLE_SET: ReadonlySet<string> = new Set(CONTROL_ROLES)

// True for any non-message control row that must be hidden from chat views.
export function isControlRole(role: string | null | undefined): boolean {
  return !!role && CONTROL_ROLE_SET.has(role)
}

// Comma-joined for Supabase `.not('role', 'in', `(${CONTROL_ROLES_IN})`)` filters.
export const CONTROL_ROLES_IN = CONTROL_ROLES.join(',')
