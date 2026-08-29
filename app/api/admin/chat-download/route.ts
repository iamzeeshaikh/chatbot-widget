import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, canAccessSession } from '@/lib/auth'
import { canSeeContacts, scrubText } from '@/lib/pii'
import { asUtcIso } from '@/lib/visitor'
import { VISIBLE_CONTROL_ROLES_IN } from '@/lib/controlroles'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from '@/lib/replyauthor'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from '@/lib/leadtracking'
import { parseAttachment, isImageMime } from '@/lib/attachment'
import { formatTime, dateDividerLabel, pktDayKey, formatDateTime } from '@/lib/datetime'
import { hasFeature } from '@/lib/workspaces'
import { buildChatPdf, type ChatItem } from '@/lib/chatpdf'

export const dynamic = 'force-dynamic'

// Download a conversation. For a workspace carrying the `chatpdf` feature
// (sports only, by request) the default is a PDF, with `?format=html` for the
// original single-file HTML export, which renders emoji and non-Latin scripts
// the PDF fonts cannot. Every other workspace gets the HTML file exactly as
// before — the feature gate lives HERE, not just in the UI (CLAUDE.md §3).
// In both, images are embedded; non-image attachments (PDFs) stay as links to
// the public bucket — inlining them would balloon the file without being
// viewable in-page anyway.

