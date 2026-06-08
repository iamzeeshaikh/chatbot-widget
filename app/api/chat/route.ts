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

    const { data: site, error: siteError } = await supabase
      .from('sites')
      .select('system_prompt')
      .eq('site_id', siteId)
      .single()

    if (siteError || !site) {
      return NextResponse.json({ error: 'Site not found' }, { status: 404, headers: corsHeaders })
    }

    const reply = await generateReply(site.system_prompt, messages)

    const lastUserMessage = messages[messages.length - 1]
    await supabase.from('chat_logs').insert([
      { site_id: siteId, session_id: sessionId, role: lastUserMessage.role, message: lastUserMessage.content },
      { site_id: siteId, session_id: sessionId, role: 'assistant', message: reply },
    ])

    return NextResponse.json({ reply }, { headers: corsHeaders })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Chat error:', msg)
    return NextResponse.json({ error: 'Internal server error', debug: msg }, { status: 500, headers: corsHeaders })
  }
}
