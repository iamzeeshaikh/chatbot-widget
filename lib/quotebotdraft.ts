// The bot's email, written for THIS customer.
//
// Until 2026-10-15 the bot sent one of two fixed paragraphs with the product
// name swapped in: "Thank you so much for reaching out… I have everything I
// need, and the price quote for your X is in process." Mike Ma described a
// PDQ display for 20 sachets, Nathan asked whether the box bottom could be
// printed, Emily asked whether she could buy lids on their own — and each got
// the same two lines back. Steve: "bot har customer ko same generic reply kiye
// jaa rha hai". The owner's answer was to fix the reply, not switch it off.
//
// So the body is now drafted by the model from what the customer actually
// wrote, in the agents' own voice (docs/bot-voice.md), under hard limits:
// their specifics only, every question they asked acknowledged, nothing
// invented, no price, no date, and only the questions the assessment says are
// still open. Anything that fails those checks falls back to the template —
// a dull email beats a wrong one.

import { llmComplete, CLAUDE_WORK_MODEL, CLAUDE_CHAT_MODEL } from './llm'
import { missingOf, type QuoteAssessment, type Missing } from './quotebotcore'

export interface DraftInput {
  kind: 'first' | 'reply'
  fromChat: boolean
  /** The enquiry as the customer wrote it (form fields, chat, or forwarded mail). */
  enquiry: string
  /** For 'reply': what we asked, then everything the customer has written since. */
  weAsked?: string
  replies?: string[]
  assessment: QuoteAssessment
  siteName: string
}

const SYSTEM = `You write the first short email a sales agent at a custom packaging company sends back to a customer's quote enquiry. Write ONLY the email body, plain text, no subject line and no signature.

Voice — this is how our agents actually write (keep it):
- Start "Hello {FirstName}," or "Hello," when no name is given. Never guess or invent a name.
- Opening line, exactly: "Thank you so much for reaching out with your request!" — or, when the enquiry came from a website chat, "Thank you so much for your time over the chat!"
- End with "Looking forward to hearing from you." then "Warm regards," on its own line. Nothing after it.
- 55–120 words. 3–4 short paragraphs of 1–3 sentences. US spelling. "price quote", never "estimate". "I" for the agent, "we" for the company. One exclamation mark in total (the opening). No emojis, no bullet lists unless listing 3+ items the customer gave.

Content rules — the point of this email is that it is about THEM:
1. Second paragraph restates in one or two sentences what they are after, in their own specifics: the product, the thing it holds, the size, the quantity, the colours, the event or use. Use only facts they stated. Do not pad with facts they did not give.
2. If they asked a direct question (can you print the bottom? can I buy lids only? do you ship to X? is this doable?), answer or acknowledge every one. You may state these facts only: we make everything from scratch to the customer's own size and design; free 2D and 3D mockups and free design support; free shipping to the doorstep; no extra or hidden charges; our minimum is usually 250 boxes per size or design (1,000 for cups and sleeves, 500 for mailers and bags) — mention the minimum ONLY if they asked about minimums or gave a quantity below it, and offer to check whether a smaller first run can be arranged. For anything else they asked, say you will confirm it with the production team and include it in the price quote. Never promise a specific capability beyond the list.
3. Then ask ONLY for what the brief marks as missing (listed under MISSING). Nothing else. If the brief says nothing is missing, say the price quote is in process and you will share it shortly, and — only if NO DEADLINE is given — ask how soon they need these.
4. Never write a price, a discount, a percentage, a turnaround time or a date. Never mention materials, finishes or printing options they did not bring up. Never say "I have everything I need" unless MISSING is empty.
5. If an attachment is mentioned, thank them for the image or file by name in passing.
6. If they gave a deadline, you may say "I've noted you need these by …" — never promise that we will deliver, ship or finish by it; the agent decides that with the price quote.
7. Never say "absolutely", "definitely", "guarantee" or "we can" about a specific request (printing a particular area, lids on their own, cutouts, a sample). Say "I'll confirm that with our production team and include it in the price quote."
8. Keep it under 120 words. Short beats complete.
9. If the brief has a SIZE CHECK line, the size they gave is beyond what we normally produce. Then NEVER say the price quote is in process or that you have everything you need. Say you have noted their size (quote it), that it is larger than what we usually make, and that you are checking with our production team whether it can be made at this size before coming back with the price quote. Do not suggest a different size or say it is impossible.

Examples of our agents' real emails (match the tone, not the facts):

"Hello Melissa,

Thank you so much for reaching out to us!

There will be four sizes: a 14oz straight-sided jar box, a 4oz tin box with an insert to hold 3, a single 6oz jar box with insert, and a double 6oz jar box with insert. Please let me know if this list is correct.

Our minimum for each size is 250, so kindly confirm the quantity you have in mind.

Warm regards,"

"Hello Zeesy,

Thank you so much for reaching out to us with your request!

Our minimum for round gift boxes is usually 250, but we can look at 100 to get you started. Please also confirm the height of the box so I can start working on the price quote.

I look forward to hearing from you.

Warm regards,"`

