// Opportunities — which packaging deals can close, read off what the customer
// and the agent actually wrote. Owner's brief (2026-10-20): agents should see
// for themselves which deals are close instead of being told.
//
// Four lists, all derived — nothing here is stored:
//   waiting   the customer wrote last (email or WhatsApp) and nobody has
//             answered yet
//   invoices  an invoice or payment link went out and no PAID sale in the
//             Sales ledger matches it
//   hot       a price was sent and the customer answered it with a buying
//             signal (proceed / sample / price / turnaround / artwork …)
//   older     created before this month, still open, the customer engaged —
//             worth reviving
//
// Pure on purpose: the API route folds real rows through these functions, and
// scratch/opps-backtest.ts runs the very same functions over history with the
// clock wound back, so the scoring that was backtested is the scoring shipped.
//
// Two traps the data sets and this file handles:
//  • An agent answering from their OWN Gmail is captured by the reply sweep as
//    a `crm_email_in` row whose `from` is stevehayes@peptidesboxes.com. That is
//    OUR message, not the customer's — ourAddress() decides.
//  • Rows from the Gmail history import carry the import time in created_at;
//    the real send time is the JSON `at`. Every event is timed by `at` first.

import { CRM_STAGES, parseCrmStage, parseCrmValue, stageFromLeadStatus, type CrmStage } from './crm'
import { parseLeadStatus } from './leadstatus'
import { parseFromHeader } from './emailreply'

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface OppRow { session_id: string; site_id: string; role: string; message: string; created_at: string }

export interface OppLead {
  /** chat session id, or quote-<leads.id> */
  id: string
  siteId: string
  name: string
  email: string | null
  phone: string | null
  createdAt: string
  /** What the lead said when it arrived (form body / chat capture). */
  text: string
}

/** The slice of a Sales-ledger entry this needs. */
export interface OppSale {
  id: string
  leadId: string | null
  reference: string
  notes: string
  customer: string
  email: string
  orderDate: string
  orderAmount: number
  currency: string
  /** pending | partial | paid | refunded | cancelled */
  status: string
  outstanding: number
  salesPerson: string
  stream: string
}

export interface OppContext {
  now: Date
  /** ISO instant the current (Karachi) month began. */
  monthStart: string
  /** Every domain that is us — site domains, the team's own. */
  ourDomains: Set<string>
  /** Exact member addresses (consumer Gmail members are "us" too). */
  ourAddresses: Set<string>
}

// ── Small helpers ───────────────────────────────────────────────────────────

const DAY = 86_400_000

