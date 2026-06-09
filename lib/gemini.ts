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
  const model = getGenAI().getGenerativeModel({
    model: 'gemini-flash-latest',
    systemInstruction: systemPrompt,
  })

  const history = messages.slice(0, -1).map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }))

  const lastMessage = messages[messages.length - 1].content

  const chat = model.startChat({ history })
  const result = await chat.sendMessage(lastMessage)
  return result.response.text()
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
