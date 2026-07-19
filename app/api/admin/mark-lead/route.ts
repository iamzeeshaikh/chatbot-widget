import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteOfSession, canAccessSite } from '@/lib/auth'
import { markLeadManually, isLeadTracked } from '@/lib/leadtracking'

export const dynamic = 'force-dynamic'

async function resolveSite(sessionId: string): Promise<string | null> {
  const fromLogs = await siteOfSession(sessionId)
  if (fromLogs) return fromLogs
  const { data } = await supabase
    .from('active_visitors').select('site_id').eq('session_id', sessionId).maybeSingle()
  return data?.site_id ?? null
}

// Admin-only manual lead: for when the conversation itself makes it obvious
// the visitor became a real lead (e.g. "I emailed you") without ever typing
// an email into the widget, so the bot's automatic capture never fires and
// this conversation would otherwise never count toward billing. No contact
// info is required — this is a pure count bump, not a data-entry form.
// Deliberately NOT exposed to standard members — the account owner wants to
// be the one making this call, not an agent.
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
  if (!isLeadTracked(siteId)) {
    return NextResponse.json({ error: 'This site is not lead-tracked, so it never appears in Billing.' }, { status: 400 })
  }

  const result = await markLeadManually({ sessionId, siteId })
  if (!result.ok) return NextResponse.json({ error: 'Failed to mark as lead.' }, { status: 500 })
  return NextResponse.json({ ok: true, alreadyMarked: result.alreadyMarked })
}