function brief(i: DraftInput): string {
  const a = i.assessment
  const missing = missingOf(a)
  const lines = [
    `SITE: ${i.siteName}`,
    `SOURCE: ${i.fromChat ? 'website chat' : 'quote form / email'}`,
    `FIRST NAME: ${a.firstName ?? '(unknown — use "Hello,")'}`,
    `PRODUCT (as we would name it): ${a.product}`,
    `MISSING: ${missing.length ? missing.map((m) => (m === 'size' ? `size — ask for the ${a.sizeLabel}` : `style — ask for the ${a.styleLabel} (a reference image works)`)).join('; ') : 'nothing'}`,
    `DEADLINE GIVEN: ${a.hasDeadline ? 'yes — do not ask' : 'no'}`,
    ...(a.oversize ? [`SIZE CHECK: ${a.oversize} is beyond what we normally produce — no price promise; say we are confirming with production whether it can be made`] : []),
    '',
    'THE CUSTOMER WROTE:',
    i.enquiry.trim().slice(0, 3500),
  ]
  if (i.kind === 'reply') {
    lines.push('', 'WE THEN ASKED THEM:', (i.weAsked ?? '').trim().slice(0, 800), '', 'THEY REPLIED:', ...(i.replies ?? []).map((r) => r.trim().slice(0, 1500)))
    lines.push('', 'This email answers their reply: thank them for the details they just gave (name them), then follow the rules above. Opening line for a reply: "Thank you for the details!" instead of the standard opening.')
  }
  return lines.join('\n')
}

