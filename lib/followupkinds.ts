// The kinds of thing that can go out to a customer, and what the Daily
// follow-ups page calls each. Kept apart from lib/followups.ts (server only)
// so the page can import the labels without pulling the database client in.

export type FollowupKind =
  | 'bot_first' | 'bot_followup' | 'bot_quote_fu' | 'bot_promo' | 'bot_reply'
  | 'draft_sent' | 'email' | 'whatsapp' | 'whatsapp_bot' | 'call'

export const FOLLOWUP_KIND_LABEL: Record<FollowupKind, string> = {
  bot_first: 'First reply (bot)',
  bot_followup: 'Follow-up (bot)',
  bot_quote_fu: 'Quote follow-up (bot)',
  bot_promo: 'Promo email (bot)',
  bot_reply: 'Reply (bot)',
  draft_sent: 'Bot draft, sent by agent',
  email: 'Email by hand',
  whatsapp: 'WhatsApp',
  whatsapp_bot: 'WhatsApp (bot)',
  call: 'Call',
}
