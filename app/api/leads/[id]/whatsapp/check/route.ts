import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, leadPhone } from '@/lib/leadrecord'
import { twilioConfig, lookupNumber } from '@/lib/twilio'
import { cachedLineType, rememberLineType } from '@/lib/whatsappstatus'
import { phoneKey } from '@/lib/identity'

export const dynamic = 'force-dynamic'

// Ask Twilio what KIND of line this number is — the only pre-flight signal that
// exists, since nothing can tell you whether a number is on WhatsApp without
// messaging it.
//
// It costs money per call and a number's line type does not change, so the
// answer is cached against the number (not the lead) and a second press on any
// lead sharing that number is free.
//
// The NUMBER IS NEVER TAKEN FROM THE REQUEST and never returned: an agent under
// contact privacy is shown "•••••• hidden" and must stay that way. They get the
// verdict, not the digits.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'telephony')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const phone = await leadPhone(id)
  if (!phone) return NextResponse.json({ error: 'This lead has no phone number on file.' }, { status: 400 })
  const key = phoneKey(phone) ?? ''

  const known = await cachedLineType(key)
  if (known) return NextResponse.json({ ok: true, cached: true, type: known.type, carrier: known.carrier })

  const cfg = twilioConfig(access.member.workspace)
  if (!cfg) return NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 })

  try {
    const l = await lookupNumber(cfg, phone) as { type?: string; carrier?: string; valid?: boolean }
    if (l.valid === false) {
      await rememberLineType(key, 'invalid', '')
      return NextResponse.json({ ok: true, type: 'invalid', carrier: '' })
    }
    const type = String(l.type ?? 'unknown')
    const carrier = String(l.carrier ?? '')
    await rememberLineType(key, type, carrier)
    return NextResponse.json({ ok: true, type, carrier })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'The check failed.' }, { status: 502 })
  }
}
