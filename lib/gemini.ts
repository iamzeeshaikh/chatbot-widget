import { GoogleGenerativeAI } from '@google/generative-ai'

// Models tried in order — first success wins
const MODELS = ['gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.0-pro']

const RATE_LIMIT_FALLBACK = 'Our team has received your message and will respond shortly. Please leave your contact details below.'

let _genAI: GoogleGenerativeAI | null = null

function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  return _genAI
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function buildHistory(messages: { role: string; content: string }[]) {
  const clean = messages.filter((m) => m.content && m.content !== '(session started)')
  const rawHistory = clean.slice(0, -1).map((m) => ({
    role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model',
    parts: [{ text: m.content }],
  }))
  const history: typeof rawHistory = []
  for (const msg of rawHistory) {
    if (history.length === 0) {
      if (msg.role === 'user') history.push(msg)
    } else if (msg.role !== history[history.length - 1].role) {
      history.push(msg)
    }
  }
  return { clean, history, lastMessage: clean[clean.length - 1]?.content ?? '' }
}

// Try each model in MODELS order, with 1s backoff between attempts
async function tryModels<T>(
  fn: (modelName: string) => Promise<T>,
  label: string
): Promise<T> {
  let lastErr: unknown
  for (const modelName of MODELS) {
    try {
      console.log(`[Gemini] ${label} trying model=${modelName}`)
      const result = await fn(modelName)
      console.log(`[Gemini] ${label} succeeded with model=${modelName}`)
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[Gemini] ${label} model=${modelName} FAILED: ${msg}`)
      console.error('[Gemini] full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
      lastErr = err
      await sleep(1000)
    }
  }
  throw lastErr
}

export async function generateReply(
  systemPrompt: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const { clean, history, lastMessage } = buildHistory(messages)
  if (clean.length === 0 || !lastMessage) return 'Hello! How can I help you today?'

  console.log(`[Gemini] generateReply history=${history.length} prompt="${lastMessage.slice(0, 80)}"`)

  try {
    return await tryModels(async (modelName) => {
      const model = getGenAI().getGenerativeModel({ model: modelName, systemInstruction: systemPrompt })
      const chat = model.startChat({ history })
      const result = await chat.sendMessage(lastMessage)
      const text = result.response.text()
      console.log(`[Gemini] reply: "${text.slice(0, 120)}"`)
      return text
    }, 'generateReply')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Gemini] generateReply ALL models failed. Last error: ${msg}`)
    return RATE_LIMIT_FALLBACK
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

export async function* streamReply(
  systemPrompt: string,
  messages: { role: string; content: string }[]
): AsyncGenerator<string, void, unknown> {
  const { clean, history, lastMessage } = buildHistory(messages)
  if (clean.length === 0 || !lastMessage) {
    yield 'Hello! How can I help you today?'
    return
  }

  console.log(`[Gemini] streamReply history=${history.length} prompt="${lastMessage.slice(0, 80)}"`)

  // Try each model in order for streaming
  let lastErr: unknown
  for (const modelName of MODELS) {
    try {
      console.log(`[Gemini] streamReply trying model=${modelName}`)
      const model = getGenAI().getGenerativeModel({ model: modelName, systemInstruction: systemPrompt })
      const chat = model.startChat({ history })
      const result = await chat.sendMessageStream(lastMessage)
      for await (const chunk of result.stream) {
        const text = chunk.text()
        if (text) yield text
      }
      console.log(`[Gemini] streamReply done with model=${modelName}`)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[Gemini] streamReply model=${modelName} FAILED: ${msg}`)
      console.error('[Gemini] full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
      lastErr = err
      await sleep(1000)
    }
  }
  throw lastErr
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

    const prompt = `Extract lead qualification data from this sales conversation.
Return ONLY valid JSON (no markdown, no explanation) with these exact keys, use null for fields not clearly mentioned:
{"name":null,"email":null,"phone":null,"product":null,"quantity":null,"budget":null,"timeline":null}

Conversation:
${convo}`

    return await tryModels(async (modelName) => {
      const model = getGenAI().getGenerativeModel({ model: modelName })
      const result = await model.generateContent(prompt)
      const text = result.response.text().trim()
      const jsonMatch = text.match(/\{[\s\S]*?\}/)
      if (!jsonMatch) throw new Error('No JSON in response')
      const parsed = JSON.parse(jsonMatch[0])
      return {
        name: parsed.name || null, email: parsed.email || null,
        phone: parsed.phone || null, product: parsed.product || null,
        quantity: parsed.quantity || null, budget: parsed.budget || null,
        timeline: parsed.timeline || null,
      }
    }, 'extractLeadFields')
  } catch { /* non-fatal */ }
  return empty
}
