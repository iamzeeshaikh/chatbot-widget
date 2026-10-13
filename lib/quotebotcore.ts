// The quote bot's pure half — reading a quote and writing the reply.
//
// No database, no network: everything here takes plain values and returns
// plain values, so scratch/quotebot-core.test.ts can exercise it against real
// lead text without sending anything. lib/quotebot.ts does the I/O.
//
// The wording comes from docs/bot-voice.md, which was learned from 606
// packaging threads our agents wrote. Change the voice THERE first, then here.

export const BOT_ACTOR = 'zeeops-bot'

/** What the model reads out of a quote. Every field is a judgement, not a value. */
export interface QuoteAssessment {
  /** A real customer asking us for custom packaging (not spam, a supplier, a placeholder). */
  isQuote: boolean
  /** ISO 639-1 of the customer's own words. */
  language: string
  firstName: string | null
  /** Plural, lower case: "mailer boxes", "paper cups". */
  product: string
  /** What "style" means for this product: "box style", "cup type", "sticker shape". */
  styleLabel: string
  /** How to ask for this product's size: "box size (length x width x height)", "cup size (8 oz, 12 oz, 16 oz...)". */
  sizeLabel: string
  /** They told us when they need it — so the email does not ask again. */
  hasDeadline: boolean
  hasSize: boolean
  hasStyle: boolean
  hasQuantity: boolean
  /** One line, for the ledger and the person reading it. */
  reason: string
}

export type Missing = 'size' | 'style' | 'quantity'

export function missingOf(a: QuoteAssessment): Missing[] {
  const out: Missing[] = []
  if (!a.hasSize) out.push('size')
  if (!a.hasStyle) out.push('style')
  if (!a.hasQuantity) out.push('quantity')
  return out
}

// ── The model's instructions ────────────────────────────────────────────────
export const ASSESS_SYSTEM = `You read one enquiry that reached a custom packaging company (boxes, cups, sleeves, wax paper, stickers, mailers, trays, inserts and similar) and report, as JSON only, what the customer has told us.

Return exactly this object and nothing else:
{"is_quote": boolean, "language": "en", "first_name": string|null, "product": string, "style_label": string, "size_label": string, "has_size": boolean, "has_style": boolean, "has_quantity": boolean, "has_deadline": boolean, "reason": string}

Rules:
- is_quote: true when a real person shows interest in packaging we make, even with no details at all: a quote form with an empty message, a product page enquiry, "what sizes do you have?", or a chat where they only answered "yes" to the product question. Those are exactly the people we must ask for details. False ONLY for spam, SEO/marketing/data pitches, suppliers or factories selling to us, job seekers, test submissions with random characters, a placeholder with no person behind it ("Site not identified", "I need more info about Thank You"), or a chat where the visitor never said anything.
- language: ISO 639-1 code of the language the CUSTOMER wrote in.
- first_name: the customer's first name, properly capitalised, only if it is clearly a person's name. null for a company name, an email handle, initials or anything unsure.
- product: what they want, plural and lower case, 1 to 4 words, WITHOUT the word "custom" ("mailer boxes", "paper cups", "die cut stickers", "wax paper sheets"). Use the product page name if that is all there is.
- style_label: 2 or 3 lower-case words naming what "style" means for this product: "box style" for boxes, "cup type" for cups, "sleeve style" for sleeves, "sticker shape" for stickers, "paper type" for papers.
- size_label: how to ask THIS product's size, at most 45 characters, lower case: "box size (length x width x height)" for boxes and inserts, "cup size (8 oz, 12 oz, 16 oz...)" for cups, "sleeve size or the cup size it fits" for cup sleeves, "sheet size (width x length)" for papers, "sticker size (width x height)" for stickers, "mailer size (width x length)" for mailers and bags.
- has_size: true when we could work out the finished size: three dimensions for a box (with or without a unit), two for a flat item (paper, sticker, label, sleeve), a cup capacity in oz/ml, or the size of the product that goes inside plus how many go in one box. False for "what sizes do you have", a single number for a box, a weight or volume only for a box, "see attached" with nothing attached, or no size at all.
- has_style: true when the style is clear: a named style (tuck end, mailer, rigid, two-piece, sleeve, pillow, window, gable, display, auto bottom, single/double wall cup, kiss cut, die cut...), a reference image they sent, or a product page name that is itself one specific style ("Pillow Boxes", "Mailer Boxes", "Cardboard Boxes With Lid"). False for a generic "custom boxes" or "packaging" with nothing more.
- has_quantity: true when a number of pieces or a range is given.
- has_deadline: true when they said when they need it (a date, "in 3 weeks", "ASAP", an event date).
- reason: one short English sentence saying what is there and what is missing.
Judge only from what the customer wrote or chose. Never assume a value they did not give.`

