import { GoogleGenerativeAI } from '@google/generative-ai'

let _genAI: GoogleGenerativeAI | null = null

function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  }
  return _genAI
}

export async function generateReply(
  systemPrompt: string,
  messages: { role: string; content: string }[]
): Promise<string> {
  // Strip internal system messages that confuse Gemini history
  const clean = messages.filter((m) => m.content && m.content !== '(session started)')
  if (clean.length === 0) return "Hello! How can I help you today?"

  const model = getGenAI().getGenerativeModel({
    model: 'gemini-flash-latest',
    systemInstruction: systemPrompt,
  })

  // Build history from all but last message.
  // Gemini requires: alternating user/model roles, must start with user.
  const rawHistory = clean.slice(0, -1).map((m) => ({
    role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model',
    parts: [{ text: m.content }],
  }))

  const history: typeof rawHistory = []
  for (const msg of rawHistory) {
    if (history.length === 0) {
      if (msg.role === 'user') history.push(msg) // skip leading model msgs
    } else if (msg.role !== history[history.length - 1].role) {
      history.push(msg) // only append on role change
    }
  }

  const lastMessage = clean[clean.length - 1].content
  console.log(`[Gemini] generateReply: history=${history.length} msgs, prompt="${lastMessage.slice(0, 80)}"`)

  const chat = model.startChat({ history })
  const result = await chat.sendMessage(lastMessage)
  const text = result.response.text()
  console.log(`[Gemini] reply: "${text.slice(0, 120)}"`)
  return text
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
  const clean = messages.filter((m) => m.content && m.content !== '(session started)')
  if (clean.length === 0) {
    yield 'Hello! How can I help you today?'
    return
  }

  const model = getGenAI().getGenerativeModel({
    model: 'gemini-flash-latest',
    systemInstruction: systemPrompt,
  })

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

  const lastMessage = clean[clean.length - 1].content
  console.log(`[Gemini] streamReply: history=${history.length} msgs, prompt="${lastMessage.slice(0, 80)}"`)

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
    const model = getGenAI().getGenerativeModel({ model: 'gemini-flash-latest' })

    const convo = messages
      .filter((m) => m.content && m.content !== '(session started)')
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Bot'}: ${m.content}`)
      .join('\n')

    const prompt = `Extract lead qualification data from this sales conversation.
Return ONLY valid JSON (no markdown, no explanation) with these exact keys, use null for fields not clearly mentioned:
{"name":null,"email":null,"phone":null,"product":null,"quantity":null,"budget":null,"timeline":null}

Conversation:
${convo}`

    const result = await model.generateContent(prompt)
    const text = result.response.text().trim()
    const jsonMatch = text.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        name: parsed.name || null,
        email: parsed.email || null,
        phone: parsed.phone || null,
        product: parsed.product || null,
        quantity: parsed.quantity || null,
        budget: parsed.budget || null,
        timeline: parsed.timeline || null,
      }
    }
  } catch {
    // extraction errors are non-fatal
  }
  return empty
}
