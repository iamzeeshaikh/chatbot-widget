// The greeting a caller hears when no one picks up, and the recording that
// follows it.
//
// It lives in lib/ rather than beside the route because TWO routes play it: the
// incoming handler, when the softphone is not configured at all, and the
// after-dial handler, when the browsers rang out. A second copy would be a
// second thing to keep in step, and the wording is the business's voice.
//
// The caller's number travels in the recording callback's QUERY STRING, because
// Twilio's recording callback does not send `From` — reading it there found
// nothing and dropped every voicemail in silence. The webhook signature covers
// the query string too, so this stays verifiable.

function escapeXml(v: string): string {
  return v.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] ?? c))
}

/** The greeting + recording, used when no browser picks up. Also used on its
 *  own when the softphone is not configured at all. */
export function voicemailTwiml(origin: string, caller: string, called = ''): string {
  return '<Say voice="Polly.Joanna">Thanks for calling. Our team is not available right now.</Say>'
    + '<Say voice="Polly.Joanna">Please leave your name, your team, and what you need after the tone, and we will get back to you.</Say>'
    + `<Record maxLength="120" playBeep="true" trim="trim-silence"`
    + ` recordingStatusCallback="${escapeXml(`${origin}/api/twilio/voice/recording?from=${encodeURIComponent(caller)}&to=${encodeURIComponent(called)}`)}"`
    + ' recordingStatusCallbackMethod="POST" />'
    + '<Say voice="Polly.Joanna">We did not get a message. Goodbye.</Say>'
}