/** The model's JSON, made safe. Anything malformed comes back as null — never guessed. */
export function parseAssessment(text: string): QuoteAssessment | null {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  let o: Record<string, unknown>
  try { o = JSON.parse(m[0]) } catch { return null }
  const bool = (v: unknown) => v === true
  if (typeof o.is_quote !== 'boolean') return null
  const product = cleanPhrase(o.product, 40).replace(/^custom\s+/, '') || 'packaging'
  return {
    isQuote: bool(o.is_quote),
    language: typeof o.language === 'string' ? o.language.trim().toLowerCase().slice(0, 5) : 'en',
    firstName: cleanName(o.first_name),
    product,
    styleLabel: cleanPhrase(o.style_label, 24) || 'style',
    sizeLabel: cleanPhrase(o.size_label, 45) || 'size (length x width x height)',
    hasDeadline: bool(o.has_deadline),
    hasSize: bool(o.has_size),
    hasStyle: bool(o.has_style),
    hasQuantity: bool(o.has_quantity),
    reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : '',
  }
}

// A phrase from the model goes into a customer's email, so it is cut down to
// plain words: no markup, no quotes, no sentence it was not asked for.
function cleanPhrase(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = v.toLowerCase().replace(/[^a-z0-9 &'\-/.,()]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? '' : s
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!/^[A-Za-z][A-Za-z'\-]{1,24}$/.test(s)) return null
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

// ── The first email ─────────────────────────────────────────────────────────
export interface FirstEmail { subject: string; text: string; complete: boolean }

/**
 * The bot's first email to a new lead.
 *
 * Complete (size, style and quantity all given) → "the price quote is in
 * process", and a task tells the agent to price it. Anything missing → ask for
 * exactly that, nothing else. Never a price, a total, a date or a promise.
 */
export function buildFirstEmail(a: QuoteAssessment, ctx: { siteName: string; fromChat: boolean }): FirstEmail {
  const missing = missingOf(a)
  const complete = missing.length === 0
  const greet = a.firstName ? `Hello ${a.firstName},` : 'Hello,'
  const thanks = ctx.fromChat
    ? 'Thank you so much for your time over the chat!'
    : 'Thank you so much for reaching out with your request!'
  const product = a.product

  const parts: string[] = [greet, '']
  if (complete) {
    parts.push(
      `${thanks} I have everything I need, and the price quote for your ${product} is in process. I'll share it with you shortly.`,
    )
    if (!a.hasDeadline) parts.push('', 'In the meantime, could you please let me know how soon you need these?')
  } else {
    parts.push(
      `${thanks} We create custom ${product} from scratch, based on the size, style and design you provide.`,
      '',
      askFor(missing, a),
    )
  }
  parts.push('', 'Looking forward to hearing from you.', '', 'Warm regards,')

  return {
    subject: `Custom ${product} - ${ctx.siteName}`.slice(0, 120),
    text: parts.join('\n'),
    complete,
  }
}

// "or the size of the product that goes inside" only where that is how our
// agents size it — a box, an insert, a sleeve around something. Asking a cup
// buyer for the product inside their cup would read as a template.
function sizeAsk(a: QuoteAssessment): string {
  const inside = /box|insert|sleeve|tray|tube|carton/.test(`${a.product} ${a.sizeLabel}`) && !/cup/.test(a.product)
  return `the ${a.sizeLabel}${inside ? ', or the size of the product that goes inside' : ''}`
}

const ASK_LINE: Record<Missing, (a: QuoteAssessment) => string> = {
  size: (a) => cap(sizeAsk(a)),
  style: (a) => `The ${a.styleLabel} you have in mind (a reference image works great)`,
  quantity: () => 'The quantity you need',
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// One thing missing reads as a sentence; two or more as a short list, which is
// how Steve asks and what customers answered most completely.
function askFor(missing: Missing[], a: QuoteAssessment): string {
  if (missing.length === 1) {
    const only = missing[0]
    if (only === 'size') return `Could you please share ${sizeAsk(a)}? I'll work out the final size and price quote from there.`
    if (only === 'style') return `Could you please share the ${a.styleLabel} you have in mind? A reference image works great, and I'll start on the price quote right away.`
    return 'Could you please share the quantity you need? I\'ll start on the price quote right away.'
  }
  return [
    'To prepare an accurate price quote, could you please share:',
    ...missing.map((m) => `• ${ASK_LINE[m](a)}`),
  ].join('\n')
}

/** The text the model reads: the form or chat, with our own boilerplate cut. */
export function quoteTextForAssessment(message: string, name: string | null): string {
  const body = String(message || '')
    .replace(/^\[(Custom Quote|Checkout)\]\s*/, '')
    .replace(/\{"__file":\{[^}]*"name":"([^"]*)"[^}]*\}\}/g, '[customer attached an image: $1]')
    .slice(0, 6000)
  return `Lead name on file: ${name || '(none)'}\n\n${body}`
}
