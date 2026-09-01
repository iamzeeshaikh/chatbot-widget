import { NextRequest, NextResponse } from 'next/server'
import { guardLeadAccess, writeControlRow, leadPhone } from '@/lib/leadrecord'
import { getMember } from '@/lib/auth'
import { twilioConfig, twilioProblem, sendWhatsApp } from '@/lib/twilio'
import { CRM_WA_OUT_ROLE } from '@/lib/crm'
import { signedMediaUrl } from '@/lib/whatsappmedia'

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

  const problem = twilioProblem(access.member.workspace)
  const cfg = twilioConfig(access.member.workspace)
  if (problem || !cfg) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const text = String(body.body ?? '').trim()
  // A file may travel with a caption or on its own — a voice note usually has
  // no words at all — so "empty" only means empty when there is no file either.
  const mediaPath = String(body.mediaPath ?? '')
  const mediaName = String(body.mediaName ?? '').slice(0, 200)
  const mediaType = String(body.mediaType ?? '').toLowerCase()
  if (!text && !mediaPath) return NextResponse.json({ error: 'The message is empty.' }, { status: 400 })
  if (text.length > MAX_BODY) return NextResponse.json({ error: 'That message is too long for WhatsApp.' }, { status: 400 })

  const to = await leadPhone(id)
  if (!to) {
    return NextResponse.json({ error: 'This lead has no phone number on file, so it cannot be messaged.' }, { status: 400 })
  }

  // Twilio reports what WhatsApp actually did minutes later, against this URL.
  // The lead id travels on it; the number does not.
  const statusUrl = `${req.nextUrl.origin}/api/twilio/whatsapp/status?leadId=${encodeURIComponent(id)}`

  // Twilio fetches the file itself, so it needs a URL reachable without our
  // cookie — a signed Storage link, valid just long enough for the send.
  let mediaUrl: string | undefined
  if (mediaPath) {
    const signed = await signedMediaUrl(mediaPath)
    if (!signed) return NextResponse.json({ error: 'That file could not be prepared for sending.' }, { status: 500 })
    mediaUrl = signed
  }

  let sent
  try {
    sent = await sendWhatsApp(cfg, to, text, statusUrl, mediaUrl)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'WhatsApp refused the message.' }, { status: 502 })
  }

  const entry = {
    sid: sent.sid, from: cfg.whatsappFrom.replace(/^whatsapp:/, ''), to,
    body: text, at: new Date().toISOString(),
    sentBy: access.member.email, direction: 'outbound' as const,
    // The STORAGE PATH is recorded, never the signed URL: that link expires in
    // minutes, and a timeline pointing at a dead link is worse than one that
    // fetches the file through us on demand.
    media: mediaPath ? [{ path: mediaPath, name: mediaName, type: mediaType }] : undefined,
    // Twilio's first word — 'queued' or 'sent'. It means ACCEPTED, not
    // arrived; the callback replaces it with what really happened.
    status: sent.status || 'queued',
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
