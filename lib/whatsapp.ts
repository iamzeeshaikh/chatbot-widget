// WhatsApp messages on a lead's timeline.
//
// Stored the way everything else in this CRM is stored: append-only control
// rows on the lead's session id, one role per direction. No DDL, no new table,
// and the timeline picks them up beside the emails.

export interface WaMessage {
  /** Twilio's message SID — the dedupe key for inbound. */
  sid: string
  /** E.164, as Twilio reports it. Masked on read like every other contact. */
  from: string
  to: string
  body: string
  /** Files the customer sent, as Twilio media URLs (fetched through us). */
  media?: { url: string; type: string }[]
  at: string
  /** Set on outbound: who pressed send. */
  sentBy?: string
  direction: 'inbound' | 'outbound'
}

export function parseWaMessage(message: string | null | undefined): WaMessage | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.sid !== 'string') return null
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return {
      sid: o.sid,
      from: str(o.from), to: str(o.to), body: str(o.body),
      media: Array.isArray(o.media) ? o.media : undefined,
      at: str(o.at), sentBy: o.sentBy ? str(o.sentBy) : undefined,
      direction: o.direction === 'outbound' ? 'outbound' : 'inbound',
    }
  } catch {
    return null
  }
}
