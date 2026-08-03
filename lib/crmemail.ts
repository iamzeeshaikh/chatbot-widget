// Outbound email as a CRM control row — no DDL, same pattern as every other
// piece of lead state.
//
//   crm_email — one row per email actually sent. Written ONLY after Gmail has
//               confirmed the send, so a row existing is proof the mail left.
//
// Registered in CRM_ROLES (lib/crm.ts), which is what keeps it out of the chat
// transcript, the conversation previews, the message counts and the visitor
// widget — one entry, both protections.
//
// ── Shaped for Phase 6 ───────────────────────────────────────────────────────
// Inbound threading is not in this phase, but the row already carries what an
// inbound reply needs to attach to: the Gmail thread id and the RFC Message-ID
// we generated. A reply's In-Reply-To / References header will name that exact
// Message-ID, so a later inbound sync can match on it without guesswork and
// without a migration.

import { parseEmailAttachments, type EmailAttachment } from './emailattach'

export const CRM_EMAIL_ROLE = 'crm_email'

export const MAX_SUBJECT = 300
export const MAX_BODY = 25000
/** How much of the body rides along in the timeline row for the collapsed view. */
export const SNIPPET_LENGTH = 180

export interface CrmEmailEntry {
  /** Our own id for the row. */
  id: string
  /** Who clicked send (the dashboard member), which may differ from `from`. */
  sentBy: string
  /** The verified send-as alias it actually went out from. */
  from: string
  fromName?: string
  to: string
  cc?: string
  subject: string
  /** Full text, kept so the timeline can show the whole thing. */
  body: string
  snippet: string
  at: string
  /** Gmail's own ids, plus the RFC Message-ID — the hooks Phase 6 threads on. */
  gmailId: string
  threadId: string
  messageId: string
  /** Room for inbound replies to be recorded against this send later. */
  direction: 'outbound'
  /** Files sent with it. Paths into the private bucket, signed on read. */
  attachments?: EmailAttachment[]
}

export function parseCrmEmail(message: string | null | undefined): CrmEmailEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.id !== 'string' || !o.id) return null
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return {
      id: o.id,
      sentBy: str(o.sentBy),
      from: str(o.from),
      fromName: typeof o.fromName === 'string' ? o.fromName : undefined,
      to: str(o.to),
      cc: typeof o.cc === 'string' && o.cc ? o.cc : undefined,
      subject: str(o.subject),
      body: str(o.body),
      snippet: str(o.snippet),
      at: str(o.at),
      gmailId: str(o.gmailId),
      threadId: str(o.threadId),
      messageId: str(o.messageId),
      direction: 'outbound',
      attachments: parseEmailAttachments(o.attachments),
    }
  } catch {
    return null
  }
}

export function makeSnippet(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= SNIPPET_LENGTH ? flat : `${flat.slice(0, SNIPPET_LENGTH - 1)}…`
}

export function newEmailId(): string {
  return `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// A permissive single-address check. Deliberately not a full RFC validator —
// the goal is to catch typos and header injection before Gmail sees them, and
// Gmail is the real authority on deliverability.
const ONE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/

export function isAddress(v: string): boolean {
  return ONE.test(v.trim())
}

/** Splits and validates a comma-separated recipient list. */
export function parseAddressList(v: string): { ok: true; list: string[] } | { ok: false; bad: string } {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of parts) if (!isAddress(p)) return { ok: false, bad: p }
  return { ok: true, list: parts }
}
