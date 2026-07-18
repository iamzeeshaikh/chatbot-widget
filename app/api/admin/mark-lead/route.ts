import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteOfSession, canAccessSite } from '@/lib/auth'
import { maybeCaptureLead, isLeadTracked } from '@/lib/leadtracking'

export const dynamic = 'force-dynamic'

async function resolveSite(sessionId: string): Promise<string | null> {
  const fromLogs = await siteOfSession(sessionId)
  if (fromLogs) return fromLogs
  const { data } = await supabase
    .from('active_visitors').select('site_id').eq('session_id', sessionId).maybeSingle()
  return data?.site_id ?? null
}

// Admin-only manual lead capture: for when a customer says "I emailed you"
// (or otherwise clearly became a real lead) without ever typing an email
// into the chat widget itself, so the bot's own automatic capture never
// fired. Deliberately NOT exposed to standard members — the account owner
// wants to be the one deciding this, after checking their own inbox for
// the real email address, not left to an agent's judgment call.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const body = await req.json().catch(() => ({}))
  const sessionId: string | undefined = body.sessionId
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const siteId = await resolveSite(sessionId)
  if (!siteId || !canAccessSite(member, siteId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const email = String(body.email ?? '').trim()
  if (!email) return NextResponse.json({ error: 'email required' }, { status: 400 })
  if (!isLeadTracked(siteId)) {
    return NextResponse.json({ error: 'This site is not lead-tracked, so it never appears in Billing.' }, { status: 400 })
  }

  await maybeCaptureLead({
    sessionId,
    siteId,
    email,
    name: String(body.name ?? '').trim() || null,
    phone: String(body.phone ?? '').trim() || null,
  })

  return NextResponse.json({ ok: true })
}
