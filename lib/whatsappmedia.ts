// Files, images and voice notes on WhatsApp.
//
// WHAT WHATSAPP ACTUALLY ALLOWS, which is narrower than email and worth knowing
// before an agent picks a file: images (JPEG/PNG), audio, video, and PDF —
// 16MB a message. Office documents and zips, which the email composer accepts
// happily, are NOT deliverable here, and finding that out from Twilio's error
// after the customer has been told "sending it now" is the bad version of this.
//
// VOICE NOTES are just audio: the customer's recording arrives as audio/ogg
// (opus), and one we send goes out as audio too. Nothing special is needed
// beyond letting audio through and giving the timeline a player.
//
// Storage reuses the CRM's existing attachment bucket rather than adding one:
// there is no bucket-creation step in this project's deploy, a second bucket
// would need its own size limit set by hand, and the path prefix already keeps
// the two apart.

import { supabase } from './supabase'
import { EMAIL_ATTACHMENT_BUCKET } from './emailattach'

export const WHATSAPP_MEDIA_BUCKET = EMAIL_ATTACHMENT_BUCKET

/** Meta's own ceiling. Sending more comes back as a failure, not a truncation. */
export const MAX_WHATSAPP_MEDIA_BYTES = 16 * 1024 * 1024

const ALLOWED_PREFIXES = ['image/jpeg', 'image/png', 'image/webp', 'audio/', 'video/mp4', 'video/3gpp', 'application/pdf']

export function isAllowedWhatsAppMedia(mime: string, name: string): boolean {
  const m = (mime || '').toLowerCase()
  if (ALLOWED_PREFIXES.some((p) => m === p || (p.endsWith('/') && m.startsWith(p)))) return true
  // A browser that sends no MIME type at all still has a filename to go on.
  if (!m) return /\.(jpe?g|png|webp|pdf|mp3|m4a|ogg|opus|wav|amr|aac|mp4|3gp)$/i.test(name)
  return false
}

export function whatsappMediaKind(mime: string, name = ''): 'image' | 'audio' | 'video' | 'file' {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  if (!m) {
    if (/\.(jpe?g|png|webp)$/i.test(name)) return 'image'
    if (/\.(mp3|m4a|ogg|opus|wav|amr|aac)$/i.test(name)) return 'audio'
    if (/\.(mp4|3gp)$/i.test(name)) return 'video'
  }
  return 'file'
}

export function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

/** Where an outbound file lives. Site and lead in the path so a stray object is
 *  traceable, and a timestamp so re-sending the same filename never collides. */
export function whatsappMediaPath(siteId: string, leadId: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
  return `whatsapp/${siteId}/${leadId}/${Date.now()}-${safe}`
}

/**
 * A URL Twilio can fetch.
 *
 * Twilio downloads the media itself, from its own servers, so the link has to
 * be reachable WITHOUT our session cookie — a normal API route would hand it a
 * login page. A signed Storage URL is public but time-limited and unguessable,
 * which is the right shape: long enough for the send, short enough that it is
 * not a permanent copy of a customer's document on the open internet.
 */
export async function signedMediaUrl(path: string, seconds = 900): Promise<string | null> {
  const { data } = await supabase.storage.from(WHATSAPP_MEDIA_BUCKET).createSignedUrl(path, seconds)
  return data?.signedUrl ?? null
}
