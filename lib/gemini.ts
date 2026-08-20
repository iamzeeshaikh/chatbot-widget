import Groq from 'groq-sdk'

// Groq retires model ids without warning, and the app fails SILENTLY when that
// happens: the 404 is caught and every visitor gets "I'm having trouble
// responding right now" instead. `llama-3.1-8b-instant`, pinned here since the
// beginning, had been dead for some unknown time when it was found on
// 2026-08-20 — every bot reply on every site was that error string.
// /api/admin/groq-models (admin only) lists what this key can actually call and
// will run a sample answer through a candidate; check it FIRST if the bot ever
// starts apologising to everyone.
const MODEL = 'openai/gpt-oss-120b'

// gpt-oss is a reasoning model: its thinking tokens are billed against
// max_tokens even though they never reach the visitor, which is why a 25-word
// answer came back finish_reason=length at a 220-token ceiling. 'low' keeps
// that overhead to a few dozen tokens and answers land in ~250-500ms.
const REASONING_EFFORT = 'low' as const

const ERROR_REPLY = "I'm having trouble responding right now, please try again in a moment."

// Ceiling for a visitor-facing reply, thinking tokens included. ~45 words is the
// target set in the prompt below; this leaves headroom for the model's reasoning
// plus a longer-but-legitimate answer, while making a runaway essay impossible.
const REPLY_MAX_TOKENS = 600

// Cut a truncated reply back to its last complete sentence. Returns the input
// unchanged when there is no sentence end to cut back to (a single long
// fragment), because a fragment still reads better than an empty bubble.
export function trimToLastSentence(text: string): string {
  const t = (text ?? '').trim()
  if (!t) return t
  const lastEnd = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '), t.lastIndexOf('.'), t.lastIndexOf('!'), t.lastIndexOf('?'))
  if (lastEnd < 0) return t
  const cut = t.slice(0, lastEnd + 1).trim()
  return cut.length >= 20 ? cut : t
}

let _groq: Groq | null = null

function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
  return _groq
}

type GroqMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// Shared consultative behaviour layered onto EVERY site (and any future site) on
// top of that site's own product knowledge. This is what makes the bot act like
// a real sales assistant instead of a form-pusher.
const CONSULTATIVE_STYLE = `

— HOW TO ASSIST —
You are a friendly, knowledgeable sales consultant having a natural conversation. You are NOT a form.
- Answer the customer's question using the product knowledge above. If you genuinely don't know a detail, say a specialist will confirm — never make up facts.
- Recommend the best product(s) for what the customer describes, and ask relevant follow-up questions to understand their needs.
- Be consultative and genuinely helpful, never pushy.
- Understand details (what they need, quantity, colors/branding or specs, timeline) gradually through the chat — one thing at a time, only when it fits naturally. Never interrogate or send a numbered list of questions.
- Help the customer first; do NOT demand contact details before being useful.
- When there is genuine buying interest, ask for contact details conversationally, e.g. "I'd love to put together a quote for you — what's the best email to send it to?" Ask for name, email and phone one at a time, not all at once.

— HOW LONG (this is a rule, not a preference) —
This is a chat bubble on a phone, not an email. A long reply gets skimmed and abandoned; a short one gets answered.
- HARD LIMIT: at most 45 words and at most 3 short sentences per reply. Shorter is better — one sentence is often the best answer.
- Never write a paragraph, an essay, a summary of what the customer said, or a recap of what you already told them.
- No bullet lists, no numbered lists and no headings, unless the customer explicitly asks to compare options — then at most 3 bullets of 6 words each.
- Say ONE thing, then ask at most ONE short question. Never ask two questions in the same reply.
- Do not repeat the company name, the greeting, or an offer to help in every message. Do not pad with filler like "Great question!" or "I'd be happy to help with that!" — answer instead.
- If a full answer genuinely needs more room, give the one-line version and offer the detail: "Want me to break that down?"

— WHAT YOU MUST NEVER INVENT —
Everything you state must come from the knowledge above. It is better to say "a specialist will confirm that" than to be wrong.
- Never state a number — price, minimum order, lead time, size, weight, material spec — that is not written above.
- Never calculate or estimate a TOTAL for an order, and never quote a discount. Give the published per-unit figure if there is one, say it is indicative, and offer a written quotation.
- Never promise a delivery date, a certification, a material claim or a stock level.
- Never invent an email address, phone number, website or office location, and never name another company.`

