import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSite } from '@/lib/auth'
import { getMode, setMode } from '@/lib/mode'
import {
  ATTACHMENT_BUCKET, MAX_ATTACHMENT_BYTES, isAllowedMime,
  uniqueAttachmentPath, buildAttachmentMessage, AttachmentInfo,
} from '@/lib/attachment'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

// Handles attachment uploads from BOTH sides of a conversation:
//  - Visitor (cross-origin, no auth cookie): saved as a 'user' message.
//  - Agent (same-origin dashboard, authenticated): saved as an 'admin' message
//    and the conversation is flipped to human mode, mirroring /api/admin/reply.
// The file goes to the public chat-attachments bucket under a unique path, and
// its public URL is stored as a file message in chat_logs.
export async function POST(req: NextRequest) {
  try {
    const member = await getMember(req) // null for visitors
    const isAgent = !!member

    const form = await req.formData().catch(() => null)
    const file = form?.get('file')
    const siteId = String(form?.get('siteId') ?? '')
    const sessionId = String(form?.get('sessionId') ?? '')

    if (!(file instanceof File) || !siteId || !sessionId) {
      return NextResponse.json({ error: 'Missing file, siteId or sessionId' }, { status: 400, headers: corsHeaders })
    }
    if (isAgent && !canAccessSite(member, siteId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders })
    }

    const mime = file.type || 'application/octet-stream'
    if (!isAllowedMime(mime)) {
      return NextResponse.json({ error: 'File type not allowed' }, { status: 415, headers: corsHeaders })
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 413, headers: corsHeaders })
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'Empty file' }, { status: 400, headers: corsHeaders })
    }

    const path = uniqueAttachmentPath(siteId, sessionId, mime, file.name)
    const bytes = new Uint8Array(await file.arrayBuffer())

    const { error: upErr } = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: false })
    if (upErr) {
      console.error('[Upload] storage error:', upErr.message)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500, headers: corsHeaders })
    }

    const { data: pub } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path)
    const info: AttachmentInfo = {
      url: pub.publicUrl,
      name: file.name || 'file',
      mime,
      size: file.size,
    }

    const role = isAgent ? 'admin' : 'user'
    const { error: logErr } = await supabase.from('chat_logs').insert({
      site_id: siteId,
      session_id: sessionId,
      role,
      message: buildAttachmentMessage(info),
    })
    if (logErr) {
      console.error('[Upload] chat_logs error:', logErr.message)
      return NextResponse.json({ error: 'Could not save message' }, { status: 500, headers: corsHeaders })
    }

    // An agent sending a file takes over the conversation, like a text reply.
    if (isAgent && (await getMode(sessionId)) !== 'human') {
      await setMode(sessionId, siteId, 'human')
    }

    return NextResponse.json({ ok: true, role, file: info }, { headers: corsHeaders })
  } catch (err) {
    console.error('[Upload] unhandled error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
