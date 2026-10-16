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
  /** A dimension beyond what we normally produce ("50 x 30 x 20 in"), or undefined. The
   *  bot must not promise a price for it; a person checks with production first. */
  oversize?: string
  /** One line, for the ledger and the person reading it. */
  reason: string
}

export type Missing = 'size' | 'style' | 'quantity'

/**
 * What the bot asks for: size and style only. Owner, 2026-10-14: "quantity
 * nahi bh di to chale ga" — with size and style in hand the lead goes to a
 * person to price, exactly as our agents quoted standard quantity tiers.
 */
/**
 * The largest single dimension we quote without asking production first.
 * Shazzy (15 Oct 2026): a customer wrote 50 x 30 x 20 inches, which cannot be
 * made, and the bot still told them the price quote was in process. Boxes,
 * mailers and sleeves all come off sheets well under this; anything bigger is
 * a question for the factory, not a promise.
 */
export const OVERSIZE_IN = 30

/**
 * A dimension in the customer's text that is beyond OVERSIZE_IN, written back
 * the way they gave it ("50 x 30 x 20 in"), or null. Reads "L x W x H" triples
 * and pairs with or without a unit (unitless means inches, as US customers
 * write), and single values with an explicit unit (50", 50 inch, 120 cm).
 * Quantities, prices, zip codes and phone numbers never carry a unit or an
 * "x", so they do not match.
 */
export function oversizeIn(text: string): string | null {
  const t = String(text || '').replace(/[×*]/g, 'x').replace(/[“”″]/g, '"')
  // No metres: nobody orders a box in them, and "30M" in a marketing pitch is
  // thirty million.
  const unitIn = (u: string) => /^(cm|centimet)/i.test(u) ? 1 / 2.54 : /^(mm|millimet)/i.test(u) ? 1 / 25.4 : /^(ft|feet|foot)/i.test(u) ? 12 : 1
  const UNIT_RE = '"|in(?:ch(?:es)?)?\\b|cm\\b|mm\\b|ft\\b|feet\\b|foot\\b'
  const UNIT = `(?:${UNIT_RE})?`
  // Not preceded by a digit, a letter or a dot: "2.625"" is a decimal tail,
  // "1440x812" a screen size in a form footer, "gxB89X4" part of a URL.
  // Up to four digits: millimetre sizes are written 1266 x 990 x 940 mm
  // (Anthony, 16 Oct 2026 — with three digits only "940 mm" matched, and the
  // email singled out the SMALLEST side as the problem).
  const NUM = '(?<![\\w.])(\\d{1,4}(?:[.,]\\d{1,2})?)'
  // L x W x H, each number optionally followed by its own unit. Pairs without a
  // unit are left alone ("36x24 laser cutter", "9 x 12 folders" are fine;
  // "72x100" is tape in mm by yards).
  const dims = new RegExp(`${NUM}\\s*${UNIT}\\s*x\\s*(\\d{1,4}(?:[.,]\\d{1,2})?)\\s*${UNIT}\\s*x\\s*(\\d{1,4}(?:[.,]\\d{1,2})?)\\s*${UNIT}`, 'gi')
  let m: RegExpExecArray | null
  while ((m = dims.exec(t))) {
    // "1000 x 12 x 12 x 12" is a quantity in front of the size: drop the first
    // number and read on from the second.
    if (/^\s*x\s*\d/.test(t.slice(m.index + m[0].length))) { dims.lastIndex = m.index + m[1].length; continue }
    const u = (m[0].match(new RegExp(UNIT_RE, 'i')) ?? [''])[0]
    const vals = [m[1], m[2], m[3]].map((v) => parseFloat(v.replace(',', '.')))
    // No unit and a value of 100 or more: millimetres (500x300x300), not inches.
    const f = u ? unitIn(u) : Math.max(...vals) >= 100 ? 1 / 25.4 : 1
    if (vals.some((v) => v * f > OVERSIZE_IN)) return m[0].replace(/\s+/g, ' ').trim()
  }
  // A pair or a single measurement with an explicit unit: 48" x 24", 50 inch, 120 cm.
  const single = new RegExp(`${NUM}\\s*(${UNIT_RE})`, 'gi')
  while ((m = single.exec(t))) {
    const v = parseFloat(m[1].replace(',', '.')) * unitIn(m[2])
    if (v > OVERSIZE_IN) {
      const pair = t.slice(m.index).match(new RegExp(`^${NUM.replace('(?<![\\\\w.])', '')}\\s*(?:${UNIT_RE})\\s*x\\s*\\d{1,4}(?:[.,]\\d{1,2})?\\s*(?:${UNIT_RE})?`, 'i'))
      return (pair ? pair[0] : m[0]).replace(/\s+/g, ' ').trim()
    }
  }
  return null
}

