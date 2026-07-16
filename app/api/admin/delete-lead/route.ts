import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'
import { isQuoteLeadMessage } from '@/lib/quoteintake'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest) {
  try {
    const member = await getMember(req)
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const { data: lead } = await supabase.from('leads').select('site_id, message').eq('id', id).maybeSingle()
    if (member.role !== 'admin') {
      // Quote leads (custom-quote emails pulled in from Gmail) are billing
      // records the client's business partner independently verifies against
      // — only an admin can remove one, regardless of site access.
      if (!lead || isQuoteLeadMessage(lead.message) || !canAccessSite(member, lead.site_id)) {
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
