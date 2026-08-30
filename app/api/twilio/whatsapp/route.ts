import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { twilioConfig, verifyTwilioSignature } from '@/lib/twilio'
import { CRM_WA_IN_ROLE } from '@/lib/crm'
import { phoneKey } from '@/lib/identity'
import { quoteSessionId, QUOTE_TAG } from '@/lib/quoteintake'
import { SPORTS_SITES } from '@/lib/workspaces'

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
// the message that says which one. A new lead therefore lands on WHATSAPP_SITE
// and the agent moves it if it belongs elsewhere. Guessing from the text would
// be worse — a wrong site is harder to notice than an unset one.
const WHATSAPP_SITE = SPORTS_SITES[0] ?? 'texasfootball'

interface LeadRow { id: string; site_id: string; phone: string | null }

export async function POST(req: NextRequest) {
  const cfg = twilioConfig()
  if (!cfg) return new NextResponse('Twilio is not configured', { status: 503 })

  const raw = await req.text()
  const params: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v

  // The URL Twilio signed is the one it called, proxy headers included.
  const proto = req.headers.get('x-forwarded-proto') ?? 'https'
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
  const url = `${proto}://${host}${req.nextUrl.pathname}`
  const signature = req.headers.get('x-twilio-signature') ?? ''
  if (!verifyTwilioSignature(cfg.token, url, params, signature)) {
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
  const media: { url: string; type: string }[] = []
  const numMedia = Number(params.NumMedia ?? '0')
  for (let i = 0; i < numMedia; i++) {
    const u = params[`MediaUrl${i}`]
    if (u) media.push({ url: u, type: params[`MediaContentType${i}`] ?? '' })
  }

  const key = phoneKey(from)
  let sessionId: string | null = null
  let siteId = WHATSAPP_SITE

  if (key) {
    // Only this workspace's leads — a WhatsApp number belongs to one business.
    const { data: leads } = await supabase
      .from('leads')
      .select('id, site_id, phone')
      .in('site_id', SPORTS_SITES)
      .not('phone', 'is', null)
      .order('created_at', { ascending: false })
      .limit(2000)
    const match = (leads ?? []).find((l: LeadRow) => phoneKey(l.phone) === key)
    if (match) {
      sessionId = quoteSessionId(match.id)
      siteId = match.site_id
    }
  }

  if (!sessionId) {
    // A number nobody has on file: this is a new lead, and losing it because it
    // arrived on WhatsApp instead of a form would be the same silent loss this
    // project keeps having to fix.
    const { data: created } = await supabase.from('leads').insert([{
      site_id: siteId,
      name: profileName || null,
      phone: from,
      message: `${QUOTE_TAG}WhatsApp enquiry\n\n${body}`.slice(0, 4000),
    }]).select('id').maybeSingle()
    if (created?.id) sessionId = quoteSessionId(created.id)
  }

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

  // An empty TwiML response: received, and no automatic reply. A person answers
  // from the CRM.
  return new NextResponse('<Response/>', { headers: { 'Content-Type': 'text/xml' } })
}
