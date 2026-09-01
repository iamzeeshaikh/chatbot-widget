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
  /** Files on the message.
   *
   *  INBOUND: Twilio's own media URLs, which need the account's credentials to
   *  fetch — so they are served back through our own endpoint, never handed to
   *  a browser as-is.
   *  OUTBOUND: a Storage path of ours, plus the original filename, so the
   *  timeline can show what was sent without a second round trip. */
  media?: { url?: string; type: string; path?: string; name?: string; size?: number }[]
  at: string
  /** Set on outbound: who pressed send. */
  sentBy?: string
  direction: 'inbound' | 'outbound'
  /** Outbound only: what WhatsApp did with it. Twilio reports this minutes
   *  after the send, against the message SID — 'queued'/'sent' mean accepted,
   *  'delivered'/'read' mean it arrived, 'failed'/'undelivered' mean it did
   *  not. Absent on rows written before delivery was tracked. */
  status?: string
  /** Twilio's numeric reason for a failure, e.g. 63016. */
  errorCode?: number
}

/** What a person should read on the timeline. The distinction that matters is
 *  accepted-by-Twilio versus actually-arrived: the first is not the second, and
 *  showing both as "sent" is what hid two undelivered messages. */
export function waDeliveryLabel(w: WaMessage): { title: string; failed: boolean } {
  if (w.direction !== 'outbound') return { title: 'WhatsApp received', failed: false }
  switch (w.status) {
    case 'delivered': return { title: 'WhatsApp delivered', failed: false }
    case 'read': return { title: 'WhatsApp read', failed: false }
    case 'failed':
    case 'undelivered': return { title: `WhatsApp not delivered${w.errorCode ? ` (${w.errorCode})` : ''}`, failed: true }
    // No status at all: a row from before delivery tracking, or a callback that
    // has not arrived yet. "Sent" is the honest word for accepted-not-confirmed.
    default: return { title: 'WhatsApp sent', failed: false }
  }
}

/** The 24-hour rule and its friends, in words an agent can act on. */
export function waErrorHint(code: number | undefined): string {
  switch (code) {
    case 63016: return 'WhatsApp only allows a free-form message within 24 hours of the customer’s last message. This one was outside that window, so it was not delivered. Wait for them to message first, or use an approved template.'
    case 63015: return 'That number has not joined the WhatsApp sandbox, so Twilio would not deliver to it.'
    case 63003: return 'That number is not reachable on WhatsApp.'
    case 63024: return 'WhatsApp refused this message. A business writing FIRST — before the customer has messaged you — needs an approved template; a free-form message is only allowed inside 24 hours of their last one.'
    case 63021: return 'WhatsApp would not take this attachment. It accepts photos (JPG/PNG), PDFs, MP4 video and audio as OGG/opus, AAC, MPEG or AMR — and nothing else.'
    default: return ''
  }
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
      status: typeof o.status === 'string' ? o.status : undefined,
      errorCode: typeof o.errorCode === 'number' ? o.errorCode : undefined,
    }
  } catch {
    return null
  }
}
