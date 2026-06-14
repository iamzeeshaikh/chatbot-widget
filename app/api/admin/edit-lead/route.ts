import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    const member = await getMember(req)
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id, name, email, phone, message } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    if (member.role !== 'admin') {
      const { data: lead } = await supabase.from('leads').select('site_id').eq('id', id).maybeSingle()
      if (!lead || !canAccessSite(member, lead.site_id)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }
    const { error } = await supabase
      .from('leads')
      .update({
        name: name?.trim() || null,
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        message: message?.trim() || null,
      })
      .eq('id', id)
    if (error) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Edit lead error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
