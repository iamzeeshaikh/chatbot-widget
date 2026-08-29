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

    // ADMINS ONLY (2026-08-29, the owner's call). Quote leads were already
    // admin-only because the buying partner reconciles against them; the rest
    // followed, because a deleted lead does not come back and an agent has
    // never needed to remove one — a wrong lead is an admin's job to clear.
    if (member.role !== 'admin') {
      return NextResponse.json({ error: 'Only an admin can delete a lead.' }, { status: 403 })
    }
    const { data: lead } = await supabase.from('leads').select('site_id, message').eq('id', id).maybeSingle()
    if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await supabase.from('leads').delete().eq('id', id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Delete lead error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
