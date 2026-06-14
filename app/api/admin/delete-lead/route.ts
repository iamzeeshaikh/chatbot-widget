import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest) {
  try {
    const member = await getMember(req)
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    if (member.role !== 'admin') {
      const { data: lead } = await supabase.from('leads').select('site_id').eq('id', id).maybeSingle()
      if (!lead || !canAccessSite(member, lead.site_id)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    await supabase.from('leads').delete().eq('id', id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Delete lead error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
