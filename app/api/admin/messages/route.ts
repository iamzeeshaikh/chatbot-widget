import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSession } from '@/lib/auth'
import { MODE_ROLE } from '@/lib/mode'
import { CONTACT_ROLE, TAGS_ROLE } from '@/lib/visitor'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ messages: [] }, { status: 401 })

  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (!(await canAccessSession(member, sessionId))) {
    return NextResponse.json({ messages: [] }, { status: 403 })
  }

  const { data, error } = await supabase
    .from('chat_logs')
    .select('*')
    .eq('session_id', sessionId)
    .not('role', 'in', `(${MODE_ROLE},${CONTACT_ROLE},${TAGS_ROLE})`) // hide control rows from the message view
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ messages: data ?? [] })
}
