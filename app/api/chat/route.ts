import { NextRequest, NextResponse, after } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateReply, extractLeadFields } from '@/lib/gemini'
import { getMode } from '@/lib/mode'
import { maybeCaptureLead } from '@/lib/leadtracking'
import { isBotOffBySchedule } from '@/lib/botschedule'
import { isWidgetBlocked } from '@/lib/workspaces'
import { resolveCountryCode } from '@/lib/geo'
import { siteIdentityPrompt } from '@/lib/sitedomains'
import { isBotEnabled, BOT_OFF_ACK_MESSAGE } from '@/lib/botflag'
import { getBlockedIps, requestIp } from '@/lib/blocklist'
import { sendPushToWorkspace } from '@/lib/push'
import { siteWorkspace, isRetiredLeadSite } from '@/lib/workspaces'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

// The sports business quotes by hand, never from the chat (owner + sales agent,
// 2026-09-04). Two behaviours had to stop: the bot read per-unit prices out of a
// site's own system_prompt, and it told customers "no mockup before sale" — the
// business DOES make mockups, it just asks about the order first. This block
// outranks the site prompt because it is appended after it, and it applies to
// every sports site so a prompt edited by hand cannot reintroduce either.
const SPORTS_SALES_RULES = `

— PRICING AND MOCKUPS (SPORTS — these override anything above) —
- NEVER state, estimate or confirm any price, per-unit figure, discount or total — even if a price appears in the product knowledge above. Pricing comes only from the sales team as a written quote. When asked, say the team will send exact pricing, and ask one short question about their order (sport, quantity, or timeline).
- NEVER say mockups are unavailable, paid, or "only after purchase" — and never promise a free mockup unprompted. When a customer asks for a mockup or design, first learn what they plan to order (team size / quantity and the design idea), then say the design team will prepare the mockup details with the quote.
- ALWAYS learn, one question at a time across the chat: the type of fabric (or the GSM/weight they want) — pricing depends on it — and their design: ask them to send their design file or at least a reference image right here in the chat (the chat accepts file uploads). If they have no design, ask what they have in mind and reassure them the design team will create it.
- Collecting the order details (fabric/GSM, quantity, design or reference image) and contact info IS the goal of these conversations; the humans take it from there.`


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

    // Geo-block, enforced HERE as well as at the widget and the visitor ping.
    // The other two decide what a visitor SEES; this one decides what gets
    // stored. A cached widget from before the block, or anyone posting straight
    // at the endpoint, would otherwise still put a conversation in the database
    // — which is the thing the block exists to stop. Silent, like the IP
    // blocklist below: nothing is written and nothing is answered.
    const geoCode = await resolveCountryCode(req.headers)
    if (isWidgetBlocked(siteId, geoCode)) {
      return new Response(null, {
        status: 200,
        headers: { ...corsHeaders, 'X-Bot-Silent': '1', 'Access-Control-Expose-Headers': 'X-Bot-Silent' },
      })
    }

    // Admin IP blocklist: drop silently (same shape as the bot-silent response,
    // so the widget renders nothing and the message is never stored).
    const reqIp = requestIp(req.headers)
    // Scoped to this site's workspace; an unregistered site falls back to the
    // union, so a block can never lapse just because the site is unknown.
    if (reqIp && (await getBlockedIps(siteWorkspace(siteId) ?? undefined)).has(reqIp)) {
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

    // Who the bot is comes from code, not from the site's own prose: the row's
    // system_prompt is edited by hand per site and several older ones never
    // stated the company's website at all, so the model was free to invent one.
    // lib/sitedomains.ts is the single verified mapping.
    const systemPrompt: string =
      siteIdentityPrompt(siteId, siteRes.data.name ?? '') + siteRes.data.system_prompt
      + (siteWorkspace(siteId) === 'sports' ? SPORTS_SALES_RULES : '')

    // ── The opening line ──────────────────────────────────────────────────────
    // The widget shows a greeting the moment the panel opens — "Hi! Are you
    // looking for <product>?", built from the page title — and it never
    // reached the database, because only the LAST message of each request was
    // stored. So every transcript in the dashboard began mid-conversation with
    // the visitor answering a question nobody could see.
    //
    // Written on the FIRST exchange of a session rather than when it is shown:
    // most visitors open the widget and never type, and storing it at display
    // time would put a row against every one of them. The text comes from the
    // client's own message list, so it is the greeting that was actually on
    // screen rather than one reconstructed here and possibly different.
    // THREE, not two: the widget's array on the first send is the
    // '(session started)' sentinel, the greeting, and what the visitor typed.
    // A tighter bound skipped this branch every single time.
    const firstTurn = messages.length <= 3
    if (firstTurn) {
      const opener = messages.find((m: { role: string; content: string }) => m.role === 'assistant')
      const { count } = await supabase.from('chat_logs')
        .select('id', { count: 'exact', head: true }).eq('session_id', sessionId)
      if (!count && opener?.content) {
        await supabase.from('chat_logs').insert({
          site_id: siteId, session_id: sessionId, role: 'assistant', message: opener.content,
          // A second earlier, so it sorts above the reply it prompted rather
          // than tying with it and landing in whichever order the rows come back.
          created_at: new Date(Date.now() - 1000).toISOString(),
        })
      }
    }

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

    const botDisabled = !isBotEnabled(siteId)
    const scheduleOff = isBotOffBySchedule(siteId)
    if (!isVisitorMessage || botDisabled || mode === 'human' || scheduleOff) {
      const silentHeaders = {
        ...corsHeaders,
        'X-Bot-Silent': '1',
        'Access-Control-Expose-Headers': 'X-Bot-Silent, X-Bot-Ack',
      }
      // One-time ack whenever the bot is not going to answer at all — the flag
      // being off, or the scheduled window being closed — and only on the
      // conversation's FIRST genuine visitor message (the one saved above
      // counts as 1). Human takeover is deliberately excluded: by then the
      // visitor has already been answered, so "our team will respond" would be
      // a second, redundant promise.
      if ((botDisabled || scheduleOff) && mode !== 'human' && isVisitorMessage) {
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
      if (!replyError && userMsgCount >= 3 && !isRetiredLeadSite(siteId)) {
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
