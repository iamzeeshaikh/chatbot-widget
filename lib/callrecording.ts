// Recording an ANSWERED call — the phone line and WhatsApp calls alike.
//
// A voicemail was already recorded (lib/voicemail.ts's <Record>), but a call
// somebody actually picked up left nothing behind except its length. That is
// the call worth keeping: what was agreed, what size, what price. So every
// <Dial> in this codebase carries these attributes.
//
// WHY IT IS ONE HELPER AND NOT THREE COPIES: there are three places a call is
// bridged — an inbound call ringing the browsers, the browser softphone
// dialling out, and the ring-my-mobile flow — and a fourth will exist the day
// something else dials. Attributes pasted three times are attributes that
// diverge; the day one of them loses `recordingStatusCallback` its recordings
// simply never arrive, with nothing failing to say so.
//
// dual-channel: the agent and the customer land on separate stereo channels,
// so overlapping speech is still separable when somebody has to go back and
// settle what was actually said.

function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c))
}

/**
 * The `record` / `recordingStatusCallback` attributes for a <Dial>, ready to be
 * concatenated into the tag (leading space included).
 *
 * `ctx` is what the callback will need to file the recording, since Twilio's
 * recording callback sends neither `From` nor the lead — only a RecordingSid
 * and the parent CallSid. Either:
 *   • `leadId` — the record is already known (an agent dialled FROM it), or
 *   • `from`/`to` — an inbound call, whose lead is resolved by phone number
 *     exactly as the voicemail and WhatsApp paths resolve theirs.
 */
export function recordAttrs(origin: string, ctx: { leadId?: string; from?: string; to?: string }): string {
  const q = new URLSearchParams({ kind: 'call' })
  if (ctx.leadId) q.set('leadId', ctx.leadId)
  if (ctx.from) q.set('from', ctx.from)
  if (ctx.to) q.set('to', ctx.to)
  const cb = `${origin}/api/twilio/voice/recording?${q.toString()}`
  return ' record="record-from-answer-dual"'
    + ` recordingStatusCallback="${escapeXml(cb)}"`
    + ' recordingStatusCallbackMethod="POST"'
    + ' recordingStatusCallbackEvent="completed"'
}

/** Said to a caller before their call is connected, because recording someone
 *  without telling them is not ours to decide. Inbound only — on an outbound
 *  call the agent is on the line from the first second and says it themselves. */
export const RECORDING_NOTICE =
  '<Say voice="Polly.Joanna">Please note, this call may be recorded for quality and training.</Say>'