export function missingOf(a: QuoteAssessment): Missing[] {
  const out: Missing[] = []
  if (!a.hasSize) out.push('size')
  if (!a.hasStyle) out.push('style')
  return out
}

// ── The model's instructions ────────────────────────────────────────────────
export const ASSESS_SYSTEM = `You read one enquiry that reached a custom packaging company (boxes, cups, sleeves, wax paper, stickers, mailers, trays, inserts, presentation and tax-return folders and similar) and report, as JSON only, what the customer has told us. We run many websites, one per product line (thecustomfolders.com, thewaxpapers.co, shopcardboardboxes.com, …): the site named in a form, in a "Site:" line or in "New quote request from <site>" is OUR OWN site that the customer used, never another company.

Return exactly this object and nothing else:
{"is_quote": boolean, "language": "en", "first_name": string|null, "product": string, "style_label": string, "size_label": string, "has_size": boolean, "has_style": boolean, "has_quantity": boolean, "has_deadline": boolean, "reason": string}

Rules:
- is_quote: true when a real person shows interest in packaging we make, even with no details at all: a quote form with an empty message, a product page enquiry, "what sizes do you have?", or a chat where they only answered "yes" to the product question. Those are exactly the people we must ask for details. False ONLY for spam, SEO/marketing/data pitches, suppliers or factories selling to us, job seekers, test submissions with random characters, a placeholder with no person behind it ("Site not identified", "I need more info about Thank You"), or a chat where the visitor never said anything.
- language: ISO 639-1 code of the language the CUSTOMER wrote in.
- first_name: the customer's first name, properly capitalised, only if it is clearly a person's name. null for a company name, an email handle, initials or anything unsure.
- product: what they want, plural and lower case, 1 to 4 words, WITHOUT the word "custom" ("mailer boxes", "paper cups", "die cut stickers", "wax paper sheets"). Use the product page name if that is all there is.
- style_label: 2 or 3 lower-case words naming what "style" means for this product: "box style" for boxes, "cup type" for cups, "sleeve style" for sleeves, "sticker shape" for stickers, "paper type" for papers.
- size_label: how to ask THIS product's size, at most 45 characters, lower case: "box size (length x width x height)" for boxes and inserts, "cup size (8 oz, 12 oz, 16 oz...)" for cups, "sleeve size or the cup size it fits" for cup sleeves, "sheet size (width x length)" for papers, "sticker size (width x height)" for stickers, "mailer size (width x length)" for mailers and bags.
- has_size — decide the way our sales agents did on ~360 real quotes:
  * Boxes, sleeves, inserts, trays, tubes, displays, mailer/shipping boxes: TRUE when the customer gave the box dimensions (three, or two plus height for a round box), OR the size of the product that goes inside (e.g. "10 oz tumbler 3.5 in high", "2ml vial", "fits a 750ml bottle", "8x8x6"), OR picked a size OPTION from a field on our form ("Size: Slider", "Size: Large"). FALSE for vague words in their own message ("medium size", "small to large", "standard size"), a single number for a box ("12-15 inch round box" with no height), or no size at all.
  * Standard sizes count: A4, A5, letter, legal, business-card size, a vial or bottle capacity ("2ml vial", "750ml bottle").
  * Cups: TRUE when a capacity is given or picked (8 oz, 12 oz, 16 oz, 250 ml). Cup sleeves: TRUE when the cup size they fit is given. Papers, liners, stickers, labels, bags: TRUE when a width x length (or a picked size option) is given. Otherwise FALSE — our agents asked for it.
- has_style — TRUE when the product type is clear from what they wrote, the product they picked, or the page they came from (shipping box, mailer box, candle box, tuck end, rigid box, pillow box, burger box, coffee cups, wax paper, sleeves, inserts, dividers…): our agents choose the usual construction for it and quote. Also TRUE with a reference image. FALSE only when all we have is generic "custom boxes", "packaging" or "a box" with no product, page or picture to go on.
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
  const styleLabel = cleanPhrase(o.style_label, 24) || 'style'
  return {
    isQuote: bool(o.is_quote),
    language: typeof o.language === 'string' ? o.language.trim().toLowerCase().slice(0, 5) : 'en',
    firstName: cleanName(o.first_name),
    product,
    styleLabel,
    sizeLabel: cleanPhrase(o.size_label, 45) || 'size (length x width x height)',
    hasDeadline: bool(o.has_deadline),
    hasSize: bool(o.has_size),
    // A product that names its own style ("mailer boxes", "pillow boxes") has
    // told us the style. The model sometimes still says no, and the customer
    // then gets asked which style they want for the style they already named.
    hasStyle: bool(o.has_style) || namesAStyle(product),
    hasQuantity: bool(o.has_quantity),
    reason: typeof o.reason === 'string' ? o.reason.trim().slice(0, 300) : '',
  }
}

// Only names that ARE a construction. Cups, stickers and plain "shipping
// boxes" are left to the model on purpose: for those, the style question
// (single or double wall, the sticker shape) is one our agents still ask.
const STYLE_WORDS = /\b(mailer|tuck|pillow|rigid|two[- ]piece|gable|sleeves?|trays?|tubes?|window|display|auto[- ]bottom|magnetic|drawer|slide|hexagon|tote|lid|cones?|pouch(es)?|envelopes?|folders?|inserts?|wax)\b/

/** Does the product phrase itself name a style or a single-style product? */
export function namesAStyle(product: string): boolean {
  return STYLE_WORDS.test(product.toLowerCase())
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
  if (complete && a.oversize) {
    parts.push(
      `${thanks} I've noted the size you gave (${a.oversize}). That is larger than what we usually produce, so I'm checking with our production team whether your ${product} can be made at this size, and I'll come back to you with the answer and the price quote.`,
    )
    if (!a.hasDeadline) parts.push('', 'In the meantime, could you please let me know how soon you need these?')
  } else if (complete) {
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

/**
 * The HTML half of the bot's email: one <p> per paragraph, lines inside a
 * paragraph broken with <br>. plainToHtml turns every blank line into extra
 * <br>s, which in Gmail reads as two empty lines between each paragraph.
 */
export function emailHtml(text: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text.split(/\n\s*\n/)
    .map((para) => `<p style="margin:0 0 14px 0;">${para.split('\n').map(esc).join('<br>')}</p>`)
    .join('')
}

/** The text the model reads: the form or chat, with our own boilerplate cut. */
export function quoteTextForAssessment(message: string, name: string | null): string {
  const body = String(message || '')
    .replace(/^\[(Custom Quote|Checkout)\]\s*/, '')
    .replace(/\{"__file":\{[^}]*"name":"([^"]*)"[^}]*\}\}/g, '[customer attached an image: $1]')
    .slice(0, 6000)
  return `Lead name on file: ${name || '(none)'}\n\n${body}`
}

// ── Follow-ups (Step 2) ─────────────────────────────────────────────────────
// Every 3 days until the customer answers. Each one says something new — a
// nudge, help with the size, style ideas, an offer, a check-in — because the
// same "just following up" five times is what gets a domain marked as spam.
// After five the cycle starts again in different words, with a bigger (still
// capped) offer. Discount rule from the owner, 2026-10-13: 10–15%, never more
// than 20%, and 20% only for a big holiday — the bot stays at 10 and 15.

export const FOLLOW_UP_GAP_DAYS = 3
/** A call task for the agent after every this-many unanswered follow-ups. */
export const CALL_TASK_EVERY = 3

export interface Holiday { name: string; date: Date }

function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1))
  const shift = (weekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + shift + (n - 1) * 7))
}
function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0))
  return new Date(Date.UTC(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7)))
}