// An image over this size is linked instead of embedded, so one huge upload
// can't produce a file too big for mail/WhatsApp. (Uploads are capped at 10MB;
// base64 adds ~33%.)
const MAX_EMBED_BYTES = 8 * 1024 * 1024

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function fetchAsDataUri(url: string, mime: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_EMBED_BYTES) return null
    return `data:${mime || 'application/octet-stream'};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  if (!(await canAccessSession(member, sessionId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const hideContacts = !canSeeContacts(member)
  const format = hasFeature(member.workspace, 'chatpdf') && req.nextUrl.searchParams.get('format') !== 'html'
    ? 'pdf'
    : 'html'

  const [{ data: rows, error }, authorRes] = await Promise.all([
    supabase
      .from('chat_logs')
      .select('site_id, role, message, created_at')
      .eq('session_id', sessionId)
      .not('role', 'in', `(${VISIBLE_CONTROL_ROLES_IN})`) // keep lead_capture — rendered as a marker like the dashboard does
      .order('created_at', { ascending: true }),
    supabase
      .from('chat_logs')
      .select('created_at, message')
      .eq('session_id', sessionId)
      .eq('role', REPLY_AUTHOR_ROLE),
  ])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Raw created_at keys, same as /api/admin/messages: the author companion row
  // shares its reply's exact pre-normalisation timestamp.
  const authorByAt: Record<string, string> = {}
  for (const r of authorRes.data ?? []) {
    const a = parseReplyAuthor(r.message)
    if (a?.email) authorByAt[r.created_at] = a.email
  }

  const siteId = rows?.[0]?.site_id ?? ''
  const { data: siteRow } = siteId
    ? await supabase.from('sites').select('name').eq('site_id', siteId).maybeSingle()
    : { data: null }
  const siteName = siteRow?.name || siteId || 'Chat'

  // One neutral item list feeds both renderers, so the PDF and the HTML can
  // never disagree about what a row means.
  const items: ChatItem[] = []
  let lastDay = ''
  for (const m of rows ?? []) {
    if (m.message === '(session started)') continue
    const at = asUtcIso(m.created_at)

    const day = pktDayKey(at)
    if (day !== lastDay) {
      lastDay = day
      items.push({ kind: 'day', label: dateDividerLabel(at) })
    }

    if (m.role === LEAD_CAPTURE_ROLE) {
      const cap = parseLeadCapture(m.message)
      if (cap) {
        // A downloaded transcript is the one artefact that leaves the dashboard
        // entirely, so it gets the same treatment as the screen — the captured
        // contact line is the name only for a member who may not see contacts.
        const bits = (hideContacts ? [cap.name] : [cap.name, cap.email, cap.phone]).filter(Boolean).map(String)
        items.push({ kind: 'marker', text: `Lead captured${bits.length ? ' — ' + bits.join(' · ') : ''}` })
      }
      continue
    }

    const isVisitor = m.role === 'user' || m.role === 'visitor'
    const who = isVisitor ? 'Visitor' : m.role === 'assistant' ? 'Bot' : (authorByAt[m.created_at] ?? 'Agent')
    const side = isVisitor ? ('left' as const) : ('right' as const)
    const time = formatTime(at)

    const file = parseAttachment(m.message)
    if (file) items.push({ kind: 'file', side, who, time, name: file.name, url: file.url, mime: file.mime })
    else items.push({ kind: 'msg', side, who, time, text: (hideContacts ? scrubText(m.message) : m.message) ?? '' })
  }

  const exportedAt = formatDateTime(new Date().toISOString())
  const fileLabel = (siteId || 'chat').replace(/[^a-zA-Z0-9_-]/g, '')

  if (format === 'pdf') {
    const bytes = await buildChatPdf({ siteName, sessionId, exportedAt, items })
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="chat-${fileLabel}-${sessionId.slice(0, 8)}.pdf"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'day') {
      parts.push(`<div class="day"><span>${esc(item.label)}</span></div>`)
    } else if (item.kind === 'marker') {
      parts.push(`<div class="marker">${esc(item.text)}</div>`)
    } else if (item.kind === 'msg' || item.kind === 'file') {
      let body: string
      if (item.kind === 'file') {
        const safeName = esc(item.name)
        if (isImageMime(item.mime)) {
          const dataUri = await fetchAsDataUri(item.url, item.mime)
          body = dataUri
            ? `<img src="${dataUri}" alt="${safeName}" />`
            : `<a href="${esc(item.url)}">📎 ${safeName}</a>`
        } else {
          body = `<a href="${esc(item.url)}">📎 ${safeName}</a>`
        }
      } else {
        body = esc(item.text)
      }

      parts.push(
        `<div class="row ${item.side}"><div class="bubble ${item.side}">` +
        `<div class="meta">${esc(item.who)} · ${esc(item.time)}</div>` +
        `<div class="body">${body}</div>` +
        `</div></div>`
      )
    }
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(siteName)} — chat ${esc(sessionId.slice(0, 8))}</title>
<style>
  body { margin: 0; background: #f3f4f6; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111827; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
  header { text-align: center; margin-bottom: 20px; }
  header h1 { font-size: 18px; margin: 0 0 4px; }
  header p { margin: 0; color: #6b7280; font-size: 12px; }
  .day { text-align: center; margin: 18px 0 10px; color: #6b7280; font-size: 12px; }
  .day span { background: #e5e7eb; border-radius: 999px; padding: 2px 12px; }
  .marker { text-align: center; margin: 10px 0; color: #047857; font-size: 12px; font-weight: 600; }
  .row { display: flex; margin: 6px 0; }
  .row.left { justify-content: flex-start; }
  .row.right { justify-content: flex-end; }
  .bubble { max-width: 78%; border-radius: 14px; padding: 8px 12px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .bubble.left { background: #ffffff; border: 1px solid #e5e7eb; }
  .bubble.right { background: #dbeafe; border: 1px solid #bfdbfe; }
  .meta { font-size: 10px; color: #6b7280; margin-bottom: 3px; }
  .body { white-space: pre-wrap; word-break: break-word; }
  .body img { max-width: 100%; border-radius: 10px; display: block; }
  .body a { color: #2563eb; }
  footer { text-align: center; margin-top: 28px; color: #9ca3af; font-size: 11px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(siteName)}</h1>
  <p>Session ${esc(sessionId)}</p>
  <p>Exported ${esc(exportedAt)} · times in Pakistan time</p>
</header>
${parts.join('\n')}
<footer>Downloaded from the ZeeOps dashboard</footer>
</div>
</body>
</html>`

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="chat-${fileLabel}-${sessionId.slice(0, 8)}.html"`,
      'Cache-Control': 'no-store',
    },
  })
}
