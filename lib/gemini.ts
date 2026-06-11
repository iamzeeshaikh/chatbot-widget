import { GoogleGenAI } from '@google/genai'

const MODEL = 'gemini-2.0-flash'

const RATE_LIMIT_FALLBACK = 'Our team has received your message and will respond shortly. Please leave your contact details below.'

let _ai: GoogleGenAI | null = null

function getAI(): GoogleGenAI {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
  return _ai
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

  console.log(`[Gemini] generateReply model=${MODEL} history=${history.length} prompt="${lastMessage.slice(0, 80)}"`)

  try {
    const chat = getAI().chats.create({
      model: MODEL,
      config: { systemInstruction: systemPrompt },
      history,
    })
    const response = await chat.sendMessage({ message: lastMessage })
    const text = response.text ?? ''
    console.log(`[Gemini] reply: "${text.slice(0, 120)}"`)
    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Gemini] generateReply FAILED model=${MODEL}: ${msg}`)
    console.error('[Gemini] full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
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

    const response = await getAI().models.generateContent({
      model: MODEL,
      contents: prompt,
    })
    const text = (response.text ?? '').trim()
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
