import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest) {
  try {
    const { id, name, email, phone, message } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
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
