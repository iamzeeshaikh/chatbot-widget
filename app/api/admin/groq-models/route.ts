import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Which chat models this Groq key can actually call today.
//
// Groq retires model ids on its own schedule, and when it retired the one this
// app was pinned to (`llama-3.1-8b-instant`, gone by 2026-08-20) EVERY bot reply
// silently became "I'm having trouble responding right now" — a 404 the bot
// swallows by design so a visitor never sees a stack trace. Nothing else in the
// product reports that, so this endpoint exists to answer "is our model still
// there, and what can we move to?" without a deploy-and-guess loop.
//
// Admin only, read-only, and it never returns the key itself.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const key = process.env.GROQ_API_KEY
  if (!key) return NextResponse.json({ error: 'GROQ_API_KEY is not set in this environment' }, { status: 500 })

  const r = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!r.ok) {
    return NextResponse.json({ error: `Groq returned ${r.status}`, body: (await r.text()).slice(0, 500) }, { status: 502 })
  }
  const data = (await r.json()) as { data?: { id: string; owned_by?: string; context_window?: number; active?: boolean }[] }
  const models = (data.data ?? [])
    .map((m) => ({ id: m.id, owned_by: m.owned_by, context_window: m.context_window, active: m.active }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return NextResponse.json({ count: models.length, models })
}
