import Groq from 'groq-sdk'

const MODEL = 'llama-3.1-8b-instant'

const ERROR_REPLY = "I'm having trouble responding right now, please try again in a moment."

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
- Answer the customer's questions thoroughly using the product knowledge above. If you genuinely don't know a detail, say a specialist will confirm — never make up facts.
- Recommend the best product(s) for what the customer describes, and ask relevant follow-up questions to understand their needs.
- Be consultative and genuinely helpful, never pushy. Keep replies concise (usually 1-3 short sentences) and keep the conversation flowing.
- Understand details (what they need, quantity, colors/branding or specs, timeline) gradually through the chat — one thing at a time, only when it fits naturally. Never interrogate or send a numbered list of questions.
- Help the customer first; do NOT demand contact details before being useful.
- When there is genuine buying interest, ask for contact details conversationally, e.g. "I'd love to put together a quote for you — what's the best email to send it to?" Ask for name, email and phone one at a time, not all at once.`

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
      max_tokens: 1024,
    })
    const text = completion.choices[0]?.message?.content ?? ''
    console.log(`[Groq] reply: "${text.slice(0, 120)}"`)
    return { text, error: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[Groq] generateReply FAILED model=${MODEL}: ${msg}`)
    console.error('[Groq] full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
    return { text: ERROR_REPLY, error: true }
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
      max_tokens: 256,
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
