import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { supabase } from '@/lib/supabase'
import {
  EMAIL_ATTACHMENT_BUCKET, MAX_EMAIL_ATTACHMENT_BYTES, isAllowedEmailAttachment,
  attachmentPath, humanSize,
} from '@/lib/emailattach'

export const dynamic = 'force-dynamic'

// Hand the browser a one-shot signed URL so it can PUT the file straight to
// Supabase Storage.
//
// The bytes never pass through this function on purpose: Vercel caps a request
// body at 4.5MB, so proxying a 10MB PDF would fail however generous our own
// limit was. Everything that needs guarding still happens here — who the member
// is, whether they can touch this lead, the type, and the size — before any URL
// is issued.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const name = String(body.name ?? '').slice(0, 200)
  const mime = String(body.mime ?? '').toLowerCase()
  const size = Number(body.size ?? 0)

  if (!name) return NextResponse.json({ error: 'A file name is required.' }, { status: 400 })
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: 'That file appears to be empty.' }, { status: 400 })
  }
  if (size > MAX_EMAIL_ATTACHMENT_BYTES) {
    return NextResponse.json({
      error: `"${name}" is ${humanSize(size)}. The limit is ${humanSize(MAX_EMAIL_ATTACHMENT_BYTES)} per file — send a download link instead.`,
    }, { status: 413 })
  }
  if (!isAllowedEmailAttachment(mime, name)) {
    return NextResponse.json({
      error: `"${name}" is not a file type we can email. PDFs, images, Office documents and zips are supported.`,
    }, { status: 415 })
  }

  const path = attachmentPath(access.siteId, id, 'out', name)
  const { data, error } = await supabase.storage
    .from(EMAIL_ATTACHMENT_BUCKET)
    .createSignedUploadUrl(path)
  if (error || !data) {
    return NextResponse.json({ error: 'Could not prepare the upload.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, path, uploadUrl: data.signedUrl, token: data.token })
}
