// A phone call placed from a lead's record.
//
// HOW IT WORKS, and why it is built this way:
//
//   agent presses Call
//        │
//        ├─ we ring the AGENT'S OWN PHONE (their number, stored per member)
//        │
//        └─ they answer, and Twilio then dials the CUSTOMER and bridges the two
//
// The customer sees the business's Twilio number, never the agent's. The agent
// never sees the customer's number — the CRM shows them "•••••• hidden" and the
// dialling happens on the server. Neither side learns the other's line, which is
// the whole reason this is not just a tel: link.
//
// Ringing the agent's phone rather than putting a softphone in the browser is a
// deliberate trade: it costs a second call leg, but it needs no headset, no
// browser permission, no tab left open, and it works when the agent is out.

export interface CallEntry {
  /** Twilio's call SID for the agent leg — the key both rows share. */
  sid: string
  /** Who placed it. */
  by: string
  at: string
  /** 'ringing' when placed; Twilio's final word once it ends. */
  status: string
  /** Seconds, once the call has ended. */
  duration?: number
  /** Set on a voicemail — the recording, fetched back through our own endpoint
   *  because Twilio's media URL needs the account's credentials. */
  recordingSid?: string
}

export function parseCall(message: string | null | undefined): CallEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.sid !== 'string') return null
    return {
      sid: o.sid,
      by: typeof o.by === 'string' ? o.by : '',
      at: typeof o.at === 'string' ? o.at : '',
      status: typeof o.status === 'string' ? o.status : '',
      duration: typeof o.duration === 'number' ? o.duration : undefined,
      recordingSid: typeof o.recordingSid === 'string' && o.recordingSid ? o.recordingSid : undefined,
    }
  } catch {
    return null
  }
}

/** "4m 12s" — what a person wants to read on a timeline. */
export function callDurationLabel(seconds: number | undefined): string {
  if (!seconds || seconds < 1) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