function iso(ts: string | null | undefined): string | null {
  if (!ts) return null
  const s = /[Z]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

function json(message: string): Record<string, unknown> | null {
  try {
    const o = JSON.parse(message)
    return o && typeof o === 'object' ? o as Record<string, unknown> : null
  } catch { return null }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** When this row's event really happened: the JSON `at` wins over created_at. */
export function eventAt(r: OppRow, o: Record<string, unknown> | null): string | null {
  return iso(str(o?.at)) ?? iso(r.created_at)
}

/** Lowercased local part of an address — the agent's identity across aliases
 *  (stevehayes@shopcardboardboxes.com and stevehayes@peptidesboxes.com). */
export function agentKey(email: string | null | undefined): string {
  return String(email ?? '').trim().toLowerCase().split('@')[0] ?? ''
}

export function ourAddress(addr: string, ctx: Pick<OppContext, 'ourDomains' | 'ourAddresses'>): boolean {
  const a = parseFromHeader(addr || '').email
  if (!a) return false
  if (ctx.ourAddresses.has(a)) return true
  const dom = a.split('@')[1] ?? ''
  return ctx.ourDomains.has(dom)
}

const SYSTEM_SENDER = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|bounce[s]?|calendar-notification|service)@/i
const AUTO_BODY = /we('ve| have)? (successfully )?received your (message|email|inquiry|request)|this is an automated (message|reply|response)|auto-?generated|do not reply to this (email|message)/i
const SYSTEM_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|read:|accepted:|declined:)/i

/**
 * The new part of an email body — quoted history, forwarded headers and
 * signatures cut off. Deliberately more aggressive than splitQuoted (which
 * keeps an inferred boundary when prose follows it, so a person never loses a
 * sentence on screen): here the cost runs the other way. A customer's "thanks
 * for the quote" with our own "ready to place your order?" quoted under it
 * must not read as the customer wanting to order.
 */
export function visibleText(body: string): string {
  if (!body) return ''
  const text = body.replace(/\r\n/g, '\n')
  // An attribution can sit mid-line once a client re-wraps the reply.
  const inline = text.search(/\bOn (Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?[^\n]{0,160}?(\n[^\n]{0,160}?)?\bwrote:|\bFrom: [^\n]{0,80}<[^>\n]+@[^>\n]+>|-{2,} ?(Original|Forwarded) [Mm]essage|\bOn \d{1,2} [A-Z][a-z]{2,8},? \d{4}[^\n]{0,160}?\bwrote:|\b\d{1,2} [a-z]{3,5}\.? \d{4} kl\.[^\n]{0,120}skrev/)
  const head = inline > 0 ? text.slice(0, inline) : text
  const out: string[] = []
  for (const line of head.split('\n')) {
    const t = line.trim()
    if (t.startsWith('>')) break
    if (/^(From|Sent|To|Date|Subject|Cc):\s/i.test(t) && out.length > 0) break
    if (/^(Sent from my|Get Outlook for)/i.test(t)) break
    if (/^-- ?$/.test(t) || /^_{5,}$/.test(t)) break
    out.push(line)
  }
  return out.join('\n').trim()
}

// ── What the text says ──────────────────────────────────────────────────────

/**
 * The price a quote email put on the table, in dollars.
 *
 * The team writes quotes two ways and both are read:
 *   "Quantity Price Per Pcs Total Price\n400 $1.26 $504\n800 …"  → $504
 *   "Quantity: 250 boxes will cost $2.35/box totaling $588"      → $588
 * Several tiers are quoted at once; the FIRST tier (the smallest order) is
 * taken — the conservative number, and the one customers most often pick.
 * Only the visible (non-quoted) text is read, so a reply that merely quotes
 * an old price does not re-date the quote.
 */
export function extractQuoteAmount(text: string): number | null {
  if (!text) return null
  const t = text.replace(/\r/g, '')
  const money = (s: string) => {
    const n = Number(s.replace(/[,$\s]/g, ''))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  // Table form: the first row under a "Total Price" header.
  const head = t.search(/total\s+price/i)
  if (head >= 0) {
    const after = t.slice(head).split('\n').slice(1, 8)
    for (const line of after) {
      const amounts = line.match(/\$\s?\d[\d,]*(?:\.\d+)?/g)
      if (amounts && amounts.length >= 2) {
        const v = money(amounts[amounts.length - 1])
        if (v && v >= 20) return v
      }
    }
  }
  const tot = t.match(/totall?ing\s*(?:of\s*)?\$\s?(\d[\d,]*(?:\.\d+)?)/i)
  if (tot) {
    const v = money(tot[1])
    if (v && v >= 20) return v
  }
  // "Total: $1,240" / "total cost would be $980" / "grand total $1,050"
  const total = t.match(/\b(?:grand\s+)?total(?:\s+(?:cost|amount|price))?(?:\s+(?:would|will)\s+be|\s+is|:)?\s*\$\s?(\d[\d,]*(?:\.\d+)?)/i)
  if (total) {
    const v = money(total[1])
    if (v && v >= 20) return v
  }
  return null
}

/** A payment link a message carries (PayPal invoice, PayPal.me, Wise, Stripe…). */
export function paymentLinks(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()
  const re = /https?:\/\/(?:www\.)?(?:paypal\.com\/invoice\/p\/#?[A-Z0-9-]+|paypal\.me\/[^\s>)"']+|wise\.com\/pay\/[^\s>)"']+|buy\.stripe\.com\/[^\s>)"']+|(?:www\.)?payoneer\.com\/[^\s>)"']+)/gi
  for (const m of text.match(re) ?? []) out.add(m.replace(/[.,;]+$/, ''))
  return [...out]
}

/** The PayPal invoice code in a link, e.g. INV2-XUJA-RBGZ-XYXM-MKFH or 2HPMFPN34MT7QGZW. */
export function paypalInvoiceCode(url: string): string | null {
  const m = url.match(/paypal\.com\/invoice\/p\/#?([A-Z0-9-]{8,})/i)
  return m ? m[1].toUpperCase() : null
}

// The customer told us they are out. Checked BEFORE the buying signals,
// because "we will not be moving forward" contains "moving forward".
const NEGATIVE: [RegExp, string][] = [
  [/\b(went|go(ing)?|gone|decided to go) with (another|a different|someone else|other|a local|a cheaper)/i, 'went with another company'],
  [/\b(another|a different|other) (company|supplier|vendor|manufacturer|printer|source)\b(?! ?(as well|too|also))/i, 'went with another company'],
  [/\bfound (a|another) (cheaper|different|local|better)?\s*(supplier|vendor|company|option|quote|printer)/i, 'went with another company'],
  [/\b(research|look(ing)? (at|for|into)|check(ing)?|compar(e|ing)|explor(e|ing)) (some |a few )?(other|another|more|different) (suppliers?|vendors?|options?|companies|quotes|manufacturers?)/i, 'shopping around'],
  [/\bdifferent direction\b|\bsource(d)? (it|the item|them|these|locally)\b|\b(went|go|going) local(ly)?\b|\bfound a local\b|^\s*no need\b/i, 'went with another company'],
  [/\b(too|very|quite|bit|little|way) (expensive|pricey|high|costly|much)\b|\bout of (our|my) (budget|price range)|\b(over|exceeds?|above|beyond) (our|my) budget|\bprice(s)? (is|are) (too|a bit|a little|way) high|\bcan'?t afford|\bcheaper (option|elsewhere|quote|price)|\bnot within (our|my) budget|\bmore affordable\b|\bexorbitant\b|\boverpriced\b|\bridiculous(ly)?\b|\bsmoking crack\b/i, 'too expensive'],
  [/\bnot (be )?(interested|moving forward|going to (proceed|move forward|order)|proceeding|able to (proceed|move forward)|buying|ordering|purchasing)\b|\bno longer (need|interested|require|moving)|\bdecided (not|against)|\bdecided to (stop|pause|cancel|postpone|wait|hold)|\bwon'?t be (moving|proceeding|ordering|needing|buying)|\b(hold|holding) off\b|\bput (this|it|the order|things|the project) on hold|\bpass on (this|it)|\bcancel(l?ed)? (the|my|our)? ?(order|project|request)|\b(stop|pause|postpone)(ped)? (the )?production\b|\bnext (season|year)\b|\bsomething (different|else)\b|\b(i|we) (think (i|we) )?will stop\b|\bstop here\b|\bunsubscribe\b|\bremove me\b|\bstop (emailing|contacting|messaging)/i, 'not going ahead'],
]

// A message that hedges this way carries no buying signal, whatever else it says.
const SOFT_NO = /\bunfortunately\b|\bwill think about it\b|\bnot (right )?now\b|\bnot yet\b|\bmaybe (later|next)\b|\bcome back later\b|\bat this (point|time)\b.{0,30}\bnot\b/i
// "Before moving forward…", "once we proceed…", "if we want to place an order"
// are conditions, not decisions.
const CONDITIONAL = /\b(before|if|once|when|until|whether|in case)\b[^.?!\n]{0,40}\b(proceed|move forward|moving forward|go ahead|place (an |the |our |my )?order|order(ing)?|purchas(e|ing))/i

// Buying signals, strongest first.
const STRONG: [RegExp, string][] = [
  [/\b(i|we)('d| would)? (like|want|wish|love) to (proceed|move forward|go ahead|place (an |the |our |my )?order|order|start (the )?(order|production))\b|\blet'?s (proceed|go ahead|move forward|do it|do this|go with|get (it|this|the order) started)\b|\bcan we (move forward|proceed|go ahead|place)\b|\bready to (order|proceed|move forward|go ahead|place)\b|\b(we|i)('ll| will) (take|go with|proceed|order)\b|\bplease (go ahead|proceed)\b|\bconfirm(ing)? (the |my |our )?order\b|\bgo with (the )?\d/i, 'wants to proceed'],
  [/\b(send|share|email)( me| us| over)?( the| an| a)? (invoice|payment link|payment details)|\bhow (do|can|should) (i|we) (pay|make (the )?payment)\b|\b(i|we)('ve| have)? (just |already )?paid\b|\bpay (by|with|via) (card|credit|debit|paypal)/i, 'asked for the invoice / payment'],
  [/\b(it'?s|is|are|design|proof|mock-?up)s? approved\b|\bapproved for print|\b(i|we) approve\b|\b(proof|mock-?up|design)s? looks? (great|good|perfect)/i, 'approved the design'],
  [/\b(billing|shipping|delivery) (address|info|details)\b/i, 'sent the shipping / billing details'],
]
const MEDIUM: [RegExp, string][] = [
  [/\bsamples?\b/i, 'asked about a sample'],
  [/\bmock-?ups?\b|\bproofs?\b|\bartwork\b|\bdesign files?\b|\b(logo|design) (is )?attached\b|\battached (is |are )?(the |our |my )?(logo|design|artwork|file)/i, 'sent / asked about artwork'],
  [/\bturn-?around\b|\blead time\b|\bhow (long|soon|quickly)\b|\bwhen (can|could|will|would) (we|i|it|they|you) (get|receive|ship|have|deliver|be (delivered|ready|shipped))|\b(need|want) (them|these|it|the boxes|the order)? ?(by|before)\b|\bdelivery (date|time)\b|\bdeadline\b|\brush\b|\bexpedite/i, 'asked about turnaround'],
  [/\bdiscount\b|\bbest (price|you can do|rate)\b|\b(lower|better|reduce) (the )?price\b|\bprice (for|on|per|if)\b|\bhow much (would|will|for|is)\b|\bcost (for|of|if|per)\b|\bquote (for|on) \d|\bwhat (would|will) (it|that|the price) be\b|\bprice break/i, 'asked about price'],
  [/\b(quantity|qty)\b|\b\d[\d,]{2,} ?(pcs|pieces|units|boxes|bags|cups|sleeves|labels|stickers|trays|tubes|mailers)\b/i, 'talked quantity'],
  [/\b(sounds|looks) (good|great|perfect)\b|\bthat works\b|\bperfect\b|\bgreat,? thank|\bawesome\b/i, 'positive reply'],
]

export interface Signal { kind: 'negative' | 'strong' | 'medium' | 'none'; reason: string }


export function customerSignal(text: string): Signal {
  const t = (text || '').slice(0, 2000)
  if (!t.trim()) return { kind: 'none', reason: '' }
  for (const [re, why] of NEGATIVE) if (re.test(t)) return { kind: 'negative', reason: why }
  if (SOFT_NO.test(t)) return { kind: 'none', reason: '' }
  for (const [re, why] of STRONG) {
    if (!re.test(t)) continue
    // A condition ("before we proceed") downgrades a decision to interest.
    if (why === 'wants to proceed' && CONDITIONAL.test(t)) return { kind: 'medium', reason: 'talked about ordering' }
    return { kind: 'strong', reason: why }
  }
  for (const [re, why] of MEDIUM) if (re.test(t)) return { kind: 'medium', reason: why }
  return { kind: 'none', reason: '' }
}

// Orders the owner will not take (feedback: no alcohol, no religious orders —
// Jewish religious events included, confirmed 2026-10-20). They are flagged
// "decline", never counted as a sales chance.
// Words that only mean alcohol in context — "wine box" is also a box STYLE a
// candle maker asks for, and "for the sake of" is not rice wine.
const ALCOHOL = /\b(alcohol(ic)?|whiske?y|bourbon|scotch whisky|vodka|tequila|mezcal|liquors?|liqueurs?|winery|wineries|vineyards?|brewery|breweries|brewing co|distiller(y|ies)|distilled spirits|champagne (bottles?|flutes?|glass(es)?)|bottles? of (champagne|prosecco)|prosecco|sazerac|hard seltzer|wine (bottles?|glass(es)?|club|labels?|brand|company|shop|store|tasting|carrier|gift)|bottles? of (wine|beer|whiske?y|vodka|tequila|rum|gin)|beer (bottles?|cans?|brand|company|carrier|growler)|craft beer|liquor store|spirits brand|rum brand|gin brand|cocktail kits?)\b/i
const RELIGIOUS = /\b(church(es)?|bible|quran|koran|mosque|synagogue|bar mitzvah|bat mitzvah|b'?nai mitzvah|baptism|christening|(first|holy) communion|confirmation gift|rosary|ramadan|eid (al|ul|mubarak)|hanukkah|chanukah|passover|diwali|religious|ministry|worship|prayer|parish|torah|judaica)\b/i

export function restrictedReason(text: string): string | null {
  const t = text || ''
  const a = t.match(ALCOHOL)
  if (a) return `alcohol (${a[0].toLowerCase()})`
  const r = t.match(RELIGIOUS)
  if (r) return `religious (${r[0].toLowerCase()})`
  return null
}

// ── Folding rows into one state per customer ────────────────────────────────

export interface CustomerMsg { at: string; text: string; channel: 'email' | 'whatsapp' }

export interface LeadState {
  /** The record to open. */
  id: string
  ids: string[]
  siteId: string
  name: string
  email: string | null
  createdAt: string
  stage: CrmStage
  stageAt: string | null
  /** Agent key (local part) of the assigned owner, else whoever last wrote. */
  owner: string | null
  ownerEmail: string | null
  lastOurAt: string | null
  lastOurBy: string | null
  /** First reply a PERSON made (not the quote bot): email, Gmail reply, WhatsApp, chat, call. */
  humanAt: string | null
  customer: CustomerMsg[]
  quote: { amount: number; at: string } | null
  /** First moment a price is known to have gone out (a price, or the stage). */
  quoteSentAt: string | null
  estimated: number | null
  payLinks: { url: string; at: string }[]
  invoices: { number: string; total: number; currency: string; at: string }[]
  restricted: string | null
  leadText: string
}

const DEAD: ReadonlySet<CrmStage> = new Set<CrmStage>(['won', 'lost', 'duplicate', 'not_interested', 'manufacturer'])
const QUOTED_STAGES: ReadonlySet<CrmStage> = new Set<CrmStage>(['quote_sent', 'follow_up', 'pending_design', 'on_hold'])

function invoiceTotal(o: Record<string, unknown>): number {
  const items = Array.isArray(o.items) ? o.items as Record<string, unknown>[] : []
  const n = (v: unknown) => { const x = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(x) ? x : 0 }
  const sub = items.reduce((a, it) => a + n(it.quantity) * n(it.rate), 0)
  const tax = n(o.taxPercent)
  return Math.round(sub * (1 + tax / 100) * 100) / 100
}

/**
 * One state per customer. Records are merged on site + email exactly like the
 * pipeline board does (lib/pipeline.ts), so a chat and a quote form from the
 * same person are one opportunity, not two.
 *
 * Anything that happened after `ctx.now` is ignored — that is what lets the
 * backtest wind the clock back without a second implementation.
 */
export function foldLeads(leads: OppLead[], rows: OppRow[], ctx: OppContext): LeadState[] {
  const nowIso = ctx.now.toISOString()
  const byId = new Map<string, LeadState>()
  for (const l of leads) {
    const created = iso(l.createdAt)
    if (!created || created > nowIso) continue
    byId.set(l.id, {
      id: l.id, ids: [l.id], siteId: l.siteId, name: l.name, email: l.email?.trim().toLowerCase() || null,
      createdAt: created, stage: 'new', stageAt: null, owner: null, ownerEmail: null,
      lastOurAt: null, lastOurBy: null, humanAt: null, customer: [], quote: null, quoteSentAt: null, estimated: null,
      payLinks: [], invoices: [], restricted: null, leadText: l.text || '',
    })
  }

  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const stagePairAt = new Set<string>()
  for (const r of sorted) if (r.role === 'crm_stage') stagePairAt.add(`${r.session_id}|${r.created_at}`)
  const assignAt = new Map<string, string>()
  const invoiceDocs = new Map<string, Map<string, { o: Record<string, unknown>; at: string }>>()

  const ours = (s: LeadState, at: string, by: string) => {
    if (!s.lastOurAt || at > s.lastOurAt) { s.lastOurAt = at; s.lastOurBy = by || s.lastOurBy }
  }
  const human = (s: LeadState, at: string) => { if (!s.humanAt || at < s.humanAt) s.humanAt = at }
  const quoteFrom = (s: LeadState, text: string, at: string) => {
    const amt = extractQuoteAmount(text)
    if (amt && (!s.quote || at >= s.quote.at)) s.quote = { amount: amt, at }
    if (amt && (!s.quoteSentAt || at < s.quoteSentAt)) s.quoteSentAt = at
    for (const url of paymentLinks(text)) s.payLinks.push({ url, at })
  }

  for (const r of sorted) {
    const s = byId.get(r.session_id)
    if (!s) continue
    const o = json(r.message)
    const at = eventAt(r, o)
    if (!at || at > nowIso) continue
    switch (r.role) {
      case 'crm_email': {
        if (!o) break
        const body = visibleText(str(o.body))
        ours(s, at, agentKey(str(o.sentBy) || parseFromHeader(str(o.from)).email))
        quoteFrom(s, body, at)
        // The bot's own email is not a person answering; a bot draft an agent
        // reviewed and sent (reviewedBy) is.
        if (o.bot !== true || str(o.reviewedBy)) human(s, at)
        break
      }
      case 'admin': {
        // A person replying in the live chat.
        human(s, at)
        break
      }
      case 'crm_call': {
        if (o && str(o.by) && /^(completed|in-progress|answered)$/i.test(str(o.status))) human(s, at)
        break
      }
      case 'crm_email_in': {
        if (!o || o.direction !== 'inbound') break
        const from = str(o.from)
        if (ourAddress(from, ctx)) {
          // The agent replying from their own Gmail.
          const body = visibleText(str(o.body))
          ours(s, at, agentKey(parseFromHeader(from).email))
          quoteFrom(s, body, at)
          human(s, at)
          break
        }
        if (SYSTEM_SENDER.test(parseFromHeader(from).email) || SYSTEM_SUBJECT.test(str(o.subject).trim())) break
        const body = visibleText(str(o.body)) || str(o.snippet)
        if (AUTO_BODY.test(body.slice(0, 600))) break
        s.customer.push({ at, text: body.slice(0, 2000), channel: 'email' })
        break
      }
      case 'crm_wa_in': {
        if (!o) break
        s.customer.push({ at, text: str(o.body).slice(0, 2000), channel: 'whatsapp' })
        break
      }
      case 'crm_wa_out': {
        if (!o) break
        ours(s, at, agentKey(str(o.sentBy)))
        quoteFrom(s, str(o.body), at)
        human(s, at)
        break
      }
      case 'crm_stage': {
        const st = parseCrmStage(r.message)
        if (st) { s.stage = st.stage; s.stageAt = at }
        if (st && QUOTED_STAGES.has(st.stage) && (!s.quoteSentAt || at < s.quoteSentAt)) s.quoteSentAt = at
        break
      }
      case 'lead_status': {
        if (stagePairAt.has(`${r.session_id}|${r.created_at}`)) break
        const mapped = stageFromLeadStatus(parseLeadStatus(r.message)?.status)
        if (mapped) { s.stage = mapped; s.stageAt = at }
        break
      }
      case 'crm_value': {
        const v = parseCrmValue(r.message)
        if (v && v.currency === 'USD') s.estimated = v.estimated
        break
      }
      case 'assignment': {
        const who = (r.message ?? '').trim().toLowerCase()
        s.ownerEmail = who || null
        s.owner = who ? agentKey(who) : null
        assignAt.set(s.id, at)
        break
      }
      case 'crm_pay_link': {
        if (o?.kind === 'link' && str(o.url)) s.payLinks.push({ url: str(o.url), at })
        break
      }
      case 'crm_invoice_doc': {
        if (!o || !str(o.id)) break
        let per = invoiceDocs.get(s.id)
        if (!per) { per = new Map(); invoiceDocs.set(s.id, per) }
        per.set(str(o.id), { o, at: per.get(str(o.id))?.at ?? at })
        break
      }
    }
  }

  for (const [id, per] of invoiceDocs) {
    const s = byId.get(id)
    if (!s) continue
    for (const { o, at } of per.values()) {
      if (o.deleted === true) continue
      s.invoices.push({ number: str(o.number), total: invoiceTotal(o), currency: str(o.currency) || 'USD', at })
    }
  }

  // ── merge on site + email (the pipeline's rule) ──
  const merged = new Map<string, LeadState>()
  const loose: LeadState[] = []
  for (const s of byId.values()) {
    s.customer.sort((a, b) => a.at.localeCompare(b.at))
    if (!s.email) { loose.push(s); continue }
    const key = `${s.siteId}|${s.email}`
    const prev = merged.get(key)
    merged.set(key, prev ? mergeStates(prev, s) : s)
  }
  const out = [...merged.values(), ...loose]
  for (const s of out) {
    s.restricted = restrictedReason([s.leadText, ...s.customer.map((c) => c.text)].join('\n'))
    if (!s.owner && s.lastOurBy) s.owner = s.lastOurBy
  }
  return out
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a <= b ? a : b
}

function mergeStates(a: LeadState, b: LeadState): LeadState {
  const furthest = CRM_STAGES.indexOf(a.stage) >= CRM_STAGES.indexOf(b.stage) ? a : b
  const busier = (a.lastOurAt ?? a.createdAt) >= (b.lastOurAt ?? b.createdAt) ? a : b
  const earlier = a.createdAt <= b.createdAt ? a : b
  const open = CRM_STAGES.indexOf(a.stage) === CRM_STAGES.indexOf(b.stage) ? busier : furthest
  const lastOur = (a.lastOurAt ?? '') >= (b.lastOurAt ?? '') ? a : b
  return {
    ...earlier,
    id: open.id,
    ids: [...a.ids, ...b.ids],
    name: earlier.name || a.name || b.name,
    stage: furthest.stage,
    stageAt: furthest.stageAt,
    owner: a.owner ?? b.owner,
    ownerEmail: a.ownerEmail ?? b.ownerEmail,
    lastOurAt: lastOur.lastOurAt,
    lastOurBy: lastOur.lastOurBy,
    humanAt: minIso(a.humanAt, b.humanAt),
    customer: [...a.customer, ...b.customer].sort((x, y) => x.at.localeCompare(y.at)),
    quote: !a.quote ? b.quote : !b.quote ? a.quote : a.quote.at >= b.quote.at ? a.quote : b.quote,
    quoteSentAt: minIso(a.quoteSentAt, b.quoteSentAt),
    estimated: a.estimated ?? b.estimated,
    payLinks: [...a.payLinks, ...b.payLinks],
    invoices: [...a.invoices, ...b.invoices],
    restricted: null,
    leadText: [a.leadText, b.leadText].filter(Boolean).join('\n'),
  }
}

// ── Classifying a customer ──────────────────────────────────────────────────

export interface HotReading {
  hot: boolean
  /** 0–100, for ordering only. */
  score: number
  signal: Signal
  /** The customer's latest line after the quote. */
  lastLine: string
  lastLineAt: string | null
  /** Why it is not hot, when it is not — used by the backtest report. */
  why: string
}

/** How recent the customer's last reply must be for a deal to count as hot. */
export const HOT_WINDOW_DAYS = 14
/** Points a deal needs to be called hot — tuned on the Sep/Oct backtest. */
export const HOT_THRESHOLD = 55

/**
 * Is this a deal that can close now?
 *
 * A price went out (a quote amount in our own words, or the stage says so),
 * and the customer answered it — recently, with buying signals, and without a
 * "no" after. Read only over messages AFTER the quote: a customer's "how much
 * for 500?" before any price is an enquiry, not a sign the price landed.
 *
 * Points, so that one weak hint ("can I get a sample?") is not enough on its
 * own but several together are:
 *   a decision (proceed / invoice / approval / shipping details)   40 each kind
 *   interest (sample, artwork, turnaround, price, quantity, "great") 15 each kind
 *   every reply after the quote                                     5, up to 15
 *   last reply within 3 / 7 / 14 days                               15 / 10 / 5
 * A negative anywhere resets everything before it; a negative as the latest
 * word kills the deal outright.
 */
export function readHot(s: LeadState, now: Date, opts: { threshold?: number; windowDays?: number } = {}): HotReading {
  const threshold = opts.threshold ?? HOT_THRESHOLD
  const windowDays = opts.windowDays ?? HOT_WINDOW_DAYS
  const none = (why: string): HotReading => ({ hot: false, score: 0, signal: { kind: 'none', reason: '' }, lastLine: '', lastLineAt: null, why })
  if (DEAD.has(s.stage)) return none(`stage ${s.stage}`)
  if (s.restricted) return none(`restricted: ${s.restricted}`)
  const quoteAt = s.quoteSentAt
  if (!quoteAt) return none('no quote sent')
  const after = s.customer.filter((c) => c.at > quoteAt)
  if (after.length === 0) return none('no reply after the quote')
  const last = after[after.length - 1]
  const age = (now.getTime() - new Date(last.at).getTime()) / DAY
  const lastSig = customerSignal(last.text)
  if (lastSig.kind === 'negative') return { ...none(`customer said: ${lastSig.reason}`), signal: lastSig, lastLine: last.text, lastLineAt: last.at }

  let strong = new Set<string>()
  let medium = new Set<string>()
  let replies = 0
  let best: Signal = { kind: 'none', reason: '' }
  for (const c of after) {
    const sig = customerSignal(c.text)
    if (sig.kind === 'negative') { strong = new Set(); medium = new Set(); replies = 0; best = { kind: 'none', reason: '' }; continue }
    replies++
    if (sig.kind === 'strong') { strong.add(sig.reason); best = sig }
    else if (sig.kind === 'medium') { medium.add(sig.reason); if (best.kind !== 'strong') best = sig }
  }
  const recency = age <= 3 ? 15 : age <= 7 ? 10 : age <= 14 ? 5 : 0
  const score = strong.size * 40 + medium.size * 15 + Math.min(15, replies * 5) + recency
  const recent = age <= windowDays
  const hot = recent && score >= threshold
  return {
    hot, score: Math.min(100, score), signal: best, lastLine: last.text, lastLineAt: last.at,
    why: hot ? '' : !recent ? `last reply ${Math.round(age)}d ago` : `score ${score} < ${threshold}`,
  }
}

export interface Waiting {
  hours: number
  since: string
  channel: 'email' | 'whatsapp'
  lastLine: string
}

/** The customer wrote last and nobody has answered. */
export function readWaiting(s: LeadState, now: Date, maxDays = 14): Waiting | null {
  // A won customer asking for tracking is still waiting on us; a lost one is not.
  if (s.stage === 'duplicate' || s.stage === 'manufacturer' || s.stage === 'lost' || s.stage === 'not_interested') return null
  // An alcohol / religious order still appears here, marked "decline" by the
  // page, so somebody sends the polite no instead of leaving it unanswered.
  const last = s.customer[s.customer.length - 1]
  if (!last) return null
  if (s.lastOurAt && s.lastOurAt >= last.at) return null
  const hours = (now.getTime() - new Date(last.at).getTime()) / 3_600_000
  if (hours > maxDays * 24) return null
  if (customerSignal(last.text).kind === 'negative') return null
  return { hours: Math.max(0, Math.round(hours * 10) / 10), since: last.at, channel: last.channel, lastLine: last.text }
}

export interface NoHuman { hours: number; since: string }

/** Stages a person moves a lead into; the bot only ever sets 'contacted'. */
const UNTOUCHED_STAGES: ReadonlySet<CrmStage> = new Set<CrmStage>(['new', 'contacted'])
export const NO_HUMAN_MAX_DAYS = 14

/**
 * A new lead nobody has answered IN PERSON. The quote bot's email (or the chat
 * bot) makes readWaiting() think we replied — that is how Dylan's Candy Bar and
 * Always Mettle sat for days with only the bot's words (owner, 2026-10-22).
 * Counts from the lead's arrival; any reply by a person, or a stage a person
 * set (quote sent, won, lost...), ends it.
 */
export function readNoHuman(s: LeadState, now: Date, maxDays = NO_HUMAN_MAX_DAYS): NoHuman | null {
  if (s.humanAt) return null
  if (!UNTOUCHED_STAGES.has(s.stage)) return null
  if (s.restricted) return null
  const hours = (now.getTime() - new Date(s.createdAt).getTime()) / 3_600_000
  if (hours < 0 || hours > maxDays * 24) return null
  if (!s.email && s.customer.length === 0 && !s.leadText.trim()) return null
  return { hours: Math.round(hours * 10) / 10, since: s.createdAt }
}

export interface InvoiceDue {
  label: string
  amount: number | null
  currency: string
  sentAt: string
  /** Matched to a sale that is not fully paid yet. */
  saleId: string | null
  outstanding: number | null
  /** The customer wrote that they paid — record it in Sales. */
  customerSaysPaid: boolean
  /** The board says Won but no sale is in the ledger. */
  wonNoSale: boolean
}

const PAID_CLAIM = /^\s*(just )?paid\b|\b(i|we)('ve| have)? (just |already )?(paid|made (the )?payment|sent (the )?payment)|\bpayment (has been |is )?(made|sent|done|completed)\b|\bpaid (the |your )?invoice\b/i

/**
 * Invoice or payment link out, and no paid sale behind it.
 *
 * A sale matches when it is linked to any of this customer's records, or its
 * reference / notes name the PayPal invoice code. A matched sale that is paid
 * closes it; one that is partial leaves the outstanding balance due.
 */
export function readInvoiceDue(s: LeadState, sales: OppSale[], now: Date, maxDays = 75): InvoiceDue | null {
  const cutoff = new Date(now.getTime() - maxDays * DAY).toISOString()
  const links = s.payLinks.filter((p) => p.at >= cutoff)
  const docs = s.invoices.filter((i) => i.at >= cutoff)
  if (links.length === 0 && docs.length === 0) return null
  if (s.stage === 'lost' || s.stage === 'not_interested' || s.stage === 'duplicate' || s.stage === 'manufacturer') return null
  if (s.restricted) return null

  // Only the LATEST invoice or link decides. A repeat customer's earlier
  // order being paid says nothing about the new one (Copper Key, 2026-10-22:
  // TWP-014 paid on the same lead hid the unpaid TWP-025 / PayPal 0013).
  const latestLink = [...links].sort((a, b) => b.at.localeCompare(a.at))[0]
  const latestDoc = [...docs].sort((a, b) => b.at.localeCompare(a.at))[0]
  const anchor = [latestLink?.at, latestDoc?.at].filter((x): x is string => !!x).sort().reverse()[0]
  // A link pasted for an invoice a day or two after it was made is the same bill.
  const anchorDay = new Date(new Date(anchor).getTime() - 3 * DAY).toISOString().slice(0, 10)
  const codes = links.filter((p) => p.at >= anchorDay).map((p) => paypalInvoiceCode(p.url)).filter((c): c is string => !!c)
  const numbers = docs.filter((d) => d.at >= anchorDay).map((d) => d.number.toUpperCase()).filter(Boolean)
  const firstSent = [...links.map((l) => l.at), ...docs.map((d) => d.at)].sort()[0]
  const ids = new Set(s.ids)
  const matches = sales.filter((sale) => {
    const hay = `${sale.reference} ${sale.notes}`.toUpperCase()
    if (codes.some((c) => hay.includes(c))) return true
    // An invoice number alone repeats across sites and years (SCB-021 is two
    // different customers), so it only counts with a date on the right side.
    if (numbers.some((n) => hay.includes(n)) && sale.orderDate >= anchorDay) return true
    // Same lead: only a sale booked around or after the latest invoice.
    return !!sale.leadId && ids.has(sale.leadId) && sale.orderDate >= anchorDay
  })
  // Paid, refunded or cancelled — either way nothing is owed on it any more.
  if (matches.some((m) => m.status === 'paid' || m.status === 'refunded' || m.status === 'cancelled')) return null
  const partial = matches.find((m) => m.status === 'partial' || m.status === 'pending') ?? null

  const doc = docs.sort((a, b) => b.at.localeCompare(a.at))[0]
  const link = links.sort((a, b) => b.at.localeCompare(a.at))[0]
  const sentAt = [doc?.at, link?.at].filter((x): x is string => !!x).sort().reverse()[0]
  const lastCustomer = s.customer.filter((c) => c.at >= firstSent)
  const customerSaysPaid = lastCustomer.some((c) => PAID_CLAIM.test(c.text))
  const code = link ? paypalInvoiceCode(link.url) : null
  return {
    label: doc?.number ? `Invoice ${doc.number}` : code ? `PayPal invoice ${code}` : 'Payment link',
    amount: partial ? partial.outstanding : doc?.total || s.quote?.amount || s.estimated || null,
    currency: doc?.currency || 'USD',
    sentAt,
    saleId: partial?.id ?? null,
    outstanding: partial ? partial.outstanding : null,
    customerSaysPaid,
    wonNoSale: s.stage === 'won' && matches.length === 0,
  }
}

/** Created before this month, still open, the customer engaged — worth a revive. */
export function readOlder(s: LeadState, monthStart: string): { lastCustomerAt: string; lastLine: string } | null {
  if (s.createdAt >= monthStart) return null
  if (DEAD.has(s.stage)) return null
  if (s.restricted) return null
  const last = s.customer[s.customer.length - 1]
  if (!last) return null
  if (customerSignal(last.text).kind === 'negative') return null
  return { lastCustomerAt: last.at, lastLine: last.text }
}

export function isDeadStage(stage: CrmStage): boolean {
  return DEAD.has(stage)
}

/** One-line preview of what somebody wrote. */
export function oneLine(text: string, limit = 220): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}
