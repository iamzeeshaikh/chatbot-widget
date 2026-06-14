import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ sites: [] }, { status: 401 })
  const scope = await siteScope(member)

  let query = supabase
    .from('sites')
    .select('site_id, name, bot_name, primary_color')
    .order('created_at')

  if (scope) query = query.in('site_id', Array.from(scope))

  const { data, error } = await query
  if (error) return NextResponse.json({ sites: [] })
  return NextResponse.json({ sites: data ?? [] })
}