function buildGroqMessages(
  systemPrompt: string,
  messages: { role: string; content: string }[]
): GroqMessage[] | null {
  const clean = messages.filter((m) => m.content && m.content !== '(session started)')
  if (clean.length === 0) return null

  // Deduplicate consecutive same-role messages; ensure history starts with user
  const deduped: { role: string; content: string }[] = []
  for (const msg of clean) {
    if (deduped.length === 0) {
      if (msg.role === 'user') deduped.push(msg)
    } else if (msg.role !== deduped[deduped.length - 1].role) {
      deduped.push(msg)
    }
  }
  if (deduped.length === 0) return null

  const result: GroqMessage[] = [{ role: 'system', content: systemPrompt }]
  for (const msg of deduped) {
    result.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    })
  }
  return result
}

export async function generateReply(
  systemPrompt: string,
  messages: { role: string; content: string }[]
): Promise<{ text: string; error: boolean }> {
  const groqMessages = buildGroqMessages(systemPrompt + CONSULTATIVE_STYLE, messages)
  if (!groqMessages) return { text: 'Hello! How can I help you today?', error: false }

  const lastMsg = groqMessages[groqMessages.length - 1]
  console.log(`[Groq] generateReply model=${MODEL} msgs=${groqMessages.length} prompt="${lastMsg.content.slice(0, 80)}"`)

  try {
    const completion = await getGroq().chat.completions.create({
      model: MODEL,
      messages: groqMessages,
      temperature: 0.7,
      // A ceiling, not the target: the prompt asks for <=45 words (~60 tokens),
      // so this only catches a runaway. 1024 used to let the model deliver a
      // six-paragraph essay into a phone-sized chat bubble.
      max_tokens: REPLY_MAX_TOKENS,
      reasoning_effort: REASONING_EFFORT,
    })
    const choice = completion.choices[0]
    const raw = choice?.message?.content ?? ''
    // Hitting the ceiling means the model was cut off mid-word. Never show that
    // — fall back to the last complete sentence instead of a dangling fragment.
    const text = choice?.finish_reason === 'length' ? trimToLastSentence(raw) : raw
    console.log(`[Groq] reply: finish=${choice?.finish_reason} words=${raw.trim().split(/\s+/).length} "${text.slice(0, 120)}"`)
    return { text, error: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Groq] generateReply FAILED model=${MODEL}: ${msg}`)
    console.error('[Groq] full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
    return { text: ERROR_REPLY, error: true }
  }
}

// One-off sample completion against an arbitrary model id, used by the
// admin-only /api/admin/groq-models?try= check. Same style block and same
// ceiling as the live bot, so what it prints is what a visitor would get.
export async function sampleReply(
  model: string,
  systemPrompt: string,
  question: string,
  opts: { maxTokens?: number; effort?: string } = {}
): Promise<{ text: string; finish?: string; error?: string; usage?: unknown }> {
  try {
    const completion = await getGroq().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt + CONSULTATIVE_STYLE },
        { role: 'user', content: question },
      ],
      temperature: 0.7,
      max_tokens: opts.maxTokens ?? REPLY_MAX_TOKENS,
      // Reasoning models (gpt-oss) spend part of the token budget thinking, and
      // those tokens count against max_tokens — which is why a 20-word answer
      // can still come back finish_reason=length. 'low' keeps that overhead
      // small; the API ignores the field for models that don't reason.
      ...(opts.effort ? { reasoning_effort: opts.effort as 'low' | 'medium' | 'high' } : {}),
    })
    const choice = completion.choices[0]
    const raw = choice?.message?.content ?? ''
    return {
      text: choice?.finish_reason === 'length' ? trimToLastSentence(raw) : raw,
      finish: choice?.finish_reason,
      usage: completion.usage,
    }
  } catch (err) {
    return { text: '', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Translation (agent dashboard) ───────────────────────────────────────────
// All translation runs server-side through the already-integrated Groq LLM, so
// no new API/key/cost is introduced. analyzeMessages does detection AND
// translation-to-English in a single batched call; translateText handles the
// reverse (English → the visitor's language) for outgoing replies.

export interface MsgAnalysis {
  langName: string   // English name of the detected language, e.g. "German"
  isEnglish: boolean
  english: string    // English translation (or the original if already English)
}

// Detect language + translate to English for a batch of messages in ONE call.
// Returns one analysis per input, in order. On any failure it degrades to
// "treat as English" so the UI simply shows the original with no indicator.
export async function analyzeMessages(texts: string[]): Promise<MsgAnalysis[]> {
  const fallback = (t: string): MsgAnalysis => ({ langName: '', isEnglish: true, english: t })
  const clean = texts.map((t) => (t ?? '').slice(0, 800))
  if (clean.length === 0) return []
  try {
    const numbered = clean.map((t, i) => `${i + 1}. ${t.replace(/\n/g, ' ')}`).join('\n')
    const completion = await getGroq().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a precise language detection and translation engine. You reply with ONLY valid JSON — no markdown, no commentary.' },
        {
          role: 'user',
          content: `For each numbered message, detect its language and translate it to English. Return ONLY a JSON array; item i corresponds to message i, with exactly these keys: {"lang":"<English name of the language, e.g. German>","isEnglish":<true if the message is English, else false>,"english":"<the English translation; if already English, repeat it unchanged>"}.\n\nMessages:\n${numbered}`,
        },
      ],
      temperature: 0,
      max_tokens: 2048,
      reasoning_effort: REASONING_EFFORT,
    })
    const text = (completion.choices[0]?.message?.content ?? '').trim()
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) throw new Error('No JSON array in response')
    const parsed = JSON.parse(match[0]) as { lang?: string; isEnglish?: boolean; english?: string }[]
    return clean.map((t, i) => {
      const r = parsed[i]
      if (!r) return fallback(t)
      const isEnglish = r.isEnglish !== false && (!r.lang || /^english$/i.test(r.lang))
      return {
        langName: isEnglish ? '' : (r.lang || 'Unknown'),
        isEnglish,
        english: typeof r.english === 'string' && r.english.trim() ? r.english : t,
      }
    })
  } catch (err) {
    console.error('[Groq] analyzeMessages failed:', err instanceof Error ? err.message : err)
    return clean.map(fallback)
  }
}

// Translate English (an agent's reply) into the target language. Returns the
// original text unchanged on failure so a reply is never lost.
export async function translateText(text: string, targetLang: string): Promise<string> {
  const input = (text ?? '').trim()
  if (!input || !targetLang) return input
  try {
    const completion = await getGroq().chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are a professional translator. You output ONLY the translated text — no quotes, no notes, no explanations.' },
        { role: 'user', content: `Translate the following message into ${targetLang}. Preserve tone and meaning. Output only the translation.\n\n${input}` },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      reasoning_effort: REASONING_EFFORT,
    })
    return (completion.choices[0]?.message?.content ?? '').trim() || input
  } catch (err) {
    console.error('[Groq] translateText failed:', err instanceof Error ? err.message : err)
    return input
  }
}

export interface LeadFields {
  name: string | null
  email: string | null
  phone: string | null
  product: string | null
  quantity: string | null
  budget: string | null
  timeline: string | null
}

export async function extractLeadFields(
  messages: { role: string; content: string }[]
): Promise<LeadFields> {
  const empty: LeadFields = { name: null, email: null, phone: null, product: null, quantity: null, budget: null, timeline: null }
  try {
    const convo = messages
      .filter((m) => m.content && m.content !== '(session started)')
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
      .join('\n')

    const completion = await getGroq().chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'You extract lead data from sales conversations. Return ONLY valid JSON, no markdown.',
        },
        {
          role: 'user',
          content: `Extract lead qualification data. Return ONLY valid JSON with these exact keys, use null for fields not mentioned:\n{"name":null,"email":null,"phone":null,"product":null,"quantity":null,"budget":null,"timeline":null}\n\nConversation:\n${convo}`,
        },
      ],
      temperature: 0,
      // 256 was sized before the model reasoned: thinking tokens come out of the
      // same budget and would truncate the JSON, losing the lead's fields.
      max_tokens: 768,
      reasoning_effort: REASONING_EFFORT,
    })
    const text = (completion.choices[0]?.message?.content ?? '').trim()
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (!jsonMatch) throw new Error('No JSON in response')
    const parsed = JSON.parse(jsonMatch[0])
    return {
      name: parsed.name || null, email: parsed.email || null,
      phone: parsed.phone || null, product: parsed.product || null,
      quantity: parsed.quantity || null, budget: parsed.budget || null,
      timeline: parsed.timeline || null,
    }
  } catch { /* non-fatal */ }
  return empty
}
