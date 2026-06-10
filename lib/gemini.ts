import { GoogleGenerativeAI } from '@google/generative-ai'

const GEMINI_MODEL = 'gemini-1.5-flash-8b' // higher free-tier limits (1500/day, 100/min)

const RATE_LIMIT_FALLBACK = 'Our team has received your message and will respond shortly. Please leave your contact details below.'

let _genAI: GoogleGenerativeAI | null = null

function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  return _genAI
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

// Exponential backoff retry: delays = [1s, 3s, 5s]
async function withRetry<T>(fn: () => Promise<T>, delays = [1000, 3000, 5000]): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < delays.length) {
        console.error(`[Gemini] attempt ${i + 1} failed, retrying in ${delays[i]}ms:`, err)
        await sleep(delays[i])
      }
    }
  }
  throw lastErr
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

export async function generateReply(
  systemPrompt: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  const { clean, history, lastMessage } = buildHistory(messages)
  if (clean.length === 0 || !lastMessage) return 'Hello! How can I help you today?'

  const model = getGenAI().getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt })
  console.log(`[Gemini] generateReply model=${GEMINI_MODEL} history=${history.length} prompt="${lastMessage.slice(0, 80)}"`)

  try {
    const text = await withRetry(async () => {
      const chat = model.startChat({ history })
      const result = await chat.sendMessage(lastMessage)
      return result.response.text()
    })
    console.log(`[Gemini] reply: "${text.slice(0, 120)}"`)
    return text
  } catch (err) {
    console.error('[Gemini] generateReply all retries failed:', err)
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

  const model = getGenAI().getGenerativeModel({ model: GEMINI_MODEL, systemInstruction: systemPrompt })
  console.log(`[Gemini] streamReply model=${GEMINI_MODEL} history=${history.length} prompt="${lastMessage.slice(0, 80)}"`)

  const chat = model.startChat({ history })
  const result = await chat.sendMessageStream(lastMessage)

  for await (const chunk of result.stream) {
    const text = chunk.text()
    if (text) yield text
  }
}

export async function extractLeadFields(
  messages: { role: string; content: string }[]
): Promise<LeadFields> {
  const empty: LeadFields = { name: null, email: null, phone: null, product: null, quantity: null, budget: null, timeline: null }

  try {
    const model = getGenAI().getGenerativeModel({ model: GEMINI_MODEL })
    const convo = messages
      .filter((m) => m.content && m.content !== '(session started)')
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
      .join('\n')

    const prompt = `Extract lead qualification data from this sales conversation.
Return ONLY valid JSON (no markdown, no explanation) with these exact keys, use null for fields not clearly mentioned:
{"name":null,"email":null,"phone":null,"product":null,"quantity":null,"budget":null,"timeline":null}

Conversation:
${convo}`

    const result = await withRetry(() => model.generateContent(prompt))
    const text = result.response.text().trim()
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        name: parsed.name || null, email: parsed.email || null,
        phone: parsed.phone || null, product: parsed.product || null,
        quantity: parsed.quantity || null, budget: parsed.budget || null,
        timeline: parsed.timeline || null,
      }
    }
  } catch { /* extraction errors are non-fatal */ }
  return empty
}
