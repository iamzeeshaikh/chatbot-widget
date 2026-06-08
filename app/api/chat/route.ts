import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { generateReply } from '@/lib/gemini'

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
      supabase.from('conversation_mode').select('mode, pending_reply').eq('session_id', sessionId).single(),
    ])

    if (siteRes.error || !siteRes.data) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: corsHeaders })
    }

    const mode = modeRes.data?.mode ?? 'bot'
    const pendingReply = modeRes.data?.pending_reply ?? null

    const lastUserMessage = messages[messages.length - 1]
    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: lastUserMessage.role,
      message: lastUserMessage.content,
    })

    let reply: string

    if (mode === 'human') {
      if (pendingReply) {
        reply = pendingReply
        await supabase
          .from('conversation_mode')
          .update({ pending_reply: null, updated_at: new Date().toISOString() })
          .eq('session_id', sessionId)
      } else {
        reply = '⏳ Our agent will reply shortly. Please wait...'
      }
    } else {
      reply = await generateReply(siteRes.data.system_prompt, messages)
    }

    await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role: 'assistant',
      message: reply,
    })

    return NextResponse.json({ reply }, { headers: corsHeaders })
  } catch (err) {
    console.error('Chat error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
