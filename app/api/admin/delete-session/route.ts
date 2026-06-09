import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest) {
  try {
    const { sessionIds } = await req.json()
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return NextResponse.json({ error: 'sessionIds array required' }, { status: 400 })
    }

    await Promise.all([
      supabase.from('chat_logs').delete().in('session_id', sessionIds),
      supabase.from('conversation_mode').delete().in('session_id', sessionIds),
    ])

    return NextResponse.json({ ok: true, deleted: sessionIds.length })
  } catch (err) {
    console.error('Delete session error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
