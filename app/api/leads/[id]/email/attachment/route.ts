import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { supabase } from '@/lib/supabase'
import { googleConfig, fetchThread, fetchAttachment, GmailAuthError, GmailScopeError } from '@/lib/gmail'
import { CRM_EMAIL_IN_ROLE, parseCrmEmailIn } from '@/lib/emailreply'
import {
  EMAIL_ATTACHMENT_BUCKET, MAX_INBOUND_ATTACHMENT_BYTES, isAllowedEmailAttachment,
  attachmentPath, humanSize,
} from '@/lib/emailattach'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Retry one inbound attachment the sweep refused.
//
// Worth having because the commonest refusal is a limit we later raised — a
// phone photo at 11.3MB was rejected by a 10MB cap. Without this the file is
// stranded in Gmail with a dead chip on the timeline pointing at it.
//
// It re-fetches from the thread and re-applies the CURRENT rules, then appends
// an updated crm_email_in row. Newest row per gmailId wins on read, so the
// timeline just picks it up — no mutation, no migration.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const body = await req.json().catch(() => ({}))
  const gmailId = String(body.gmailId ?? '').trim()
  const name = String(body.name ?? '').trim()
  if (!gmailId || !name) return NextResponse.json({ error: 'Nothing to retry' }, { status: 400 })

  // Find our stored copy of that reply — this is also what proves the message
  // belongs to THIS lead rather than being an arbitrary id from the client.
  const { data: rows } = await supabase.from('chat_logs')
    .select('message, created_at').eq('session_id', id).eq('role', CRM_EMAIL_IN_ROLE)
    .order('created_at', { ascending: false }).limit(200)
  let entry = null
  for (const r of rows ?? []) {
    const e = parseCrmEmailIn(r.message)
    if (e?.gmailId === gmailId) { entry = e; break }
  }
  if (!entry) return NextResponse.json({ error: 'That message is not on this lead.' }, { status: 404 })

  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Gmail is not configured.' }, { status: 503 })

  // Whoever's mailbox it landed in is who can read it back.
  const { data: outRows } = await supabase.from('chat_logs')
    .select('message').eq('session_id', id).eq('role', 'crm_email')
    .order('created_at', { ascending: false }).limit(50)
  let agent = ''
  for (const r of outRows ?? []) {
    try { const o = JSON.parse(r.message); if (o.threadId === entry.threadId && o.sentBy) { agent = o.sentBy; break } } catch { /* skip */ }
  }
  if (!agent) return NextResponse.json({ error: 'Could not work out which mailbox this arrived in.' }, { status: 409 })

  try {
    const messages = await fetchThread(agent, cfg, entry.threadId)
    const msg = messages.find((m) => m.gmailId === gmailId)
    const ref = msg?.attachments.find((a) => a.name === name)
    if (!ref) return NextResponse.json({ error: 'That file is no longer on the message in Gmail.' }, { status: 404 })

    if (!isAllowedEmailAttachment(ref.mime, ref.name)) {
      return NextResponse.json({ error: `"${ref.name}" is not a file type we can store.` }, { status: 415 })
    }
    if (ref.size > MAX_INBOUND_ATTACHMENT_BYTES) {
      return NextResponse.json({
        error: `"${ref.name}" is ${humanSize(ref.size)} — still over the ${humanSize(MAX_INBOUND_ATTACHMENT_BYTES)} limit.`,
      }, { status: 413 })
    }

    const bytes = await fetchAttachment(agent, cfg, gmailId, ref.attachmentId)
    if (!bytes) return NextResponse.json({ error: 'Gmail would not return the file.' }, { status: 502 })

    const path = attachmentPath(access.siteId, id, 'in', ref.name)
    const { error: upErr } = await supabase.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .upload(path, bytes, { contentType: ref.mime, upsert: false })
    if (upErr) return NextResponse.json({ error: 'Could not store the file.' }, { status: 500 })

    // Append the corrected revision: the file moves from skipped to saved.
    const next = {
      ...entry,
      attachments: [...(entry.attachments ?? []), { path, name: ref.name, mime: ref.mime, size: bytes.byteLength }],
      skippedAttachments: (entry.skippedAttachments ?? []).filter((sk) => sk.name !== ref.name),
    }
    await writeControlRow({
      sessionId: id, siteId: access.siteId, role: CRM_EMAIL_IN_ROLE, message: JSON.stringify(next),
    })
    return NextResponse.json({ ok: true, name: ref.name, size: bytes.byteLength })
  } catch (e) {
    const authy = e instanceof GmailAuthError || e instanceof GmailScopeError
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Could not fetch the file.', needsReconnect: authy },
      { status: authy ? 401 : 502 },
    )
  }
}
