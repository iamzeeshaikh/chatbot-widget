import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { CRM_CALL_ROLE } from '@/lib/crm'
import { phoneKey } from '@/lib/identity'
import { quoteSessionId, QUOTE_TAG } from '@/lib/quoteintake'
import { SPORTS_SITES } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

// A voicemail, attached to whoever left it.
//
// Same identity rule as the WhatsApp webhook: match the caller on the last nine
// digits of their number, and create a lead when nobody matches — a stranger
// leaving a voicemail about uniforms is a lead, and dropping it because there
// was no row to attach it to is the silent loss this project keeps fixing.
const VOICEMAIL_SITE = SPORTS_SITES[0] ?? 'texasfootball'

export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return new NextResponse('', { status: 204 })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`
  if (!verifyTwilioSignature(cfg.token, url, params, req.headers.get('x-twilio-signature') ?? '')) {
    return new NextResponse('Bad signature', { status: 403 })
  }

  // `From` is not one of the recording callback's parameters — it is put on the
  // URL by the greeting handler. The param is still read first in case Twilio
  // ever sends one.
  const from = params.From || req.nextUrl.searchParams.get('from') || ''
  const sid = params.CallSid ?? params.RecordingSid ?? ''
  const recordingSid = params.RecordingSid ?? ''
  const duration = Number(params.RecordingDuration ?? '0') || 0
  if (!from || !sid) return new NextResponse('', { status: 204 })

  const key = phoneKey(from)
  let sessionId: string | null = null
  let siteId = VOICEMAIL_SITE

  if (key) {
    const { data: leads } = await supabase.from('leads')
      .select('id, site_id, phone')
      .in('site_id', SPORTS_SITES).not('phone', 'is', null)
      .order('created_at', { ascending: false }).limit(2000)
    const match = (leads ?? []).find((l) => phoneKey(l.phone) === key)
    if (match) { sessionId = quoteSessionId(match.id); siteId = match.site_id }
  }

  if (!sessionId) {
    const { data: created } = await supabase.from('leads').insert([{
      site_id: siteId, phone: from,
      message: `${QUOTE_TAG}Voicemail — the caller left a message on the phone line.`,
    }]).select('id').maybeSingle()
    if (created?.id) sessionId = quoteSessionId(created.id)
  }

  if (sessionId) {
    await supabase.from('chat_logs').insert([{
      session_id: sessionId, site_id: siteId, role: CRM_CALL_ROLE,
      message: JSON.stringify({
        sid, by: '', at: new Date().toISOString(),
        status: 'voicemail', duration, recordingSid,
      }),
    }])
  }

  return new NextResponse('', { status: 204 })
}
