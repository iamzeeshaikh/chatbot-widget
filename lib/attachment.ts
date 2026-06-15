// File attachments in chat. A file message is stored in chat_logs like any
// other message, but its `message` text is a JSON marker so the widget and the
// dashboard can recognise and render it as an attachment instead of plain text:
//
//   {"__file":{"url":"…","name":"…","mime":"…","size":1234}}
//
// Files live in the public Supabase Storage bucket below. This module is the one
// place that knows the bucket name, limits, allowed types, and the marker shape.

export const ATTACHMENT_BUCKET = 'chat-attachments'
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB

// Allowed MIME types → canonical file extension.
export const ALLOWED_ATTACHMENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
}

export interface AttachmentInfo {
  url: string
  name: string
  mime: string
  size: number
}

export function isAllowedMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_ATTACHMENT_TYPES, mime)
}

export function extForMime(mime: string, fallbackName?: string): string {
  if (ALLOWED_ATTACHMENT_TYPES[mime]) return ALLOWED_ATTACHMENT_TYPES[mime]
  const m = (fallbackName ?? '').match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toLowerCase() : 'bin'
}

// A collision-proof storage path: siteId/sessionId/<timestamp>-<rand>.<ext>.
export function uniqueAttachmentPath(siteId: string, sessionId: string, mime: string, name: string): string {
  const ext = extForMime(mime, name)
  const rand = Math.random().toString(36).slice(2, 10)
  const safeSite = (siteId || 'site').replace(/[^a-zA-Z0-9_-]/g, '')
  const safeSession = (sessionId || 'session').replace(/[^a-zA-Z0-9_-]/g, '')
  return `${safeSite}/${safeSession}/${Date.now()}-${rand}.${ext}`
}

// Build the chat_logs message text for a file.
export function buildAttachmentMessage(info: AttachmentInfo): string {
  return JSON.stringify({ __file: info })
}

// Parse a message into AttachmentInfo, or null if it isn't a file message.
export function parseAttachment(message: string | null | undefined): AttachmentInfo | null {
  if (!message) return null
  const trimmed = message.trimStart()
  if (!trimmed.startsWith('{') || trimmed.indexOf('__file') === -1) return null
  try {
    const o = JSON.parse(trimmed)
    const f = o && o.__file
    if (f && typeof f.url === 'string') {
      return {
        url: f.url,
        name: typeof f.name === 'string' ? f.name : 'file',
        mime: typeof f.mime === 'string' ? f.mime : '',
        size: typeof f.size === 'number' ? f.size : 0,
      }
    }
  } catch { /* not a file message */ }
  return null
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}
