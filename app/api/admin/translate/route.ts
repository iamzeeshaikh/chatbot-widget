import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSession } from '@/lib/auth'
import { analyzeMessages, translateText } from '@/lib/gemini'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Server-side translation for the agent dashboard, powered by the existing Groq
// LLM (no new keys/cost, nothing exposed client-side). Always authenticated and
// scoped to a session the member can access, so it stays workspace-isolated.
//
//  mode 'incoming': { sessionId, items:[{id,text}] }
//      → { results:[{id, langName, isEnglish, english}] }   (detect + to-English)
//  mode 'outgoing': { sessionId, text, targetLang }
//      → { translation }                                    (English → targetLang)
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const sessionId: string | undefined = body.sessionId
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (!(await canAccessSession(member, sessionId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (body.mode === 'outgoing') {
    const text = String(body.text ?? '')
    const targetLang = String(body.targetLang ?? '')
    if (!text.trim() || !targetLang) {
      return NextResponse.json({ error: 'text and targetLang required' }, { status: 400 })
    }
    const translation = await translateText(text, targetLang)
    return NextResponse.json({ translation })
  }

  // Default: incoming detection + translation, batched.
  const items: { id: string; text: string }[] = Array.isArray(body.items) ? body.items.slice(0, 25) : []
  if (items.length === 0) return NextResponse.json({ results: [] })

  const analyses = await analyzeMessages(items.map((i) => String(i.text ?? '')))
  const results = items.map((it, i) => ({
    id: it.id,
    langName: analyses[i]?.langName ?? '',
    isEnglish: analyses[i]?.isEnglish ?? true,
    english: analyses[i]?.english ?? it.text,
  }))
  return NextResponse.json({ results })
}
