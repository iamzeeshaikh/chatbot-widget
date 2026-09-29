import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { llmStatus, llmComplete, CLAUDE_CHAT_MODEL } from '@/lib/llm'

export const dynamic = 'force-dynamic'

// "Which model is answering my customers right now?" — admin only.
//
// Worth its own endpoint because the answer is otherwise invisible: the switch
// to Claude is an environment variable, not a deploy, so nothing in the code a
// person can read tells them which vendor is live on production this minute.
// The last time a model quietly stopped working it took days to notice.
//
// `?try=1` actually sends one short completion, so the reply proves the key
// works rather than proving the key is present. It never returns a key.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const status = llmStatus()
  if (req.nextUrl.searchParams.get('try') !== '1') return NextResponse.json(status)

  const started = Date.now()
  const r = await llmComplete({
    system: 'You are a test. Reply with exactly: ready',
    messages: [{ role: 'user', content: 'Say ready.' }],
    maxTokens: 20,
    temperature: 0,
  })
  return NextResponse.json({
    ...status,
    sample: {
      answeredBy: r.provider,
      model: r.model,
      ms: Date.now() - started,
      text: r.text.slice(0, 200),
      error: r.error,
      // Present only when Claude failed and Groq covered for it — the one
      // state worth seeing before customers do.
      fellBackBecause: r.fellBack ?? null,
      configuredChatModel: CLAUDE_CHAT_MODEL,
    },
  })
}
