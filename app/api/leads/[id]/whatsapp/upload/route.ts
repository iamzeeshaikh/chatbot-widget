import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { supabase } from '@/lib/supabase'
import {
  WHATSAPP_MEDIA_BUCKET, MAX_WHATSAPP_MEDIA_BYTES, isAllowedWhatsAppMedia,
  whatsappMediaPath, humanSize,
} from '@/lib/whatsappmedia'

export const dynamic = 'force-dynamic'

// Hand the browser a one-shot signed URL so it can PUT the file straight to
// Storage — the same shape the email composer uses, and for the same reason:
// Vercel caps a request body at 4.5MB, so proxying a 12MB voice note through
// this function would fail however generous WhatsApp's own 16MB limit is.
//
// Everything worth guarding still happens HERE, before any URL exists: who the
// member is, whether they may touch this lead, the type, and the size.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'telephony')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? '').slice(0, 200)
  const mime = String(body.mime ?? '').toLowerCase()
  const size = Number(body.size ?? 0)

  if (!name) return NextResponse.json({ error: 'A file name is required.' }, { status: 400 })
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: 'That file appears to be empty.' }, { status: 400 })
  }
  if (size > MAX_WHATSAPP_MEDIA_BYTES) {
    return NextResponse.json({
      error: `"${name}" is ${humanSize(size)}. WhatsApp allows ${humanSize(MAX_WHATSAPP_MEDIA_BYTES)} per message.`,
    }, { status: 413 })
  }
  if (!isAllowedWhatsAppMedia(mime, name)) {
    return NextResponse.json({
      error: `WhatsApp will not carry "${name}". It takes photos, PDFs, audio and video — not Office documents or zips.`,
    }, { status: 415 })
  }

  const path = whatsappMediaPath(access.siteId, id, name)
  const { data, error } = await supabase.storage
    .from(WHATSAPP_MEDIA_BUCKET)
    .createSignedUploadUrl(path)
  if (error || !data) return NextResponse.json({ error: 'Could not prepare the upload.' }, { status: 500 })

  return NextResponse.json({ ok: true, path, name, mime, size, uploadUrl: data.signedUrl, token: data.token })
}
