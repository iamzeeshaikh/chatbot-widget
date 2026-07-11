import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateReply, extractLeadFields } from '@/lib/gemini'
import { getMode } from '@/lib/mode'
import { maybeCaptureLead } from '@/lib/leadtracking'
import { isBotOffBySchedule } from '@/lib/botschedule'
import { isBotEnabled, BOT_OFF_ACK_MESSAGE } from '@/lib/botflag'
import { getBlockedIps, requestIp } from '@/lib/blocklist'
import { sendPushToWorkspace } from '@/lib/push'
import { siteWorkspace } from '@/lib/workspaces'

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

    // Admin IP blocklist: drop silently (same shape as the bot-silent response,
    // so the widget renders nothing and the message is never stored).
    const reqIp = requestIp(req.headers)
    if (reqIp && (await getBlockedIps()).has(reqIp)) {
      return new Response(null, {
        status: 200,
        headers: { ...corsHeaders, 'X-Bot-Silent': '1', 'Access-Control-Expose-Headers': 'X-Bot-Silent' },
      })
    }

    // Parallel DB fetches. The conversation mode (bot vs human takeover) is the
    // authoritative gate for whether the bot may reply at all.
    const [siteRes, mode] = await Promise.all([
      supabase.from('sites').select('system_prompt, name').eq('site_id', siteId).single(),
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

    // Push a notification to the workspace's agents' devices (works with the
    // dashboard/app closed). Tagged by session so a burst of messages from the
    // same customer collapses into one notification on the phone.
    const pushWs = siteWorkspace(siteId)
    const pushRole = String(lastUserMessage.role || '').toLowerCase()
    if (pushWs && (pushRole === 'user' || pushRole === 'visitor')) {
      const siteName = siteRes.data.name || siteId
      const text = String(lastUserMessage.content || '').slice(0, 120)
      after(() => sendPushToWorkspace(pushWs, {
        title: `💬 ${siteName}`,
        body: text,
        url: `/?tab=conversations&session=${encodeURIComponent(sessionId)}&site=${encodeURIComponent(siteId)}`,
        tag: `chat-${sessionId}`,
      }))
    }

    const responseHeaders = {
      ...corsHeaders,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    }

    // The bot is suppressed when it is globally disabled (lib/botflag.ts — both
    // workspaces, every site), OR the conversation is in manual human takeover,
    // OR the packaging schedule says bot-off (see lib/botschedule.ts). Manual
    // human always wins; a schedule-off window never persists the mode, so the
    // bot resumes automatically once the window reopens (unless an agent took
    // over manually). Sports sites are never affected by the schedule.
    //
    // In all cases the bot sends NO LLM-generated reply: the visitor's message
    // is already saved above, and a human agent replies from the dashboard. The
    // X-Bot-Silent header tells the widget to render nothing (no bubble, no
    // sound). To the visitor it just looks like a normal live chat where
    // they're waiting. The one exception: when the bot is GLOBALLY disabled,
    // the very first visitor message of a conversation gets a one-time static
    // ack (X-Bot-Ack + body) so the visitor knows a human will follow up. The
    // ack is widget-rendered only, never stored in chat_logs.
    // The bot must ONLY ever answer a genuine visitor message. An agent/admin
    // message must never trigger a bot reply (an agent reply is sent via
    // /api/admin/reply, which also flips the conversation to human mode). This is
    // a hard guard independent of mode: any non-visitor role stays silent.
    const role = String(lastUserMessage.role || '').toLowerCase()
    const isVisitorMessage = role === 'user' || role === 'visitor'

    const botDisabled = !isBotEnabled()
    const scheduleOff = isBotOffBySchedule(siteId)
    if (!isVisitorMessage || botDisabled || mode === 'human' || scheduleOff) {
      const silentHeaders = {
        ...corsHeaders,
        'X-Bot-Silent': '1',
        'Access-Control-Expose-Headers': 'X-Bot-Silent, X-Bot-Ack',
      }
      // One-time ack, only in global bot-off mode and only on the conversation's
      // FIRST genuine visitor message (the one saved above counts as 1).
      if (botDisabled && isVisitorMessage) {
        const { count } = await supabase
          .from('chat_logs')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', sessionId)
          .eq('role', 'user')
          .neq('message', '(session started)')
        if ((count ?? 0) <= 1) {
          return new Response(BOT_OFF_ACK_MESSAGE, {
            status: 200,
            headers: { ...silentHeaders, 'X-Bot-Ack': '1', 'Content-Type': 'text/plain; charset=utf-8' },
          })
        }
      }
      return new Response(null, { status: 200, headers: silentHeaders })
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
