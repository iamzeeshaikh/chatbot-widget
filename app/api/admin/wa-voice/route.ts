import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { twilioAuth } from '@/lib/twilio'

export const dynamic = 'force-dynamic'

// TEMPORARY, read-only. Fetches ONE WhatsApp sender so its voice endpoint can
// be confirmed: the list view returns a configuration object that omits
// voice_application_sid, which made a successful update look like it had not
// applied. Deleted once the answer is known.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const auth = twilioAuth()
  if (!auth) return NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 })
  const sid = req.nextUrl.searchParams.get('sid') ?? ''
  if (!/^XE[0-9a-f]{32}$/i.test(sid)) return NextResponse.json({ error: 'sid required' }, { status: 400 })

  const res = await fetch(`https://messaging.twilio.com/v2/Channels/Senders/${sid}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${auth.sid}:${auth.token}`).toString('base64') },
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) return NextResponse.json({ error: j?.message ?? res.status }, { status: 502 })
  return NextResponse.json({ sender_id: j.sender_id, status: j.status, configuration: j.configuration })
}
