import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioAuth, verifyTwilioSignature, workspaceForBusinessNumber } from '@/lib/twilio'
import { CRM_WA_IN_ROLE } from '@/lib/crm'
import { leadForCaller } from '@/lib/inbound'
import { sendPushToWorkspace } from '@/lib/push'
import { hasFeature } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

// A customer's WhatsApp message, arriving from Twilio.
//
// ── Why the signature check is not optional ─────────────────────────────────
// This URL is public — it has to be, Twilio calls it. Without verifying the
// signature it is a form anybody on the internet could post to, and what it
// does is WRITE A MESSAGE ONTO A CUSTOMER'S RECORD. So: HMAC over the exact
// URL and fields, using the auth token only Twilio and this server know.
// A bad signature is refused before anything is read.
//
// ── Which lead does it belong to? ───────────────────────────────────────────
// The sender's number, matched on its LAST NINE DIGITS through phoneKey — the
// same rule the rest of the CRM uses, because the same person arrives as
// "+1 213 449 3746", "213-449-3746" and "2134493746" depending on who typed it.
// No match means a new customer, and a new customer messaging on WhatsApp is a
// lead: one is created rather than the message being dropped.
//
// The site: WhatsApp gives us one number for five sites, so there is nothing in
// the message that says which one — see lib/inbound.ts, which decides that (and
// the number matching) for every inbound channel.

export async function POST(req: NextRequest) {
  const auth = twilioAuth()
  if (!auth) return new NextResponse('Twilio is not configured', { status: 503 })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  // The URL Twilio signed is the one it called, proxy headers included.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}`
  const signature = req.headers.get('x-twilio-signature') ?? ''
  if (!verifyTwilioSignature(auth.token, url, params, signature)) {
    console.warn('[whatsapp] refused a webhook with a bad signature')
    return new NextResponse('Bad signature', { status: 403 })
  }

  const sid = params.MessageSid ?? params.SmsMessageSid ?? ''
  const from = (params.From ?? '').replace(/^whatsapp:/, '')
  const to = (params.To ?? '').replace(/^whatsapp:/, '')
  const body = params.Body ?? ''
  const profileName = params.ProfileName ?? ''
  if (!sid || !from) return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } })

  // Media the customer attached. Twilio's URLs need the account's own auth to
  // fetch, so they are recorded and served through us later — never handed to a
  // browser as-is.
  const media: { url: string; type: string; name: string }[] = []
  const numMedia = Number(params.NumMedia ?? '0')
  for (let i = 0; i < numMedia; i++) {
    const u = params[`MediaUrl${i}`]
    if (u) {
      const type = params[`MediaContentType${i}`] ?? ''
      // WhatsApp sends no filename, so one is derived from the type — a voice
      // note has to read as something in the timeline, not as a blank chip.
      const ext = (type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '')
      const label = type.startsWith('audio/') ? 'Voice note'
        : type.startsWith('image/') ? 'Photo'
        : type.startsWith('video/') ? 'Video'
        : type === 'application/pdf' ? 'PDF' : 'File'
      media.push({ url: u, type, name: `${label}.${ext}` })
    }
  }

  // Which business was messaged — the sender number is the only evidence.
  const workspace = workspaceForBusinessNumber(to)
  if (!workspace) return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
  const found = await leadForCaller(from, workspace, `WhatsApp enquiry\n\n${body}`, { name: profileName, calledNumber: to })
  const sessionId = found?.sessionId ?? null
  const siteId = found?.siteId ?? ''

  if (sessionId) {
    // Dedupe on Twilio's SID: a retried webhook must not double-post.
    const { data: seen } = await supabase.from('chat_logs')
      .select('id').eq('session_id', sessionId).eq('role', CRM_WA_IN_ROLE)
      .like('message', `%${sid}%`).limit(1)
    if (!seen?.length) {
      await supabase.from('chat_logs').insert([{
        session_id: sessionId,
        site_id: siteId,
        role: CRM_WA_IN_ROLE,
        message: JSON.stringify({
          sid, from, to, body, media: media.length ? media : undefined,
          at: new Date().toISOString(), direction: 'inbound',
        }),
      }])
    }
  }

  // ── Tell somebody ────────────────────────────────────────────────────────
  // Without this the message lands on the timeline and waits there. That is
  // exactly what happened on 1 Sep: a customer wrote "Hi i need jerseys", the
  // row was written correctly, and nobody knew for hours — an inbound email
  // reply pushes a notification, and WhatsApp did not.
  //
  // The NAME is deliberately not in the notification for a workspace under
  // contact privacy: a push is drawn by the OS, outside the dashboard, where
  // none of the masking applies. The message text is the customer's own words
  // and is fine either way; the identity is not.
  if (sessionId) {
    // A push is drawn by the OS, outside the dashboard, where none of the
    // masking applies — so a workspace with contact privacy gets no name in it.
    const hidden = hasFeature(workspace, 'contactprivacy')
    const who = !hidden && profileName ? profileName : 'A customer'
    await sendPushToWorkspace(workspace, {
      title: `WhatsApp — ${who}`,
      body: body ? body.slice(0, 140) : media.length ? 'Sent a file' : 'New message',
      url: `/leads/${encodeURIComponent(sessionId)}`,
      // One tag per lead, so a burst of messages updates one banner instead of
      // stacking five.
      tag: `wa-${sessionId}`,
    })
  }

  // An empty TwiML response: received, and no automatic reply. A person answers
  // from the CRM.
  return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
}