/** US shopping holidays a packaging buyer plans around, for one year. */
export function holidaysOf(year: number): Holiday[] {
  const thanksgiving = nthWeekday(year, 10, 4, 4)
  return [
    { name: "Valentine's Day", date: new Date(Date.UTC(year, 1, 14)) },
    { name: "Mother's Day", date: nthWeekday(year, 4, 0, 2) },
    { name: 'Memorial Day', date: lastWeekday(year, 4, 1) },
    { name: 'the 4th of July', date: new Date(Date.UTC(year, 6, 4)) },
    { name: 'Labor Day', date: nthWeekday(year, 8, 1, 1) },
    { name: 'Columbus Day', date: nthWeekday(year, 9, 1, 2) },
    { name: 'Halloween', date: new Date(Date.UTC(year, 9, 31)) },
    { name: 'Thanksgiving', date: thanksgiving },
    { name: 'Black Friday', date: new Date(thanksgiving.getTime() + 864e5) },
    { name: 'Christmas', date: new Date(Date.UTC(year, 11, 25)) },
  ]
}

/** The next holiday at least a week away — an offer needs time to be used. */
export function nextHoliday(now: Date): Holiday {
  const soon = now.getTime() + 7 * 864e5
  const all = [...holidaysOf(now.getUTCFullYear()), ...holidaysOf(now.getUTCFullYear() + 1)]
  return all.find((h) => h.date.getTime() >= soon) ?? all[all.length - 1]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const dayLabel = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`

function missingWords(missing: Missing[], a: QuoteAssessment): string {
  const words = missing.map((m) => (m === 'size' ? 'size' : m === 'style' ? a.styleLabel : 'quantity'))
  if (words.length <= 1) return words[0] ?? 'details'
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

// Style ideas a customer can answer with one word. Products the model calls
// cups get wall types; anything else sold as a box gets our common box styles.
function styleIdeas(a: QuoteAssessment): string {
  if (/cup/.test(a.product)) return 'single wall, double wall and ripple wall cups'
  if (/sticker|label/.test(a.product)) return 'die cut, kiss cut and sheet stickers'
  if (/bag|pouch|mailer/.test(a.product) && !/box/.test(a.product)) return 'flat, stand-up and zipper styles'
  return 'tuck end boxes, mailer boxes, two-piece rigid boxes and sleeve-and-tray boxes'
}

export interface FollowUpContext {
  /** 1-based number of this follow-up. */
  n: number
  missing: Missing[]
  firstName: string | null
  now: Date
}

/**
 * Follow-up number n, for a customer who has not answered. While details are
 * missing it asks for them; once nothing is missing (the price is with a
 * person) it only keeps the conversation warm — it never quotes.
 */
export function buildFollowUp(a: QuoteAssessment, c: FollowUpContext): { text: string; offer: number | null } {
  // Older ledgers listed quantity as missing; it no longer is (missingOf).
  c = { ...c, missing: c.missing.filter((m) => m !== 'quantity') }
  const greet = c.firstName ? `Hello ${c.firstName},` : 'Hello,'
  const what = missingWords(c.missing, a)
  const asking = c.missing.length > 0
  const cycle = Math.floor((c.n - 1) / 5)
  const step = (c.n - 1) % 5
  const holiday = nextHoliday(c.now)
  const offer = cycle === 0 ? 10 : 15
  const bySize = c.missing.includes('size')

  let body: string[]
  let usedOffer: number | null = null
  switch (step) {
    case 0:
      body = asking
        ? [`Hope things are going well on your end! Whenever you get a chance to send over the ${what}, I'll have the price quote for your ${a.product} ready right away.`]
        : [`Hope things are going well on your end! Just checking whether you had any questions about your ${a.product} while our team works on your price quote.`]
      if (cycle > 0) body = [`I hope you're doing well! I'm still here whenever you're ready to move ahead with your ${a.product}.${asking ? ` Once I have the ${what}, the price quote follows right away.` : ''}`]
      break
    case 1:
      body = bySize
        ? [`If you're not sure about the exact size, that's completely fine. Just send the size of the product that goes inside, or a photo of it next to a ruler, and I'll work out the right box size for you.`, `Happy to jump on a quick call too, if that's easier than email.`]
        : [`If it's easier, I'm happy to jump on a quick call and go over your ${a.product} together. Just let me know a good time and the best number to reach you.`]
      break
    case 2:
      body = [`In case it helps you decide, the most popular choices for ${a.product} are ${styleIdeas(a)}. A picture of something you like works great too, and I'll take it from there.`]
      if (!asking) body = [`I wanted to share a quick note: along with the box itself, our price includes free shipping to your doorstep and no extra or hidden charges, and we send 2D and 3D mockups before anything goes to print.`]
      break
    case 3:
      usedOffer = offer
      body = [`With ${holiday.name} coming up, I can offer ${offer}% off your order of ${a.product} if you're able to move forward before ${dayLabel(holiday.date)}.${asking ? ` Once I have the ${what}, I'll include it in your price quote.` : ''}`]
      break
    default:
      body = [`I wanted to check in one more time: are you still interested in moving forward with your ${a.product}?`, `If the timing isn't right now, I totally understand. Just let me know and I'll follow up later instead.`]
  }

  return {
    text: [greet, '', ...body.flatMap((p, i) => (i ? ['', p] : [p])), '', 'Looking forward to hearing from you.', '', 'Warm regards,'].join('\n'),
    offer: usedOffer,
  }
}

