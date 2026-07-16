// Custom-quote lead intake — leads that arrive as a WordPress contact-form
// email (never touch the chat widget at all) are pulled in via a small, free
// Google Apps Script running inside the user's own Gmail account (see
// scripts/quote-intake-apps-script.gs), which parses each matching email and
// POSTs the fields to /api/quote-intake.
//
// No DDL: quote leads are written into the EXISTING `leads` table (the same
// one the bot's own lead-qualification writes to) — there's no separate
// table or new column. They're told apart from chat-originated rows by
// prefixing `message` with QUOTE_TAG, and given a synthetic "session id" of
// `quote-<lead id>` so the SAME lead_status control-row mechanism used for
// chat leads (lib/leadstatus.ts) also gives quote leads a
// New/Contacted/Quoted/Won/Lost pill in the Billing tab.

export const QUOTE_TAG = '[Custom Quote] '

export function isQuoteLeadMessage(message: string | null | undefined): boolean {
  return !!message && message.startsWith(QUOTE_TAG)
}

export function stripQuoteTag(message: string | null | undefined): string {
  if (!message) return ''
  return isQuoteLeadMessage(message) ? message.slice(QUOTE_TAG.length) : message
}

// Short code (matches the labels/mental-model the user already uses, e.g.
// "SCB" for Shop Cardboard Boxes) -> site_id. Extend as new sites join the
// lead-gen roster; the Apps Script has its own copy of this same map.
export const QUOTE_SITE_CODES: Record<string, string> = {
  SCB: 'shopcardboardboxes',
  TTP: 'thetubepackaging',
  SFB: 'smallfoodboxes',
  ZCB: 'zeecustomboxes',
  TPC: 'thepapercups',
  KBP: 'kraftboxpack',
  TCP: 'thecandlepackaging',
  TBB: 'theburgerboxes',
}

export function siteIdFromQuoteCode(code: string): string | null {
  return QUOTE_SITE_CODES[code.trim().toUpperCase()] ?? null
}

// Bot-spam signatures seen hitting these sites' public WordPress quote-forms
// directly (crypto/loan/casino/SEO promo content, sometimes with literal
// BBCode markup that no real customer would type). Deliberately narrow and
// content-specific — NOT a broad "contains a link" check, since real
// customers legitimately paste reference-image/attachment URLs into these
// forms and those must never be flagged.
const SPAM_SIGNATURE_RE = /\[url=|\[\/url\]|Yo investors|trading bot|crypto[- ]?(coin|trading)s?\b|payday loan|AI-based strateg|Just stumbled on|essay writing service|\bbacklink|guest post|SEO service|online casino|forex signals/i

export function isLikelySpamQuote(bodyText: string): boolean {
  return SPAM_SIGNATURE_RE.test(bodyText)
}

export function quoteSessionId(leadId: string): string {
  return `quote-${leadId}`
}

export function isQuoteSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('quote-')
}
