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

// A completed WooCommerce checkout arriving in the same labeled inbox. It is a
// real lead worth having on record and in the Overview counts, but it is NOT a
// lead the buying partner sourced, so it must never reach the Billing tab —
// which it can't, because Billing only ever queries for QUOTE_TAG.
export const CHECKOUT_TAG = '[Checkout] '

export function isQuoteLeadMessage(message: string | null | undefined): boolean {
  return !!message && message.startsWith(QUOTE_TAG)
}

export function isCheckoutLeadMessage(message: string | null | undefined): boolean {
  return !!message && message.startsWith(CHECKOUT_TAG)
}

// Where a lead came from, for the badge in the leads table and the type filter.
export type LeadSource = 'quote' | 'checkout' | 'chat'

export function leadSource(message: string | null | undefined): LeadSource {
  if (isQuoteLeadMessage(message)) return 'quote'
  if (isCheckoutLeadMessage(message)) return 'checkout'
  return 'chat'
}

export function stripQuoteTag(message: string | null | undefined): string {
  if (!message) return ''
  if (isQuoteLeadMessage(message)) return message.slice(QUOTE_TAG.length)
  if (isCheckoutLeadMessage(message)) return message.slice(CHECKOUT_TAG.length)
  return message
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
  PB: 'peptidesboxes',
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
const SPAM_SIGNATURE_RE = /\[url=|\[\/url\]|Yo investors|trading bot|crypto[- ]?(coin|trading)s?\b|payday loan|AI-based strateg|Just stumbled on|essay writing service|\bbacklink|guest post|SEO service|online casino|forex signals|\bjackpot\b|no rx\b|prescription without doctor|stop to opt-?out|reply stop|text stop|attendees list|complimentary (bid|quote|audit)|unsubscribe here|no longer wish to receive|live within 24 hours|drive (more )?traffic|directly in front of people|boost your (rankings|traffic|sales)|increase your (traffic|leads|sales)|grow your business online|first page of google|rank higher on google/i

// The same bot network generates a fake "phone number" as a single literal
// digit 8 followed by exactly 10 more digits (e.g. "86717731828") — seen
// across ~40 spam submissions with zero exceptions, while every real lead's
// phone is either a normal 10-digit US number or has a country-code prefix
// (0, +, etc.). Distinct from the content check above since some of these
// submissions carry no promotional text at all (empty or foreign-language
// filler), so the phone shape is often the only signal available.
const BOT_PHONE_RE = /^8\d{10}$/

// A completed WooCommerce checkout ("New order #6449 — You've received the
// following order...") is a real sale placed through the cart, not a quote
// request. It still gets recorded as a lead and shows a Checkout badge, but it
// carries CHECKOUT_TAG instead of QUOTE_TAG so it stays out of Billing.
//
// The colon after "order" is optional: the subject line these arrive under is
// "[Shop Cardboard Boxes]: New order #6449", while the body header uses
// "New Order: #6449".
const WOOCOMMERCE_ORDER_RE = /New order:?\s*#|Built with WooCommerce|You[’']ve received the following order/i

export function isCheckoutOrder(bodyText: string): boolean {
  return WOOCOMMERCE_ORDER_RE.test(bodyText)
}

// WooCommerce's order number, which is the only stable identity a checkout mail
// has. The generic body-text dedupe can't recognise the same order twice: when
// the SAME notification is also forwarded into the mailbox, the forward carries
// the store name in a "From:" header while the direct copy has it as the first
// body line, so the two normalise to different text and both get inserted.
// (Seen for real: orders #6453–#6457 each landed twice, doubling the count.)
// Matching on the order number instead makes a re-send — forwarded, re-labeled,
// or re-processed — collapse onto the original every time.
const ORDER_NUMBER_RE = /New Order:?\s*#(\d+)/i

export function checkoutOrderNumber(bodyText: string): string | null {
  const m = bodyText.match(ORDER_NUMBER_RE)
  return m ? m[1] : null
}

// The telecom industry reserves 555-0100 through 555-0199 for fiction/testing
// — a real customer's phone can never fall in this block, so a submission
// carrying one (e.g. "416-555-0142") is someone testing the form, not a lead.
const TEST_PHONE_RE = /^\d{3}555\d{4}$/

// WooCommerce orders are deliberately NOT treated as spam any more — they are
// ingested as checkout leads instead (see isCheckoutOrder above).
export function isLikelySpamQuote(bodyText: string, phone?: string | null): boolean {
  const cleanPhone = phone?.trim()
  if (cleanPhone && (BOT_PHONE_RE.test(cleanPhone) || TEST_PHONE_RE.test(cleanPhone))) return true
  return SPAM_SIGNATURE_RE.test(bodyText)
}

// Strip the QUOTE_TAG, any forwarded-message header block, and the
// auto-appended "---" footer (Date/Time/Page URL/User Agent/etc.) — what's
// left is only what the visitor actually typed, used to recognize the same
// submission arriving twice (e.g. once directly, once as a forward days or
// weeks later) regardless of how far apart in time they land.
const HEADER_LINE_RE = /^(From|To|Cc|Bcc|Date|Subject|Sent):/i
const FWD_MARKER_RE = /^-+\s*Forwarded message\s*-+$/i

export function normalizeQuoteBody(raw: string): string {
  const body = stripQuoteTag(raw)
  const out: string[] = []
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '---') break
    if (!line || HEADER_LINE_RE.test(line) || FWD_MARKER_RE.test(line)) continue
    out.push(line.toLowerCase())
  }
  return out.join(' ')
}

// Two normalized bodies are the same submission when one is a prefix of the
// other. An exact === comparison misses the commonest real case: the Apps
// Script caps `message` at 2000 characters, and a forwarded copy spends part of
// that budget on its From/Date/Subject/To block, so the forward's actual
// content gets truncated EARLIER than the original's. Stripping the headers
// afterwards leaves two strings that agree perfectly and then simply stop at
// different points (seen live: 1999 vs 1822 characters, identical throughout).
//
// The length floor keeps this from collapsing genuinely different short
// enquiries — "hi, need a quote" is a plausible prefix of half the inbox.
const MIN_PREFIX_MATCH = 120

export function isSameQuoteBody(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  if (shorter.length < MIN_PREFIX_MATCH) return false
  return longer.startsWith(shorter)
}

export function quoteSessionId(leadId: string): string {
  return `quote-${leadId}`
}

export function isQuoteSessionId(sessionId: string | null | undefined): boolean {
  return !!sessionId && sessionId.startsWith('quote-')
}
