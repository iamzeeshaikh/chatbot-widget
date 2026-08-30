import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { twilioConfig, placeCall } from '@/lib/twilio'

export const dynamic = 'force-dynamic'

// TEMPORARY: ring the business number from the server, so the voicemail flow can
// be proved end to end without anyone having a US phone. Admin only. Deleted
// once the test has passed.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const cfg = twilioConfig()
  if (!cfg?.phoneNumber) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  const origin = req.nextUrl.origin
  try {
    const placed = await placeCall(
      cfg, cfg.phoneNumber,
      `${origin}/api/twilio/voice/test-say`,
      `${origin}/api/twilio/voice/test-say`,
    )
    return NextResponse.json({ ok: true, sid: placed.sid, status: placed.status })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
  }
}
