import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { data, error } = await supabase
    .from('sites')
    .select('site_id, name, bot_name, primary_color')
    .order('created_at')

  if (error) return NextResponse.json({ sites: [] })
  return NextResponse.json({ sites: data ?? [] })
}
