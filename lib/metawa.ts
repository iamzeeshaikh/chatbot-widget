// WhatsApp over Meta's own Cloud API — the UK packaging line.
//
// ── Why a second WhatsApp provider exists ────────────────────────────────────
// Every other WhatsApp line in this CRM goes through Twilio (lib/twilio.ts).
// The UK mobile +44 7578 382054, printed on every .co.uk packaging site, could
// not: both of the Meta business accounts Twilio can register against had hit
// Meta's two-numbers-per-unverified-business cap (2026-10-22), and Meta refused
// to share a fresh account across businesses. So the number was registered on
// a WhatsApp Business Account of its own, under a portfolio that still had
// room, and that account talks to Meta directly — there is no Twilio in the
// path for this line at all.
//
// The rest of the CRM must not care. A message on this line is stored in the
// SAME rows as a Twilio one (CRM_WA_IN_ROLE / CRM_WA_OUT_ROLE, lib/whatsapp.ts),
// the timeline draws it the same way, and the only decision that is new is
// "which line does this lead talk on" — `lineForLead` below.
//
// CREDENTIALS live in the environment and never leave the server:
//   META_UK_ACCESS_TOKEN      a system-user token that never expires
//   META_UK_PHONE_NUMBER_ID   Meta's id for the +44 line (not the number)
//   META_UK_WABA_ID           the WhatsApp Business Account
//   META_UK_APP_SECRET        signs every webhook (X-Hub-Signature-256)
//   META_UK_VERIFY_TOKEN      what Meta must echo when it subscribes the webhook
//   META_UK_NUMBER            the line itself, "+447578382054"

import { createHmac, timingSafeEqual } from 'crypto'
import { supabase } from './supabase'
import { CRM_WA_IN_ROLE } from './crm'
import { parseWaMessage } from './whatsapp'
import { phoneKey } from './identity'
import { SITE_DOMAINS } from './sitedomains'
import type { Workspace } from './workspaces'

const GRAPH = 'https://graph.facebook.com/v21.0'

export interface MetaWaConfig {
  token: string; phoneNumberId: string; wabaId: string; appSecret: string; verifyToken: string
  /** E.164 of the line, "+447578382054". */
  number: string
  /** The one business this line speaks for. */
  workspace: Workspace
}

/** The UK line belongs to packaging and only packaging. */
export const META_UK_WORKSPACE: Workspace = 'packaging'

export function metaWaConfig(): MetaWaConfig | null {
  const token = process.env.META_UK_ACCESS_TOKEN
  const phoneNumberId = process.env.META_UK_PHONE_NUMBER_ID
  const appSecret = process.env.META_UK_APP_SECRET
  if (!token || !phoneNumberId || !appSecret) return null
  return {
    token, phoneNumberId, appSecret,
    wabaId: process.env.META_UK_WABA_ID ?? '',
    verifyToken: process.env.META_UK_VERIFY_TOKEN ?? '',
    number: process.env.META_UK_NUMBER ?? '+447578382054',
    workspace: META_UK_WORKSPACE,
  }
}

export type WaLine = 'twilio' | 'meta'

/**
 * Which line a lead talks on.
 *
 * The customer chose it, not us: whoever messaged the UK number expects the
 * reply from the UK number, and a reply from the US line would arrive as a
 * stranger in a new chat. So the newest inbound WhatsApp row decides — its
 * `to` is the line they wrote to. A lead with no inbound WhatsApp yet (a web
 * form from a .co.uk site, say) goes by the site: a UK site's customer is
 * written to from the UK line, everyone else from the workspace's Twilio line.
 */
export async function lineForLead(sessionId: string, siteId: string): Promise<WaLine> {
  const cfg = metaWaConfig()
  if (!cfg) return 'twilio'
  const { data: rows } = await supabase.from('chat_logs')
    .select('message').eq('session_id', sessionId).eq('role', CRM_WA_IN_ROLE)
    .order('created_at', { ascending: false }).limit(1)
  const last = rows?.[0] ? parseWaMessage(rows[0].message) : null
  if (last?.to) return phoneKey(last.to) === phoneKey(cfg.number) ? 'meta' : 'twilio'
  return isUkSite(siteId) ? 'meta' : 'twilio'
}

export function isUkSite(siteId: string): boolean {
  return /\.co\.uk$/i.test(SITE_DOMAINS[siteId] ?? '')
}