// ── Answering the customer's reply ──────────────────────────────────────────
// Once a customer writes back, the bot may answer ONLY when the reply is the
// details it asked for. Anything else — a question, a price talk, a worry, a
// no, "call me" — is a person's job, and the bot hands the lead over instead.

export const REPLY_SYSTEM = `A customer of a custom packaging company was asked by email for missing details (size, style, quantity). Read their LATEST reply and decide, as JSON only:
{"needs_person": boolean, "reason": string}
needs_person is TRUE when the reply contains anything besides plain details: a question of any kind (price, MOQ, delivery, materials, samples, "can you..."), negotiation, a complaint or worry, saying they are not interested or will order later, asking for a call, sending artwork with instructions, or anything you are unsure about.
needs_person is FALSE only when the reply simply provides details (size, quantity, style, a picture) with at most a greeting or thanks.
reason: one short English sentence.`

export function parseReplyDecision(text: string): { needsPerson: boolean; reason: string } | null {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0])
    if (typeof o.needs_person !== 'boolean') return null
    return { needsPerson: o.needs_person, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '' }
  } catch { return null }
}

/** The bot's answer to a reply that brought details. */
export function buildReplyAnswer(a: QuoteAssessment, firstName: string | null): { text: string; complete: boolean } {
  const missing = missingOf(a)
  const complete = missing.length === 0
  const parts: string[] = [firstName ? `Hello ${firstName},` : 'Hello,', '']
  if (complete) {
    parts.push(`Thank you for the details! I have everything I need, and the price quote for your ${a.product} is in process. I'll share it with you shortly.`)
    if (!a.hasDeadline) parts.push('', 'In the meantime, could you please let me know how soon you need these?')
  } else if (missing.length === 1) {
    const ask = askFor(missing, a)
    parts.push(`Thank you for the details! ${ask}`)
  } else {
    parts.push('Thank you for the details! To finish your price quote, could you please also share:',
      ...missing.map((m) => `• ${ASK_LINE[m](a)}`))
  }
  parts.push('', 'Looking forward to hearing from you.', '', 'Warm regards,')
  return { text: parts.join('\n'), complete }
}

