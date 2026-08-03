// Attachments on CRM email, in both directions.
//
// ── Where they live, and why ─────────────────────────────────────────────────
// A PRIVATE Supabase Storage bucket, `crm-email-attachments`, read through
// short-lived signed URLs.
//
// The widget's existing `chat-attachments` bucket is PUBLIC, which is right for
// it — a visitor has no session, so the URL has to be the credential. These are
// different: quote PDFs, customer artwork and purchase orders, only ever viewed
// by a signed-in agent. There is no reason for them to be world-readable, and a
// public URL to a customer's PO is a leak that outlives the lead. So they get
// their own bucket with `public: false` and 1-hour signed reads.
//
// ── Why the browser uploads straight to storage ──────────────────────────────
// Vercel caps a serverless request body at 4.5MB, so routing a 10MB PDF through
// our own API route would fail no matter what limit we set. The composer asks
// for a signed upload URL and PUTs to Supabase directly, which sidesteps the
// function entirely. Sending then reads the file back server-side, where the
// only budget is memory and the 60s timeout.

import { supabase } from './supabase'

export const EMAIL_ATTACHMENT_BUCKET = 'crm-email-attachments'

// ── limits ───────────────────────────────────────────────────────────────────
// Gmail rejects a message over 25MB, measured AFTER base64 encoding, which
// inflates by 4/3. So the raw ceiling is ~18MB and 15MB leaves room for the
// body, headers and MIME boundaries without ever getting a surprise 400 back
// from Gmail on something the agent has already written.
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024   // per file
export const MAX_EMAIL_ATTACHMENTS_TOTAL = 15 * 1024 * 1024  // per message, raw
export const MAX_EMAIL_ATTACHMENTS = 10                      // per message

// Inbound is a DIFFERENT limit from outbound, and was wrongly set to the same
// number. Outbound is capped by what Gmail will accept from us; inbound is
// already through Gmail, so the only question is what we are willing to store
// and spend sweep time on. 10MB refused an ordinary phone photo — IMG_1542.PNG
// at 11.3MB — which is not an edge case, it is the common case for artwork
// approvals. Gmail's own 25MB ceiling is the natural limit.
export const MAX_INBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_INBOUND_TOTAL_BYTES = 40 * 1024 * 1024

/** Whether a refusal is worth offering a retry for. */
export function isRetryableSkip(why: string): boolean {
  // Size and type are decisions, not failures — retrying repeats them. A
  // download or storage error is transient and worth another go, and so is a
  // size refusal recorded under an older, lower limit.
  return /could not be downloaded|could not be stored/i.test(why) || /too large/i.test(why)
}

// ── what may be carried ──────────────────────────────────────────────────────
// An ALLOWLIST, not a denylist: anything unrecognised is refused rather than
// waved through, so a new dangerous type cannot arrive by default. Covers what
// this business actually exchanges — quotes, artwork, spec sheets, POs.
export const ALLOWED_EMAIL_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tif',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/postscript': 'ai',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
}

// Belt and braces on top of the MIME allowlist: a sender controls the declared
// Content-Type, so an .exe announced as application/pdf would otherwise pass.
// These extensions are refused whatever the MIME says.
const BANNED_EXT = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'pif', 'scr', 'msi', 'msp', 'cpl', 'jar',
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'sh', 'bash', 'zsh',
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'lnk', 'reg', 'hta', 'iso', 'img',
])

export function extOf(name: string): string {
  const m = (name ?? '').match(/\.([a-zA-Z0-9]+)$/)
  return m ? m[1].toLowerCase() : ''
}

export function isDangerousName(name: string): boolean {
  const ext = extOf(name)
  if (!ext) return false
  if (BANNED_EXT.has(ext)) return true
  // Double extensions are the classic disguise: "quote.pdf.exe".
  const parts = (name ?? '').toLowerCase().split('.')
  return parts.slice(1).some((p) => BANNED_EXT.has(p))
}

export function isAllowedEmailAttachment(mime: string, name: string): boolean {
  if (isDangerousName(name)) return false
  return Object.prototype.hasOwnProperty.call(ALLOWED_EMAIL_MIME, (mime ?? '').toLowerCase())
}

export interface EmailAttachment {
  /** Storage path inside the private bucket — NOT a URL; URLs are signed on read. */
  path: string
  name: string
  mime: string
  size: number
}

export function parseEmailAttachments(v: unknown): EmailAttachment[] {
  if (!Array.isArray(v)) return []
  const out: EmailAttachment[] = []
  for (const a of v) {
    if (!a || typeof a.path !== 'string' || !a.path) continue
    out.push({
      path: a.path,
      name: typeof a.name === 'string' && a.name ? a.name : 'file',
      mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
      size: typeof a.size === 'number' ? a.size : 0,
    })
  }
  return out.slice(0, MAX_EMAIL_ATTACHMENTS)
}

/** Collision-proof path. Direction is in the name so storage is self-describing. */
export function attachmentPath(
  siteId: string, sessionId: string, direction: 'out' | 'in', name: string,
): string {
  const safe = (v: string) => (v || 'x').replace(/[^a-zA-Z0-9_-]/g, '')
  const ext = extOf(name) || 'bin'
  const rand = Math.random().toString(36).slice(2, 10)
  return `${safe(siteId)}/${safe(sessionId)}/${direction}-${Date.now()}-${rand}.${ext}`
}

/** Short-lived read URLs, minted per request — nothing is ever public. */
export async function signAttachments(
  atts: EmailAttachment[], seconds = 3600,
): Promise<(EmailAttachment & { url: string | null })[]> {
  if (atts.length === 0) return []
  const { data } = await supabase.storage
    .from(EMAIL_ATTACHMENT_BUCKET)
    .createSignedUrls(atts.map((a) => a.path), seconds)
  const byPath = new Map((data ?? []).map((d) => [d.path ?? '', d.signedUrl ?? null]))
  return atts.map((a) => ({ ...a, url: byPath.get(a.path) ?? null }))
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