/**
 * Is this webhook really from Meta?
 *
 * Meta signs the raw body with the app secret: HMAC-SHA256, hex, in
 * X-Hub-Signature-256 as "sha256=…". The check runs on the bytes as received,
 * before anything is parsed — the endpoint writes onto customers' records, so
 * an unsigned post is refused outright.
 */
export function verifyMetaSignature(appSecret: string, raw: string, header: string | null): boolean {
  const given = String(header ?? '').replace(/^sha256=/, '')
  if (!given) return false
  const expected = createHmac('sha256', appSecret).update(Buffer.from(raw, 'utf8')).digest('hex')
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface GraphError { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } }

async function graph<T>(cfg: MetaWaConfig, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(init.headers ?? {}) },
  })
  const j = (await res.json().catch(() => ({}))) as { error?: GraphError } & T
  if (!res.ok || j.error) {
    const e = j.error ?? {}
    throw new MetaError(String(e.message ?? `WhatsApp refused the request (${res.status})`), Number(e.code ?? res.status))
  }
  return j
}

export class MetaError extends Error {
  code: number
  constructor(message: string, code: number) { super(message); this.code = code }
}

/** Meta's reasons, in words an agent can act on. The codes are Meta's own —
 *  distinct from Twilio's 63xxx family, so the two never collide in a row. */
export function metaErrorHint(code: number | undefined): string {
  switch (code) {
    case 131047: return 'WhatsApp only allows a free reply within 24 hours of the customer’s last message. This conversation is outside that window.'
    case 131026: return 'That number is not reachable on WhatsApp.'
    case 131053: return 'WhatsApp would not take this attachment. It accepts photos (JPG/PNG), PDFs, MP4 video and audio as OGG/opus, AAC, MPEG or AMR — and nothing else.'
    case 131030: return 'This number is not on the WhatsApp account’s allowed list (the account is still in test mode).'
    case 131056: return 'WhatsApp is rate-limiting messages to this number for a moment. Try again shortly.'
    default: return ''
  }
}

export interface SentMeta { sid: string; status: string }

/**
 * Send a message on the UK line.
 *
 * `to` is a bare E.164 number; Meta wants digits without the plus. A file goes
 * as a LINK Meta fetches itself (a signed Storage URL, the same one Twilio is
 * handed), so no bytes pass through this function.
 *
 * As with Twilio, a 200 here means ACCEPTED — the webhook's `statuses` say
 * what WhatsApp actually did, and the 24-hour rule (131047) usually arrives
 * there, minutes later, not here.
 */
export async function sendMetaWhatsApp(
  cfg: MetaWaConfig, to: string, body: string,
  media?: { url: string; type: string; name: string },
): Promise<SentMeta> {
  const recipient = to.replace(/^whatsapp:/, '').replace(/\D/g, '')
  let payload: Record<string, unknown>
  if (media) {
    const m = media.type.toLowerCase()
    const kind = m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'document'
    const obj: Record<string, unknown> = { link: media.url }
    // Audio takes no caption; a document keeps its filename so the customer
    // sees "quote.pdf", not a hash.
    if (body && kind !== 'audio') obj.caption = body
    if (kind === 'document') obj.filename = media.name || 'file'
    payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: kind, [kind]: obj }
  } else {
    payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { body, preview_url: false } }
  }
  let out: { messages?: { id: string }[] }
  try {
    out = await graph(cfg, `/${cfg.phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
  } catch (e) {
    if (e instanceof MetaError) {
      const hint = metaErrorHint(e.code)
      throw new Error(hint || e.message)
    }
    throw e
  }
  const sid = out.messages?.[0]?.id
  if (!sid) throw new Error('WhatsApp accepted the message but returned no id.')
  // A caption travels with the file; an audio message sent with words would
  // otherwise lose them, so the words go as a second message.
  if (media && body && media.type.toLowerCase().startsWith('audio/')) {
    await graph(cfg, `/${cfg.phoneNumberId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { body, preview_url: false } }),
    }).catch(() => {})
  }
  return { sid, status: 'sent' }
}

/**
 * A file the customer sent.
 *
 * Meta hands the webhook a media ID, not a URL; the URL is fetched from the
 * ID, lives for minutes, and needs the token — so the bytes are pulled here,
 * once, and stored by the caller. Nothing about the Meta id is kept.
 */
export async function downloadMetaMedia(cfg: MetaWaConfig, mediaId: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  const meta = await graph<{ url?: string; mime_type?: string }>(cfg, `/${encodeURIComponent(mediaId)}`)
  if (!meta.url) return null
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${cfg.token}` } })
  if (!res.ok) return null
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    type: meta.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream',
  }
}
