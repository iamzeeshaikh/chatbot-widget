import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest) {
  try {
    const member = await getMember(req)
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    let { sessionIds } = await req.json()
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return NextResponse.json({ error: 'sessionIds array required' }, { status: 400 })
    }

    // Standard members may only delete sessions belonging to their sites.
    const scope = await siteScope(member)
    if (scope) {
      const { data: rows } = await supabase
        .from('chat_logs')
        .select('session_id, site_id')
        .in('session_id', sessionIds)
      const allowed = new Set((rows ?? []).filter((r) => scope.has(r.site_id)).map((r) => r.session_id))
      sessionIds = sessionIds.filter((id: string) => allowed.has(id))
      if (sessionIds.length === 0) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
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
