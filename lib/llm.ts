// WHICH MODEL ANSWERS — one place, so the rest of the app never names a vendor.
//
// The bot ran on Groq's free tier, and that tier is how it once broke in the
// worst possible way: Groq retired the pinned model id without notice, the 404
// was swallowed, and every visitor on every site got "I'm having trouble
// responding right now" for an unknown length of time. Nothing alerted, because
// from the app's side a model that no longer exists looks exactly like a model
// having a bad minute.
//
// So the arrangement here is deliberate:
//
//   • ANTHROPIC_API_KEY set  → Claude answers. That is the paid, primary model.
//   • Claude errors or times out → Groq answers that one request, and the
//     failure is logged loudly. A slower reply beats an apology string.
//   • No ANTHROPIC_API_KEY   → Groq answers, exactly as before. Adding the key
//     is the whole switch-over; removing it is the whole way back.
//
// Anthropic is called over plain HTTP rather than through its SDK: the request
// is a dozen lines, and a dependency that moves on its own schedule is the
// thing that broke this before.
import Groq from 'groq-sdk'

export type LlmMessage = { role: 'user' | 'assistant'; content: string }

export interface LlmResult {
  text: string
  /** Which provider actually answered — logged, and shown on the admin check. */
  provider: 'anthropic' | 'groq' | 'none'
  model: string
  /** True when NOTHING answered: the caller shows its own apology string. */
  error: boolean
  /** Set when the primary failed and the fallback was used. */
  fellBack?: string
}

// Haiku for the chat bubble: a visitor watching a typing dot notices a second,
// and the widget's answers are short by design. The heavier work (quotes,
// follow-up drafts, reading documents) belongs on Sonnet and will pass
// `model` explicitly rather than changing this default.
export const CLAUDE_CHAT_MODEL = process.env.ANTHROPIC_CHAT_MODEL || 'claude-haiku-4-5-20251001'
export const CLAUDE_WORK_MODEL = process.env.ANTHROPIC_WORK_MODEL || 'claude-sonnet-5'

const GROQ_MODEL = 'openai/gpt-oss-120b'

let _groq: Groq | null = null
function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY! })
  return _groq
}

export function anthropicReady(): boolean {
  return !!process.env.ANTHROPIC_API_KEY
}

/** What is actually answering right now — for the admin check, not for logic. */
export function llmStatus(): { primary: 'anthropic' | 'groq'; chatModel: string; fallback: string | null } {
  return anthropicReady()
    ? { primary: 'anthropic', chatModel: CLAUDE_CHAT_MODEL, fallback: process.env.GROQ_API_KEY ? GROQ_MODEL : null }
    : { primary: 'groq', chatModel: GROQ_MODEL, fallback: null }
}

interface CompleteOpts {
  system: string
  messages: LlmMessage[]
  maxTokens: number
  temperature?: number
  /** Override the Claude model — CLAUDE_WORK_MODEL for anything that thinks. */
  model?: string
  /** Hard stop, so a hanging provider cannot hold a visitor's reply open. */
  timeoutMs?: number
  /**
   * A LOWER ceiling for Claude, and the reason the two differ.
   *
   * `maxTokens` has to be generous for Groq because gpt-oss is a reasoning
   * model: its thinking is billed against the ceiling although the visitor
   * never sees it, so a 45-word answer needs hundreds of tokens of headroom.
   * Claude spends none of that, so the same number lets it write six times
   * what was asked for. The prompt asks for at most 45 words; this makes that
   * a limit rather than a request.
   */
  anthropicMaxTokens?: number
}

async function callAnthropic(o: CompleteOpts): Promise<{ text: string; model: string; stopReason: string }> {
  const model = o.model || CLAUDE_CHAT_MODEL
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: o.anthropicMaxTokens ?? o.maxTokens,
      temperature: o.temperature ?? 0.7,
      system: o.system,
      messages: o.messages,
    }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 20000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`)
  }
  const j = await res.json()
  const text = (Array.isArray(j?.content) ? j.content : [])
    .filter((p: { type?: string }) => p?.type === 'text')
    .map((p: { text?: string }) => p.text ?? '')
    .join('')
  return { text, model, stopReason: String(j?.stop_reason ?? '') }
}

async function callGroq(o: CompleteOpts): Promise<{ text: string; model: string; stopReason: string }> {
  const completion = await getGroq().chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: 'system', content: o.system }, ...o.messages],
    temperature: o.temperature ?? 0.7,
    max_tokens: o.maxTokens,
    reasoning_effort: 'low',
  })
  const choice = completion.choices[0]
  return {
    text: choice?.message?.content ?? '',
    model: GROQ_MODEL,
    stopReason: String(choice?.finish_reason ?? ''),
  }
}

/**
 * One completion, from whichever provider is configured and working.
 *
 * `stopReason` is returned raw because the two vendors name the same thing
 * differently — Anthropic says `max_tokens`, Groq says `length` — and the
 * caller that trims a cut-off sentence needs to know which happened.
 */
export async function llmComplete(o: CompleteOpts): Promise<LlmResult & { stopReason: string }> {
  if (anthropicReady()) {
    try {
      const r = await callAnthropic(o)
      return { ...r, provider: 'anthropic', error: false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // LOUD on purpose. The silent version of this line is what let a dead
      // model run for days.
      console.error(`[llm] Claude FAILED (${o.model || CLAUDE_CHAT_MODEL}): ${msg}`)
      if (!process.env.GROQ_API_KEY) {
        return { text: '', provider: 'none', model: o.model || CLAUDE_CHAT_MODEL, error: true, stopReason: '' }
      }
      try {
        const r = await callGroq(o)
        console.warn('[llm] answered from the Groq fallback instead')
        return { ...r, provider: 'groq', error: false, fellBack: msg }
      } catch (err2) {
        console.error(`[llm] Groq fallback FAILED too: ${err2 instanceof Error ? err2.message : String(err2)}`)
        return { text: '', provider: 'none', model: GROQ_MODEL, error: true, stopReason: '' }
      }
    }
  }

  try {
    const r = await callGroq(o)
    return { ...r, provider: 'groq', error: false }
  } catch (err) {
    console.error(`[llm] Groq FAILED model=${GROQ_MODEL}: ${err instanceof Error ? err.message : String(err)}`)
    return { text: '', provider: 'none', model: GROQ_MODEL, error: true, stopReason: '' }
  }
}

/** Did the model stop because it hit the ceiling, whichever vendor answered? */
export function wasCutOff(stopReason: string): boolean {
  return stopReason === 'length' || stopReason === 'max_tokens'
}
