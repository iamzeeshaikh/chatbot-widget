import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
    await supabase.from('leads').delete().eq('id', id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('Delete lead error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
