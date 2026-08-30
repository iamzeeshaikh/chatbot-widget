import { NextRequest, NextResponse } from 'next/server'
import { guardLeadAccess, writeControlRow, leadPhone } from '@/lib/leadrecord'
import { getMember } from '@/lib/auth'
import { twilioConfig, twilioProblem, sendWhatsApp } from '@/lib/twilio'
import { CRM_WA_OUT_ROLE } from '@/lib/crm'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const MAX_BODY = 4000

// Reply to a customer on WhatsApp, from the lead's own record.
//
// The RECIPIENT IS NEVER TAKEN FROM THE REQUEST. It is read from our own rows,
// exactly as the email send does, because an agent here may not be allowed to
// see the number at all — the browser is showing them "•••••• hidden". This is
// the whole point of the feature: they can talk to the customer without being
// able to write the customer's number down.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'telephony')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const problem = twilioProblem()
  const cfg = twilioConfig()
  if (problem || !cfg) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const text = String(body.body ?? '').trim()
  if (!text) return NextResponse.json({ error: 'The message is empty.' }, { status: 400 })
  if (text.length > MAX_BODY) return NextResponse.json({ error: 'That message is too long for WhatsApp.' }, { status: 400 })

  const to = await leadPhone(id)
  if (!to) {
    return NextResponse.json({ error: 'This lead has no phone number on file, so it cannot be messaged.' }, { status: 400 })
  }

  let sent
  try {
    sent = await sendWhatsApp(cfg, to, text)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'WhatsApp refused the message.' }, { status: 502 })
  }

  const entry = {
    sid: sent.sid, from: cfg.whatsappFrom.replace(/^whatsapp:/, ''), to,
    body: text, at: new Date().toISOString(),
    sentBy: access.member.email, direction: 'outbound' as const,
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_WA_OUT_ROLE, message: JSON.stringify(entry),
  })
  if (error) {
    return NextResponse.json({
      ok: true, sent: true, recorded: false,
      warning: 'The message was sent, but it could not be recorded on the timeline.',
    })
  }

  // The number is not echoed back: a member who may not see it must not receive
  // it in the reply to their own send (the email route learned this the hard
  // way — see lib/pii.ts).
  return NextResponse.json({ ok: true, sent: true, recorded: true, status: sent.status })
}
