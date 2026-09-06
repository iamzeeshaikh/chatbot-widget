import { createHmac, timingSafeEqual } from 'crypto'

// "Did the customer open the email?" — the way every mail tracker answers it:
// a 1×1 image in the HTML part whose URL is unique to the message. The first
// request for it is the open. Recorded as a control row on the lead, so the
// record and the Inbox can say "Opened · 3:10 PM" next to the send.
//
// Honest limits, stated where the agent reads it: a client that blocks remote
// images never fires (no signal ≠ not read), and Apple Mail's privacy proxy
// may fire without a human (a signal ≠ certainly read). The pixel never leaves
// the HTML we stored, but the record page strips <img> when it re-renders that
// HTML (lib/richtext sanitise), so an AGENT looking at the record is never
// counted as the customer opening it.
export const CRM_EMAIL_OPEN_ROLE = 'crm_email_open'

export interface CrmEmailOpenEntry { emailId: string; at: string; ua?: string }

function secret(): string {
  return process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
}

// The token binds lead + email id, so a URL cannot be minted for another lead.
export function openToken(sessionId: string, emailId: string): string {
  return createHmac('sha256', secret()).update(`${sessionId}|${emailId}`).digest('hex').slice(0, 32)
}

export function verifyOpenToken(token: string, sessionId: string, emailId: string): boolean {
  const want = openToken(sessionId, emailId)
  if (token.length !== want.length) return false
  return timingSafeEqual(Buffer.from(token), Buffer.from(want))
}

export function openPixelHtml(baseUrl: string, sessionId: string, emailId: string): string {
  const url = `${baseUrl}/api/track/open/${openToken(sessionId, emailId)}.gif?l=${encodeURIComponent(sessionId)}&e=${encodeURIComponent(emailId)}`
  return `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`
}

export function parseCrmEmailOpen(message: string): CrmEmailOpenEntry | null {
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.emailId !== 'string' || typeof o.at !== 'string') return null
    return { emailId: o.emailId, at: o.at, ua: typeof o.ua === 'string' ? o.ua : undefined }
  } catch { return null }
}

// A 1×1 transparent GIF.
export const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
