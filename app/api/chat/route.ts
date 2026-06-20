import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateReply, extractLeadFields } from '@/lib/gemini'
import { getMode } from '@/lib/mode'
import { maybeCaptureLead } from '@/lib/leadtracking'
import { isBotOffBySchedule } from '@/lib/botschedule'

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

    // Parallel DB fetches. The conversation mode (bot vs human takeover) is the
    // authoritative gate for whether the bot may reply at all.
    const [siteRes, mode] = await Promise.all([
      supabase.from('sites').select('system_prompt').eq('site_id', siteId).single(),
      getMode(sessionId),
    ])

    if (siteRes.error || !siteRes.data) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: corsHeaders })
    }

    const systemPrompt: string = siteRes.data.system_prompt

    // Save user message
    const lastUserMessage = messages[messages.length - 1]
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: lastUserMessage.role,
      message: lastUserMessage.content,
    })

    // Auto lead-capture (billing): if the visitor typed an email on a
    // lead-tracked site, record it once per conversation. Runs in both bot and
    // human modes; non-blocking and never fatal to the chat response.
    after(() => maybeCaptureLead({ sessionId, siteId, text: lastUserMessage.content }))

    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    }

    // The bot is suppressed when the conversation is in manual human takeover OR
    // when the packaging schedule says bot-off (see lib/botschedule.ts). Manual
    // human always wins; a schedule-off window never persists the mode, so the
    // bot resumes automatically once the window reopens (unless an agent took
    // over manually). Sports sites are never affected by the schedule.
    //
    // In both cases the bot stays COMPLETELY silent: the visitor's message is
    // already saved above, and we send NO automatic reply or ack of any kind —
    // a human agent initiates from the dashboard. The X-Bot-Silent header tells
    // the widget to render nothing (no bubble, no sound). To the visitor it just
    // looks like a normal live chat where they're waiting.
    // The bot must ONLY ever answer a genuine visitor message. An agent/admin
    // message must never trigger a bot reply (an agent reply is sent via
    // /api/admin/reply, which also flips the conversation to human mode). This is
    // a hard guard independent of mode: any non-visitor role stays silent.
    const role = String(lastUserMessage.role || '').toLowerCase()
    const isVisitorMessage = role === 'user' || role === 'visitor'

    const scheduleOff = isBotOffBySchedule(siteId)
    if (!isVisitorMessage || mode === 'human' || scheduleOff) {
      return new Response(null, {
        status: 200,
        headers: { ...corsHeaders, 'X-Bot-Silent': '1', 'Access-Control-Expose-Headers': 'X-Bot-Silent' },
      })
    }

    // Bot mode: Groq response
    const { text: reply, error: replyError } = await generateReply(systemPrompt, messages)

    after(async () => {
      await supabase.from('chat_logs').insert({
        site_id: siteId, session_id: sessionId, role: 'assistant', message: reply,
      })
      // Skip lead capture on API errors — don't extract from error messages
      const userMsgCount = (messages as { role: string }[]).filter((m) => m.role === 'user').length
      if (!replyError && userMsgCount >= 3) {
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
