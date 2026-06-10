import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateReply, extractLeadFields } from '@/lib/gemini'

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

    // Save user message
    const lastUserMessage = messages[messages.length - 1]
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: lastUserMessage.role,
      message: lastUserMessage.content,
    })

    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    }

    // Human mode: no Gemini call
    if (mode === 'human') {
      const humanReply = '⏳ Our agent has received your message and will reply shortly...'
      after(async () => {
        await supabase.from('chat_logs').insert({
          site_id: siteId, session_id: sessionId, role: 'assistant', message: humanReply,
        })
      })
      return new Response(humanReply, { headers: responseHeaders })
    }

    // Bot mode: regular generateContent (no streaming)
    const reply = await generateReply(systemPrompt, messages)

    after(async () => {
      await supabase.from('chat_logs').insert({
        site_id: siteId, session_id: sessionId, role: 'assistant', message: reply,
      })
      const userMsgCount = (messages as { role: string }[]).filter((m) => m.role === 'user').length
      if (userMsgCount >= 3) {
        try {
          const allMessages = [...messages, { role: 'assistant', content: reply }]
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

    return new Response(reply, { headers: responseHeaders })
  } catch (err) {
    console.error('[Chat] unhandled error:', err)
    console.error('[Chat] error details:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
