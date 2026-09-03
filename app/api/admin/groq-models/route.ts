import { NextRequest, NextResponse } from 'next/server'
import { siteWorkspace } from '@/lib/workspaces'
import { SPORTS_SALES_RULES } from '@/lib/sportsbot'
import { getMember } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { siteIdentityPrompt } from '@/lib/sitedomains'
import { sampleReply } from '@/lib/gemini'

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
  // ?try=<model id> also runs one sample completion through the SAME prompt the
  // live bot uses, so a replacement model can be judged on its real answer
  // (length, tone, whether it leaks reasoning) before anything is pinned to it.
  const tryModel = req.nextUrl.searchParams.get('try')
  if (!tryModel) return NextResponse.json({ count: models.length, models })

  const question = req.nextUrl.searchParams.get('q') || 'what website is this and what do you sell?'
  const site = req.nextUrl.searchParams.get('siteId') || 'theretailpackaging'
  const { data: row } = await supabase.from('sites').select('system_prompt, name').eq('site_id', site).single()
  if (!row) return NextResponse.json({ error: `no sites row for ${site}` }, { status: 404 })

  const started = Date.now()
  const maxTokens = Number(req.nextUrl.searchParams.get('max')) || undefined
  const effort = req.nextUrl.searchParams.get('effort') || undefined
  const sample = await sampleReply(tryModel, siteIdentityPrompt(site, row.name ?? '') + row.system_prompt
    + (siteWorkspace(site) === 'sports' ? SPORTS_SALES_RULES : ''), question, { maxTokens, effort })
  return NextResponse.json({
    model: tryModel,
    siteId: site,
    question,
    ms: Date.now() - started,
    ...sample,
    words: sample.text ? sample.text.trim().split(/\s+/).length : 0,
  })
}
