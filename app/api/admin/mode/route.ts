import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const { data } = await supabase
    .from('conversation_mode')
    .select('mode')
    .eq('session_id', sessionId)
    .single()

  return NextResponse.json({ mode: data?.mode ?? 'bot' })
}

export async function POST(req: NextRequest) {
  const { sessionId, mode } = await req.json()
  if (!sessionId || !['bot', 'human'].includes(mode)) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
  }

  const { error } = await supabase.from('conversation_mode').upsert({
    session_id: sessionId,
    mode,
    updated_at: new Date().toISOString(),
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
