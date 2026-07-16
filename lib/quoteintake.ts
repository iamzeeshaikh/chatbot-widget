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
const SPAM_SIGNATURE_RE = /\[url=|\[\/url\]|Yo investors|trading bot|crypto[- ]?(coin|trading)s?\b|payday loan|AI-based strateg|Just stumbled on|essay writing service|\bbacklink|guest post|SEO service|online casino|forex signals|\bjackpot\b|no rx\b|prescription without doctor/i

// The same bot network generates a fake "phone number" as a single literal
// digit 8 followed by exactly 10 more digits (e.g. "86717731828") — seen
// across ~40 spam submissions with zero exceptions, while every real lead's
// phone is either a normal 10-digit US number or has a country-code prefix
// (0, +, etc.). Distinct from the content check above since some of these
// submissions carry no promotional text at all (empty or foreign-language
// filler), so the phone shape is often the only signal available.
const BOT_PHONE_RE = /^8\d{10}$/

// A completed WooCommerce checkout ("New Order: #2013 — You've received the
// following order...") is a real sale, not a quote request — it lands in the
// same inbox/label as quote-request notifications but isn't a lead to bill
// for. The account owner asked for these to never be counted.
const WOOCOMMERCE_ORDER_RE = /New Order:\s*#|Built with WooCommerce|You[’']ve received the following order/i

// The telecom industry reserves 555-0100 through 555-0199 for fiction/testing
// — a real customer's phone can never fall in this block, so a submission
// carrying one (e.g. "416-555-0142") is someone testing the form, not a lead.
const TEST_PHONE_RE = /^\d{3}555\d{4}$/

export function isLikelySpamQuote(bodyText: string, phone?: string | null): boolean {
  const cleanPhone = phone?.trim()
  if (cleanPhone && (BOT_PHONE_RE.test(cleanPhone) || TEST_PHONE_RE.test(cleanPhone))) return true
  return SPAM_SIGNATURE_RE.test(bodyText) || WOOCOMMERCE_ORDER_RE.test(bodyText)
}

// Strip the QUOTE_TAG, any forwarded-message header block, and the
// auto-appended "---" footer (Date/Time/Page URL/User Agent/etc.) — what's
// left is only what the visitor actually typed, used to recognize the same
// submission arriving twice (e.g. once directly, once as a forward days or
// weeks later) regardless of how far apart in time they land.
const HEADER_LINE_RE = /^(From|To|Cc|Bcc|Date|Subject|Sent):/i
const FWD_MARKER_RE = /^-+\s*Forwarded message\s*-+$/i

export function normalizeQuoteBody(raw: string): string {
  let body = raw
  if (body.startsWith(QUOTE_TAG)) body = body.slice(QUOTE_TAG.length)
  const out: string[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '---') break
    if (!line || HEADER_LINE_RE.test(line) || FWD_MARKER_RE.test(line)) continue
    out.push(line.toLowerCase())
  }
  return out.join(' ')
}

export function quoteSessionId(leadId: string): string {
  return `quote-${leadId}`
}

export function isQuoteSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('quote-')
}
