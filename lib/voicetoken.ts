// The credential a BROWSER needs to become a phone.
//
// Why a softphone at all: the existing call flow rings the agent's own mobile
// and bridges it to the customer, which works anywhere but costs a second call
// leg and needs the agent to have a phone we are allowed to ring. The sports
// workspace has neither — the owner will not forward calls to his own line, and
// the agents are remote — so the call has to happen in the tab that is already
// open.
//
// WHAT THIS DOES NOT CHANGE: the agent still never learns the customer's
// number. The browser dials a LEAD ID; Twilio then asks our server what to do
// with it (/api/twilio/voice/dial), and the number is looked up there. Nothing
// with a phone number in it is ever sent to the browser.
//
// The token is a Twilio "access token": an ordinary JWT signed with an API Key
// Secret, carrying a Voice grant. Twilio's helper library exists but ships an
// HTTP client and a TwiML builder to sign 400 bytes of JSON, so it is signed
// here with node's crypto — the same choice lib/twilio.ts already made.
//
// ENVIRONMENT (all four, or the softphone reports itself unavailable):
//   TWILIO_ACCOUNT_SID       the account, "AC…"
//   TWILIO_API_KEY_SID       an API Key, "SK…"      (Console → API keys)
//   TWILIO_API_KEY_SECRET    that key's secret — shown ONCE at creation
//   TWILIO_TWIML_APP_SID     a TwiML App, "AP…", whose Voice URL points at
//                            /api/twilio/voice/dial

import { createHmac } from 'crypto'

/** How long a token lasts. Long enough for a shift, short enough that a leaked
 *  one is not a permanent phone line. The browser re-fetches before expiry. */
const TOKEN_TTL_SECONDS = 60 * 60

export interface VoiceTokenConfig {
  accountSid: string
  apiKeySid: string
  apiKeySecret: string
  appSid: string
}

export function voiceTokenConfig(): VoiceTokenConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const apiKeySid = process.env.TWILIO_API_KEY_SID
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET
  const appSid = process.env.TWILIO_TWIML_APP_SID
  if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) return null
  return { accountSid, apiKeySid, apiKeySecret, appSid }
}

/** Why the softphone cannot run, in words an admin can act on. */
export function voiceTokenProblem(): string | null {
  const missing = (['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_TWIML_APP_SID'] as const)
    .filter((k) => !process.env[k])
  if (missing.length === 0) return null
  return `In-browser calling is not set up yet (missing ${missing.join(', ')}).`
}

// ── Identity ────────────────────────────────────────────────────────────────
// Twilio's "identity" is the address of a client leg: an incoming call is
// routed with <Client>identity</Client>. It therefore has to be derivable from
// a member and reversible back to one.
//
// The member's EMAIL is the natural key (it is what every other control row
// uses), but an email is not a safe identity string — Twilio puts it in a URL
// and in TwiML, and an `@` or `+` there is a bug waiting to happen. So it is
// base64url encoded: reversible, and the alphabet is A-Za-z0-9-_ .
//
// This is not a secret and is not treated as one. Knowing an identity gets you
// nothing without a signed token minted for it.
const IDENTITY_PREFIX = 'agent-'

export function identityFor(email: string): string {
  return IDENTITY_PREFIX + Buffer.from(email.toLowerCase().trim()).toString('base64url')
}

/** The email behind an identity, or '' if it is not one of ours. Accepts the
 *  raw form and Twilio's `client:…` form, which is how it arrives in `From`. */
export function emailFromIdentity(identity: string): string {
  const raw = String(identity || '').replace(/^client:/, '')
  if (!raw.startsWith(IDENTITY_PREFIX)) return ''
  try {
    const email = Buffer.from(raw.slice(IDENTITY_PREFIX.length), 'base64url').toString('utf8')
    return /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : ''
  } catch {
    return ''
  }
}

function b64url(v: string): string {
  return Buffer.from(v).toString('base64url')
}

/**
 * Mint an access token for one member's browser.
 *
 * The grant is deliberately narrow: outgoing calls may only reach the one TwiML
 * App (so the browser cannot dial an arbitrary number — it can only ask our own
 * webhook to do something), and incoming is allowed so the business number can
 * ring the tab.
 */
export function mintVoiceToken(cfg: VoiceTokenConfig, identity: string): { token: string; identity: string; expiresIn: number } {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT', cty: 'twilio-fpa;v=1' }
  const payload = {
    jti: `${cfg.apiKeySid}-${now}`,
    iss: cfg.apiKeySid,
    sub: cfg.accountSid,
    iat: now,
    // A minute of slack, because a browser clock a little ahead of Twilio's
    // otherwise gets "token not yet valid" and no explanation.
    nbf: now - 60,
    exp: now + TOKEN_TTL_SECONDS,
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: cfg.appSid },
      },
    },
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac('sha256', cfg.apiKeySecret).update(signingInput).digest('base64url')
  return { token: `${signingInput}.${sig}`, identity, expiresIn: TOKEN_TTL_SECONDS }
}
