// The quote bot's customer emails, held for a person to send.
//
// Owner, 2026-10-22: "bot bahut ghalat jawab de raha hai — pehla reply publish
// na ho, draft ho jaye, sales agent khud dekhe aur bheje." Packaging only.
// So the bot still reads the enquiry, writes the email and assigns the lead,
// but the email is parked as a crm_bot_draft row on the lead. The agent sees
// it at the top of the record, edits it if they like, and presses Send — the
// mail then goes exactly as the bot would have sent it (the agent's own
// mailbox, the site's address, signature, open pixel) and the bot's ledger
// gets its "sent" row, so follow-ups carry on as before. Discard writes a
// "skipped" ledger row and the bot never writes that customer again.
//
// Revisions, like tasks: the newest row for a draft id wins (pending → sent /
// discarded), so nothing is ever deleted.
export const CRM_BOT_DRAFT_ROLE = 'crm_bot_draft'

export interface BotDraft {
  id: string
  step: 'first' | 'reply'
  status: 'pending' | 'sent' | 'discarded'
  agent: string          // whose mailbox it goes from (the lead's agent)
  from: string           // the site's send-as address
  to: string
  subject: string
  text: string           // body without the signature (added at send time)
  complete: boolean
  missing: string[]
  /** step 'reply': the customer email (Gmail id) it answers; threads under it. */
  inboundId?: string
  /** step 'first' for a chat lead: its chat session, which is also moved on send. */
  chatSessionId?: string
  at: string
  /** Who sent or discarded it, and when. */
  by?: string
  decidedAt?: string
  sentEmailId?: string
  why?: string
}

export function newDraftId(): string {
  return `bd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function parseBotDraft(message: string | null | undefined): BotDraft | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && typeof o.id === 'string' && typeof o.text === 'string' && typeof o.status === 'string' ? (o as BotDraft) : null
  } catch { return null }
}

/** Newest revision of each draft, in order of creation. */
export function foldDrafts(rows: { role: string; message: string }[]): BotDraft[] {
  const byId = new Map<string, BotDraft>()
  for (const r of rows) {
    if (r.role !== CRM_BOT_DRAFT_ROLE) continue
    const d = parseBotDraft(r.message)
    if (d) byId.set(d.id, d)
  }
  return [...byId.values()]
}
