import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { metaWaConfig, verifyMetaSignature, downloadMetaMedia } from '@/lib/metawa'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from '@/lib/crm'
import { leadForCaller } from '@/lib/inbound'
import { WHATSAPP_LEAD_MESSAGE } from '@/lib/quoteintake'
import { harvestContact } from '@/lib/contactharvest'
import { sendPushToWorkspace } from '@/lib/push'
import { hasFeature } from '@/lib/workspaces'
import { parseWaMessage } from '@/lib/whatsapp'
import { resolveLeadSite } from '@/lib/leadrecord'
import { WHATSAPP_MEDIA_BUCKET, whatsappMediaPath } from '@/lib/whatsappmedia'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// The UK WhatsApp line, arriving from Meta directly (lib/metawa.ts says why).
//
// One URL carries two kinds of event, in one JSON shape:
//   • `messages`  — a customer wrote to us. Same handling as the Twilio
//                   webhook: find or create their lead, write the row, push.
//   • `statuses`  — what WhatsApp did with something WE sent. Same as the
//                   Twilio status callback, except Meta cannot carry our lead
//                   id on the callback URL, so the message id is looked up.
//
// GET is Meta's one-time subscription handshake: it calls with a challenge
// and our verify token, and expects the challenge echoed back as plain text.