// ── Follow-ups after the price was sent (Step 3) ────────────────────────────
// Our agents' own sequence after a quote (docs/bot-voice.md §4): did it
// arrive, float it back up, remind them what is included, a holiday offer on
// the quoted pricing, one last check-in. Never a new price — the numbers are
// the agent's, and a different figure from the bot would undercut them.

/** A sent email carries a price when it has a dollar amount in the agent's own words. */
export function looksLikeQuote(body: string): boolean {
  const own = String(body || '').split(/\n--\s*\n|\nOn .{5,200}wrote:/)[0]
  return /\$\s?\d/.test(own)
}

export function buildQuoteFollowUp(c: { n: number; firstName: string | null; product: string; now: Date }): { text: string; offer: number | null } {
  const greet = c.firstName ? `Hello ${c.firstName},` : 'Hello,'
  const cycle = Math.floor((c.n - 1) / 5)
  const step = (c.n - 1) % 5
  const holiday = nextHoliday(c.now)
  const offer = cycle === 0 ? 10 : 15
  const product = c.product || 'packaging'
  let body: string[]
  let used: number | null = null
  switch (step) {
    case 0:
      body = cycle === 0
        ? [`I hope you're doing well! I wanted to circle back on the price quote I sent over for your ${product} - just checking if it reached you and if you've had a chance to look it over.`, `I'm happy to answer any questions or make adjustments if needed.`]
        : [`I hope you're doing well! Your price quote for the ${product} is still here whenever you're ready, and I'm happy to update it if anything has changed on your side.`]
      break
    case 1:
      body = [`Just floating this back to the top of your inbox in case it got buried. No rush at all - whenever you get a chance to take a look, I'd love to hear your thoughts.`, `Happy to jump on a quick call if that's easier than email.`]
      break
    case 2:
      body = [`A quick reminder of what comes with your quote: free shipping to your doorstep, no extra or hidden charges, free lamination, and 2D and 3D mockups before anything goes to print.`, `If the quantity or budget needs a different option, just let me know and I'll see what I can do.`]
      break
    case 3:
      used = offer
      body = [`With ${holiday.name} coming up, I can offer ${offer}% off the quoted pricing if you're able to move forward before ${MONTHS[holiday.date.getUTCMonth()]} ${holiday.date.getUTCDate()}.`, `Please let me know if you have any questions or would like to make any changes. I'd be happy to help!`]
      break
    default:
      body = [`I wanted to check in one more time: are you still interested in moving forward with your ${product}?`, `If the timing isn't right now, I totally understand. Just let me know and I'll follow up later instead.`]
  }
  return {
    text: [greet, '', ...body.flatMap((p, i) => (i ? ['', p] : [p])), '', 'Looking forward to hearing from you.', '', 'Warm regards,'].join('\n'),
    offer: used,
  }
}

