import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import { streamReply, generateReply, extractLeadFields } from '@/lib/gemini'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function POST(req: NextRequest) {
  try {
    const { siteId, messages, sessionId } = await req.json()

    if (!siteId || !messages || !sessionId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400, headers: corsHeaders })
    }

    // Parallel DB fetches
    const [siteRes, modeRes] = await Promise.all([
      supabase.from('sites').select('system_prompt').eq('site_id', siteId).single(),
      supabase.from('conversation_mode').select('mode').eq('session_id', sessionId).maybeSingle(),
    ])

    if (siteRes.error || !siteRes.data) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: corsHeaders })
    }

    const mode = modeRes.data?.mode ?? 'bot'
    const systemPrompt: string = siteRes.data.system_prompt

    // Save user message before streaming starts
    const lastUserMessage = messages[messages.length - 1]
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: lastUserMessage.role,
      message: lastUserMessage.content,
    })

    const encoder = new TextEncoder()
    const streamHeaders = {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }

    // Human mode: single-chunk stream (no Gemini call)
    if (mode === 'human') {
      const humanReply = '⏳ Our agent has received your message and will reply shortly...'
      after(async () => {
        await supabase.from('chat_logs').insert({
          site_id: siteId, session_id: sessionId, role: 'assistant', message: humanReply,
        })
      })
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(humanReply))
          controller.close()
        },
      })
      return new Response(stream, { headers: streamHeaders })
    }

    // Bot mode: streaming Gemini response
    // Bridge Promise lets after() (registered now) await the accumulated reply
    let resolveReply!: (reply: string) => void
    const replyDone = new Promise<string>((res) => { resolveReply = res })

    // Register post-response work before returning stream (captures request context)
    after(async () => {
      const fullReply = await replyDone
      await supabase.from('chat_logs').insert({
        site_id: siteId, session_id: sessionId, role: 'assistant', message: fullReply,
      })
      const userMsgCount = (messages as { role: string }[]).filter((m) => m.role === 'user').length
      if (userMsgCount >= 3) {
        try {
          const allMessages = [...messages, { role: 'assistant', content: fullReply }]
          const fields = await extractLeadFields(allMessages)
          const score = Object.values(fields).filter((v) => v !== null).length
          if (score >= 7 && fields.email) {
            const { data: existing } = await supabase
              .from('leads').select('id').eq('site_id', siteId).eq('email', fields.email).limit(1)
            if (!existing || existing.length === 0) {
              const msgText = [
                fields.product && `Product: ${fields.product}`,
                fields.quantity && `Quantity: ${fields.quantity}`,
                fields.budget && `Budget: ${fields.budget}`,
                fields.timeline && `Timeline: ${fields.timeline}`,
              ].filter(Boolean).join('\n')
              const { error: fullErr } = await supabase.from('leads').insert({
                site_id: siteId, name: fields.name ?? '', email: fields.email,
                phone: fields.phone ?? '', message: msgText,
                product: fields.product, quantity: fields.quantity,
                budget: fields.budget, timeline: fields.timeline,
                qualification_score: score,
              })
              if (fullErr) {
                await supabase.from('leads').insert({
                  site_id: siteId, name: fields.name ?? '', email: fields.email,
                  phone: fields.phone ?? '', message: msgText,
                })
              }
            }
          }
        } catch (err) {
          console.error('[Chat] lead extraction error (non-fatal):', err)
        }
      }
    })

    const CONNECT_FALLBACK = 'Our team has received your message and will respond shortly. Please leave your contact details below.'

    const stream = new ReadableStream({
      async start(controller) {
        let acc = ''
        try {
          for await (const chunk of streamReply(systemPrompt, messages)) {
            acc += chunk
            controller.enqueue(encoder.encode(chunk))
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[Chat] streamReply FAILED siteId=${siteId} msgCount=${messages?.length} error=${errMsg}`)
          console.error('[Chat] full error:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
          if (!acc) {
            // All streaming models failed — fall back to generateReply (tries all models too)
            try {
              const reply = await generateReply(systemPrompt, messages)
              acc = reply
              controller.enqueue(encoder.encode(reply))
            } catch (fallbackErr) {
              const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
              console.error(`[Chat] generateReply fallback also failed: ${fallbackMsg}`)
              acc = CONNECT_FALLBACK
              controller.enqueue(encoder.encode(CONNECT_FALLBACK))
            }
          }
        }
        controller.close()
        resolveReply(acc)
      },
    })

    return new Response(stream, { headers: streamHeaders })
  } catch (err) {
    console.error('[Chat] unhandled error:', err)
    console.error('[Chat] error details:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