export async function GET(req: NextRequest) {
  const cfg = metaWaConfig()
  const q = req.nextUrl.searchParams
  if (!cfg || q.get('hub.mode') !== 'subscribe' || !cfg.verifyToken || q.get('hub.verify_token') !== cfg.verifyToken) {
    return new NextResponse('Forbidden', { status: 403 })
  }
  return new NextResponse(q.get('hub.challenge') ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

export async function POST(req: NextRequest) {
  const cfg = metaWaConfig()
  if (!cfg) return new NextResponse('WhatsApp (Meta) is not configured', { status: 503 })

  const raw = await req.text()
  if (!verifyMetaSignature(cfg.appSecret, raw, req.headers.get('x-hub-signature-256'))) {
    console.warn('[meta-wa] refused a webhook with a bad signature')
    return new NextResponse('Bad signature', { status: 403 })
  }

  // Meta retries on anything but a 200, and a retry of a webhook we already
  // handled is just a duplicate — so every path below records what it can and
  // answers 200 regardless. The dedupe on message id makes a retry harmless.
  try {
    await handle(cfg, JSON.parse(raw))
  } catch (e) {
    console.error('[meta-wa] webhook failed', e)
  }
  return new NextResponse('', { status: 200 })
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

const MEDIA_TYPES = new Set(['image', 'document', 'video', 'audio', 'sticker'])
const WORTH_RECORDING = new Set(['delivered', 'read', 'failed'])

async function handle(cfg: NonNullable<ReturnType<typeof metaWaConfig>>, payload: unknown) {
  for (const entry of arr(obj(payload).entry)) {
    for (const change of arr(obj(entry).changes)) {
      const value = obj(obj(change).value)
      // Only our own line. A second number on the same account would arrive
      // here too, and it is not ours to file.
      const phoneNumberId = str(obj(value.metadata).phone_number_id)
      if (phoneNumberId && phoneNumberId !== cfg.phoneNumberId) continue
      const names = new Map<string, string>()
      for (const c of arr(value.contacts)) {
        const id = str(obj(c).wa_id); const name = str(obj(obj(c).profile).name)
        if (id && name) names.set(id, name)
      }
      for (const m of arr(value.messages)) await inbound(cfg, obj(m), names.get(str(obj(m).from)) ?? '')
      for (const s of arr(value.statuses)) await status(obj(s))
    }
  }
}

async function inbound(cfg: NonNullable<ReturnType<typeof metaWaConfig>>, msg: Obj, profileName: string) {
  const sid = str(msg.id)
  const fromDigits = str(msg.from).replace(/\D/g, '')
  if (!sid || !fromDigits) return
  const from = `+${fromDigits}`
  const type = str(msg.type)
  const part = obj(msg[type])
  // Text, a button tap, a caption — whatever words came with it.
  const body = type === 'text' ? str(part.body)
    : type === 'button' ? str(part.text)
    : type === 'interactive' ? (str(obj(part.button_reply).title) || str(obj(part.list_reply).title))
    : str(part.caption)

  const workspace = cfg.workspace
  const found = await leadForCaller(from, workspace, `${WHATSAPP_LEAD_MESSAGE}\n\n${body}`, { name: profileName, calledNumber: cfg.number })
  const sessionId = found?.sessionId ?? null
  const siteId = found?.siteId ?? ''
  if (!sessionId) return

  // Dedupe on Meta's message id: a retried webhook must not double-post.
  const { data: seen } = await supabase.from('chat_logs')
    .select('id').eq('session_id', sessionId).eq('role', CRM_WA_IN_ROLE)
    .like('message', `%${sid}%`).limit(1)
  if (seen?.length) return

  // A file: fetched from Meta now (its link lives minutes and needs the token)
  // and kept in our own Storage, so the timeline serves it through the same
  // path-based route an outbound file uses. No Meta id survives on the row.
  const media: { path: string; type: string; name: string; size?: number }[] = []
  if (MEDIA_TYPES.has(type) && str(part.id)) {
    const got = await downloadMetaMedia(cfg, str(part.id)).catch(() => null)
    if (got) {
      const mime = str(part.mime_type) || got.type
      const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace(/[^a-z0-9]/gi, '')
      const label = mime.startsWith('audio/') ? 'Voice note'
        : mime.startsWith('image/') ? 'Photo'
        : mime.startsWith('video/') ? 'Video'
        : mime === 'application/pdf' ? 'PDF' : 'File'
      const name = str(part.filename) || `${label}.${ext}`
      const path = whatsappMediaPath(siteId, sessionId, `in-${name}`)
      const { error } = await supabase.storage.from(WHATSAPP_MEDIA_BUCKET)
        .upload(path, got.bytes, { contentType: mime, upsert: false })
      if (!error) media.push({ path, type: mime, name, size: got.bytes.byteLength })
      else console.error('[meta-wa] could not store inbound media', error.message)
    }
  }

  await supabase.from('chat_logs').insert([{
    session_id: sessionId, site_id: siteId, role: CRM_WA_IN_ROLE,
    message: JSON.stringify({
      sid, from, to: cfg.number, body, media: media.length ? media : undefined,
      at: new Date().toISOString(), direction: 'inbound',
    }),
  }])
  await harvestContact(sessionId, siteId, body ?? '')

  const hidden = hasFeature(workspace, 'contactprivacy')
  const who = !hidden && profileName ? profileName : 'A customer'
  await sendPushToWorkspace(workspace, {
    title: `WhatsApp — ${who}`,
    body: body ? body.slice(0, 140) : media.length ? 'Sent a file' : 'New message',
    url: `/leads/${encodeURIComponent(sessionId)}`,
    tag: `wa-${sessionId}`,
  })
}

async function status(st: Obj) {
  const sid = str(st.id)
  const state = str(st.status)
  if (!sid || !WORTH_RECORDING.has(state)) return
  // Which lead sent it: the row written at send time carries the id. The id
  // is Meta's own, long and unique, so a substring match on the role's rows
  // finds exactly one send.
  const { data: rows } = await supabase.from('chat_logs')
    .select('session_id, message').eq('role', CRM_WA_OUT_ROLE)
    .like('message', `%${sid}%`).order('created_at', { ascending: false }).limit(5)
  let leadId = ''
  let original = null
  for (const r of rows ?? []) {
    const w = parseWaMessage(r.message)
    if (w?.sid === sid) { original = w; leadId = String(r.session_id); break }
  }
  if (!original || !leadId) return
  const resolved = await resolveLeadSite(leadId)
  if (!resolved) return
  const firstError = obj(arr(st.errors)[0])
  const errorCode = Number(firstError.code ?? 0) || undefined
  await supabase.from('chat_logs').insert([{
    session_id: leadId, site_id: resolved.siteId, role: CRM_WA_OUT_ROLE,
    message: JSON.stringify({ ...original, status: state, errorCode }),
  }])
}