// ── Holiday promotions (Step 4) ─────────────────────────────────────────────
// One email per customer per campaign, sent from the 20th of the month before
// the holiday until the holiday itself (owner, 2026-10-13). Discounts: 10% for
// most, 15% at Christmas, 20% for Thanksgiving / Black Friday — the "big
// occasion" the owner allowed 20% for.

export interface Campaign { key: string; holiday: string; date: Date; start: Date; discount: number }

export function campaignsOf(year: number): Campaign[] {
  const mk = (key: string, holiday: string, date: Date, discount: number): Campaign => ({
    key: `${key}-${year}`, holiday, date, discount,
    start: new Date(Date.UTC(date.getUTCMonth() === 0 ? year - 1 : year, (date.getUTCMonth() + 11) % 12, 20)),
  })
  const tg = nthWeekday(year, 10, 4, 4)
  return [
    mk('valentines', "Valentine's Day", new Date(Date.UTC(year, 1, 14)), 10),
    mk('mothers-day', "Mother's Day", nthWeekday(year, 4, 0, 2), 10),
    mk('memorial-day', 'Memorial Day', lastWeekday(year, 4, 1), 10),
    mk('july-4', 'the 4th of July', new Date(Date.UTC(year, 6, 4)), 10),
    mk('labor-day', 'Labor Day', nthWeekday(year, 8, 1, 1), 10),
    mk('black-friday', 'Thanksgiving and Black Friday', new Date(tg.getTime() + 864e5), 20),
    mk('christmas', 'Christmas', new Date(Date.UTC(year, 11, 25)), 15),
  ]
}

/** The campaign running on `now`, or else the next one to start. */
export function currentOrNextCampaign(now: Date): { campaign: Campaign; running: boolean } {
  const all = [...campaignsOf(now.getUTCFullYear()), ...campaignsOf(now.getUTCFullYear() + 1)]
  const running = all.find((c) => now >= c.start && now <= new Date(c.date.getTime() + 864e5))
  if (running) return { campaign: running, running: true }
  return { campaign: all.filter((c) => c.start > now).sort((a, b) => +a.start - +b.start)[0], running: false }
}

export function buildPromoEmail(c: { campaign: Campaign; firstName: string | null; product: string | null; siteName: string; unsubscribeUrl: string }): { subject: string; text: string; html: string } {
  const what = c.product ? `custom ${c.product.replace(/^custom\s+/i, '')}` : 'custom packaging'
  const by = `${MONTHS[c.campaign.date.getUTCMonth()]} ${c.campaign.date.getUTCDate()}`
  const subject = `${c.campaign.discount}% off for ${c.campaign.holiday} - ${c.siteName}`
  const text = [
    c.firstName ? `Hello ${c.firstName},` : 'Hello,',
    '',
    `With ${c.campaign.holiday} coming up, I wanted to let you know we're offering ${c.campaign.discount}% off orders of ${what} placed before ${by}.`,
    '',
    `It's the same as always: made from scratch to your size and design, free shipping to your doorstep, no extra or hidden charges, and 2D and 3D mockups before anything goes to print.`,
    '',
    `If you'd like a price quote, just reply with the size and quantity you need and I'll send it over right away.`,
    '',
    'Warm regards,',
  ].join('\n')
  const footer = `You're receiving this because you asked ${c.siteName} for a quote. Don't want offers like this? Unsubscribe: ${c.unsubscribeUrl}`
  return {
    subject,
    text: `${text}\n\n${footer}`,
    html: `${emailHtml(text)}`,
  }
}

/** The small grey line under the signature in the HTML version. */
export function promoFooterHtml(siteName: string, url: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<p style="margin:22px 0 0 0;font-size:11px;line-height:16px;color:#9ca3af;">You're receiving this because you asked ${esc(siteName)} for a quote. Don't want offers like this? <a href="${esc(url)}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>.</p>`
}