/** Trailing name/signature lines and sign-off variants, tidied to the house close. */
export function normalise(raw: string): string {
  let t = raw.replace(/\r/g, '').replace(/^```[a-z]*\n?|```$/g, '').trim()
  const m = t.match(/\n(warm|best|kind) regards,?[^\n]*/i)
  if (m && m.index !== undefined) t = `${t.slice(0, m.index).trimEnd()}\n\nWarm regards,`
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

/** The checks a draft must pass before it goes to a customer. Reason, or null. */
export function draftProblem(text: string, a: QuoteAssessment, missing: Missing[]): string | null {
  const t = text.trim()
  const words = t.split(/\s+/).length
  if (words < 35 || words > 160) return `length ${words} words`
  if (!/^Hello\b/.test(t)) return 'no greeting'
  if (a.firstName && !t.startsWith(`Hello ${a.firstName},`)) return 'wrong or missing first name'
  if (!a.firstName && !/^Hello,/.test(t)) return 'invented a name'
  if (!/Warm regards,$/.test(t)) return 'no sign-off'
  if (/[$€£]|\bUSD\b|\d+\s?%|\bpercent\b/i.test(t)) return 'contains a price or percentage'
  // A turnaround is OUR promise ("ready in 2 weeks"). The customer's own
  // deadline echoed back ("I've noted you need these in 3 weeks") is allowed
  // by rule 6 — the sentence has to be about what THEY said.
  for (const sm of t.matchAll(/[^.!?\n]*\b\d+\s*(?:business\s+)?(?:days?|weeks?)\b[^.!?\n]*/gi)) {
    if (!/\byou(?:'d| would)? (?:need|mentioned|require|want|like|asked|said)|\bnoted\b|\byour (?:deadline|timeline|target)/i.test(sm[0])) return 'contains a turnaround'
  }
  // Their own deadline may be acknowledged ("I've noted you need these by
  // December 14"); what is forbidden is OUR promise against it. "2 1/2 x 6"
  // is a size, not a date, so there is no bare-date check.
  if (/\b(deliver|ship|arrive|dispatch|get (these|them|it) to you|have (these|them|it) (to|with|at) you|ready|complete|finish|done)[^.]{0,60}\b(by|before|in time for|ahead of)\b/i.test(t)) return 'promises delivery by a date'
  if (/\babsolutely\b|\bdefinitely\b|\bguarantee/i.test(t)) return 'over-promises'
  if (/https?:\/\//i.test(t)) return 'contains a link'
  if (/\bestimate\b/i.test(t)) return 'says estimate'
  if ((t.match(/!/g) ?? []).length > 1) return 'too many exclamation marks'
  if (missing.includes('size') && !/\bsize|dimension|measure/i.test(t)) return 'did not ask for the size'
  if (missing.includes('style') && !/\bstyle|type|shape|reference/i.test(t)) return 'did not ask for the style'
  if (a.oversize) {
    if (/in process|everything I need|is being prepared|working on (the|your) price/i.test(t)) return 'promised a price quote for an oversized request'
    if (!/production team|can be made|possible at|feasib|able to make|whether we can/i.test(t)) return 'oversized request but no production check mentioned'
    return null
  }
  if (!missing.length && !/price quote/i.test(t)) return 'complete brief but no mention of the price quote'
  if (!missing.length && !/process|shortly|work|get back|put .{0,12}together|prepar|ready|send|share|calculat|numbers/i.test(t)) return 'complete brief but no "quote in process"'
  if (missing.length && /everything I need/i.test(t)) return 'claims everything is in hand'
  return null
}

/**
 * A body written for this customer, or null when the model is down or its
 * draft fails the checks — the caller keeps the template in that case.
 */
export async function draftCustomerEmail(i: DraftInput): Promise<{ text: string; model: string } | null> {
  const missing = missingOf(i.assessment)
  const user = brief(i)
  // Two tries on the work model (the second told what was wrong with the
  // first), then one on the chat model. Temperature is left to the vendor
  // default: Claude 5 refuses the parameter.
  const attempts: { model: string; feedback?: string }[] = [{ model: CLAUDE_WORK_MODEL }, { model: CLAUDE_WORK_MODEL }, { model: CLAUDE_CHAT_MODEL }]
  let lastProblem: string | undefined
  for (const a of attempts) {
    const content = lastProblem ? `${user}\n\nYOUR PREVIOUS DRAFT WAS REJECTED: ${lastProblem}. Rewrite it following every rule.` : user
    const r = await llmComplete({
      system: SYSTEM, messages: [{ role: 'user', content }],
      maxTokens: 500, anthropicMaxTokens: 450, model: a.model, timeoutMs: 30000,
    })
    if (r.error || !r.text.trim()) continue
    const text = normalise(r.text)
    const problem = draftProblem(text, i.assessment, missing)
    if (!problem) return { text, model: r.model }
    lastProblem = problem
    console.warn(`[quotebot] draft from ${r.model} rejected: ${problem}`)
  }
  return null
}
