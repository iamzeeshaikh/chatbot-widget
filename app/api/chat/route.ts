import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateReply, extractLeadFields } from '@/lib/gemini'

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

    const [siteRes, modeRes] = await Promise.all([
      supabase.from('sites').select('system_prompt').eq('site_id', siteId).single(),
      // Only select 'mode' — pending_reply column may not exist
      supabase.from('conversation_mode').select('mode').eq('session_id', sessionId).single(),
    ])

    if (siteRes.error || !siteRes.data) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: corsHeaders })
    }

    const mode = modeRes.data?.mode ?? 'bot'

    // Save the incoming user message
    const lastUserMessage = messages[messages.length - 1]
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: lastUserMessage.role,
      message: lastUserMessage.content,
    })

    let reply: string

    if (mode === 'human') {
      // Polling (GET /api/chat/poll) owns admin reply delivery in real-time.
      // Inline chat replies in human mode just acknowledge receipt.
      reply = '⏳ Our agent has received your message and will reply shortly...'
    } else {
      reply = await generateReply(siteRes.data.system_prompt, messages)
    }

    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: 'assistant',
      message: reply,
    })

    // Auto lead qualification — only in bot mode with enough context
    if (mode !== 'human') {
      const userMsgCount = messages.filter((m: { role: string }) => m.role === 'user').length
      if (userMsgCount >= 3) {
        try {
          const allMessages = [...messages, { role: 'assistant', content: reply }]
          const fields = await extractLeadFields(allMessages)
          const score = Object.values(fields).filter((v) => v !== null).length

          if (score >= 7 && fields.email) {
            const { data: existing } = await supabase
              .from('leads')
              .select('id')
              .eq('site_id', siteId)
              .eq('email', fields.email)
              .limit(1)

            if (!existing || existing.length === 0) {
              const msgText = [
                fields.product && `Product: ${fields.product}`,
                fields.quantity && `Quantity: ${fields.quantity}`,
                fields.budget && `Budget: ${fields.budget}`,
                fields.timeline && `Timeline: ${fields.timeline}`,
              ]
                .filter(Boolean)
                .join('\n')

              // Try with new columns (post-migration), fall back to basic schema
              const { error: fullErr } = await supabase.from('leads').insert({
                site_id: siteId,
                name: fields.name ?? '',
                email: fields.email,
                phone: fields.phone ?? '',
                message: msgText,
                product: fields.product,
                quantity: fields.quantity,
                budget: fields.budget,
                timeline: fields.timeline,
                qualification_score: score,
              })

              if (fullErr) {
                await supabase.from('leads').insert({
                  site_id: siteId,
                  name: fields.name ?? '',
                  email: fields.email,
                  phone: fields.phone ?? '',
                  message: msgText,
                })
              }
            }
          }
        } catch {
          // lead extraction is non-fatal
        }
      }
    }

    return NextResponse.json({ reply }, { headers: corsHeaders })
  } catch (err) {
    console.error('Chat error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
