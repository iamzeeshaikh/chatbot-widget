// Gmail send-as-the-agent, over the Gmail REST API.
//
// ── Why its own OAuth ────────────────────────────────────────────────────────
// This flow is deliberately standalone: its own route, its own scopes
// (gmail.send + gmail.settings.basic) and its own consent screen. It is not
// layered onto any other Google integration, so revoking mail access can never
// take anything else down with it. (There is, as it happens, no other Google
// OAuth in this repo today.)
//
// ── No DDL ───────────────────────────────────────────────────────────────────
// Tokens live where every other piece of per-member state lives: a chat_logs
// control row on the reserved zeeops-crm site, newest row per email wins.
//
// ── Tokens are secrets ───────────────────────────────────────────────────────
// A refresh token is a standing permission to send mail as that person, so it is
// NEVER stored in plaintext. It is sealed with AES-256-GCM under GMAIL_TOKEN_KEY,
// which lives only in the environment. A dump of chat_logs therefore hands over
// nothing usable. The plaintext token never leaves this module — no route
// returns it, and it is never logged.

import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'crypto'
import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'

export const GMAIL_TOKEN_ROLE = 'gmail_token'
export const GMAIL_TOKEN_SESSION = 'zeeops-crm-gmail'

// REQUIRED to connect at all. Deliberately unchanged by Phase 6: an agent who
// consented before it shipped keeps sending without interruption.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.settings.basic',
] as const

// ADDITIONAL, and optional. Reading a customer's reply needs a read scope, and
// the Gmail API has no per-thread one: gmail.metadata returns headers without
// bodies, and nothing narrower than gmail.readonly exists. So the restriction
// has to be enforced by us — the sweep only ever fetches threadIds we recorded
// when WE sent something, and never lists the mailbox (see lib/emailreply.ts).
//
// It is requested alongside the two required scopes but NOT required: a
// connection missing it still sends, and reply capture reports itself as
// needing a reconnect rather than silently doing nothing.
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export const ALL_GMAIL_SCOPES = [...GMAIL_SCOPES, GMAIL_READ_SCOPE] as const

export function hasReadScope(scope: string | null | undefined): boolean {
  return (scope ?? '').split(/\s+/).includes(GMAIL_READ_SCOPE)
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

// ── config ───────────────────────────────────────────────────────────────────
export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }

export function googleConfig(origin: string): GoogleConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  // The redirect URI is derived from the request's own origin so the same
  // credentials work on localhost and on every deployed alias, but it must be
  // registered in the Google console for each.
  return { clientId, clientSecret, redirectUri: `${origin}/api/google/gmail/callback` }
}

/** Human-readable reason the integration cannot run, or null when it can. */
export function configProblem(): string | null {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return 'Google OAuth is not configured on the server (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).'
  }
  if (!process.env.GMAIL_TOKEN_KEY) {
    return 'GMAIL_TOKEN_KEY is not set, so refresh tokens cannot be encrypted at rest.'
  }
  return null
}

// ── encryption ───────────────────────────────────────────────────────────────
function key(): Buffer {
  const raw = process.env.GMAIL_TOKEN_KEY
  if (!raw) throw new Error('GMAIL_TOKEN_KEY is not set')
  // Accept a 32-byte key in hex or base64; anything else is hashed to 32 bytes
  // so a passphrase still yields a valid key rather than throwing at send time.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex')
  const b = Buffer.from(raw, 'base64')
  if (b.length === 32) return b
  return createHash('sha256').update(raw).digest()
}

function seal(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`
}

function open(sealed: string): string | null {
  try {
    const [iv, tag, data] = sealed.split('.')
    if (!iv || !tag || !data) return null
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8')
  } catch {
    // A wrong or rotated key must read as "not connected", not crash a page.
    return null
  }
}

// ── stored connection ────────────────────────────────────────────────────────
interface StoredToken {
  email: string
  enc: string
  connectedAt: string
  scope: string
  /** Set when Google refused the refresh token — the agent must reconnect. */
  revoked?: boolean
  revokedReason?: string
}

export interface GmailConnection {
  email: string
  connectedAt: string
  revoked: boolean
  revokedReason?: string
  /** Whether this consent included the read scope, i.e. can capture replies. */
  canRead: boolean
}

async function writeToken(row: StoredToken): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE,
    session_id: GMAIL_TOKEN_SESSION,
    role: GMAIL_TOKEN_ROLE,
    message: JSON.stringify(row),
  })
}

async function readToken(email: string): Promise<StoredToken | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', GMAIL_TOKEN_ROLE)
    .eq('session_id', GMAIL_TOKEN_SESSION)
    .order('created_at', { ascending: false })
    .limit(400)
  const target = email.toLowerCase()
  for (const r of data ?? []) {
    try {
      const o = JSON.parse(r.message) as StoredToken
      if (o?.email?.toLowerCase() === target) return o // descending → newest first
    } catch { /* skip */ }
  }
  return null
}

export async function connectionFor(email: string): Promise<GmailConnection | null> {
  const t = await readToken(email)
  if (!t) return null
  return {
    email: t.email, connectedAt: t.connectedAt, revoked: !!t.revoked,
    revokedReason: t.revokedReason, canRead: hasReadScope(t.scope),
  }
}

/**
 * Every address with a live (non-revoked) Gmail connection.
 *
 * Used only to answer "then who CAN send this?" when somebody's own account
 * cannot. Worth naming rather than leaving them to guess: this OAuth app is
 * INTERNAL to one Google Workspace org, so a consumer Gmail is refused by
 * Google itself with `403 org_internal` — and a member who is told to go and
 * connect theirs can spend a while finding that out.
 */
export async function connectedAddresses(): Promise<string[]> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', GMAIL_TOKEN_ROLE)
    .eq('session_id', GMAIL_TOKEN_SESSION)
    .order('created_at', { ascending: true })
    .limit(400)
  const live = new Map<string, boolean>()   // ascending → the newest row wins
  for (const r of data ?? []) {
    try {
      const o = JSON.parse(r.message) as StoredToken
      if (o?.email) live.set(o.email.toLowerCase(), !o.revoked)
    } catch { /* skip */ }
  }
  return Array.from(live.entries()).filter(([, ok]) => ok).map(([e]) => e).sort()
}

export async function saveConnection(email: string, refreshToken: string, scope: string): Promise<void> {
  await writeToken({ email, enc: seal(refreshToken), connectedAt: new Date().toISOString(), scope })
  forgetAccessToken(email)
}

export async function markRevoked(email: string, reason: string): Promise<void> {
  const t = await readToken(email)
  await writeToken({
    email,
    enc: t?.enc ?? '',
    connectedAt: t?.connectedAt ?? new Date().toISOString(),
    scope: t?.scope ?? '',
    revoked: true,
    revokedReason: reason,
  })
  forgetAccessToken(email)
}

export async function disconnect(email: string): Promise<void> {
  await markRevoked(email, 'Disconnected by the agent')
}

// ── OAuth state ──────────────────────────────────────────────────────────────
// Signed with the app's own AUTH_SECRET and carrying the member's email, so the
// callback can prove the code it receives belongs to the session that began the
// flow (CSRF) without any server-side store. It also ferries the page to return
// to afterwards.
export function signState(email: string, back: string): string {
  const payload = Buffer.from(JSON.stringify({ e: email, b: back, t: Date.now() })).toString('base64url')
  return `${payload}.${createHmac('sha256', stateSecret()).update(payload).digest('base64url')}`
}

export function verifyState(state: string): { email: string; back: string } | null {
  const [payload, sig] = (state ?? '').split('.')
  if (!payload || !sig) return null
  const expect = createHmac('sha256', stateSecret()).update(payload).digest('base64url')
  // Constant-time compare on equal-length buffers.
  const a = Buffer.from(sig), b = Buffer.from(expect)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    // Ten minutes is plenty for a consent screen and keeps a leaked link short-lived.
    if (typeof o?.t !== 'number' || Date.now() - o.t > 10 * 60 * 1000) return null
    return { email: String(o.e ?? ''), back: typeof o.b === 'string' ? o.b : '/' }
  } catch {
    return null
  }
}

function stateSecret(): string {
  return process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev-secret'
}

// ── OAuth ────────────────────────────────────────────────────────────────────
export function consentUrl(cfg: GoogleConfig, state: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: ALL_GMAIL_SCOPES.join(' '),
    // offline + consent is what actually yields a refresh token; without
    // prompt=consent Google withholds it on a repeat authorisation and the
    // connection silently cannot be renewed later.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  })
  if (loginHint) p.set('login_hint', loginHint)
  return `${AUTH_URL}?${p.toString()}`
}

export interface TokenExchange { accessToken: string; refreshToken: string | null; scope: string; email: string | null }

export async function exchangeCode(cfg: GoogleConfig, code: string): Promise<TokenExchange> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error_description || j.error || 'Google rejected the authorisation code')

  // The id_token carries the account that actually consented. Only the payload
  // is read (to learn which mailbox was connected); it is not trusted for
  // authorisation, which comes from our own session.
  let email: string | null = null
  if (typeof j.id_token === 'string') {
    try {
      const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8'))
      if (typeof payload?.email === 'string') email = payload.email
    } catch { /* leave null */ }
  }
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, scope: j.scope ?? '', email }
}

export class GmailAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'GmailAuthError' }
}

/**
 * Gmail said "too many requests", not "I don't know who you are".
 *
 * Google reports a rate limit as a 429 AND, confusingly, as a 403 whose reason
 * is rateLimitExceeded / userRateLimitExceeded / quotaExceeded — the
 * "Quota exceeded for quota metric 'Total Query Cost'" message. We used to
 * treat every 403 as an auth failure, so an agent whose reply landed in a busy
 * minute was told to "Reconnect Gmail". Reconnecting fixes nothing here.
 * Waiting does, which is why this is its own error and why the calls below
 * retry before ever surfacing it.
 */
export class GmailRateError extends Error {
  retryAfterMs: number
  constructor(message: string, retryAfterMs = 0) {
    super(message); this.name = 'GmailRateError'; this.retryAfterMs = retryAfterMs
  }
}

const RATE_REASONS = new Set([
  'ratelimitexceeded', 'userratelimitexceeded', 'quotaexceeded', 'dailylimitexceeded',
])

type GoogleError = { error?: { message?: string; status?: string; errors?: { reason?: string }[] } }

/** Is this response Google throttling us, rather than refusing us? */
export function isRateLimited(status: number, j: GoogleError): boolean {
  if (status === 429) return true
  if (status !== 403) return false
  for (const e of j?.error?.errors ?? []) {
    if (RATE_REASONS.has(String(e?.reason ?? '').toLowerCase())) return true
  }
  if (String(j?.error?.status ?? '').toUpperCase() === 'RESOURCE_EXHAUSTED') return true
  // The Cloud quota system phrases it in prose and supplies no `reason` at all.
  return /quota exceeded|rate limit|too many requests/i.test(String(j?.error?.message ?? ''))
}

// Background work gives up quickly and tries again on the next run. A send is
// somebody sitting in front of a composer, so it waits: five attempts spread
// over roughly twenty seconds, which is longer than the sweep's own burst and
// therefore long enough to outlive the thing that is starving it.
const RATE_RETRIES = 3
const SEND_RATE_RETRIES = 5

function backoffMs(attempt: number, retryAfter: string | null, patient = false): number {
  const hinted = Number(retryAfter)
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, patient ? 15000 : 8000)
  const cap = patient ? 8000 : 4000
  // Jittered, so concurrent sweep fetches do not all come back at once.
  return Math.min(400 * 2 ** attempt, cap) + Math.floor(Math.random() * (patient ? 600 : 250))
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * One Gmail API call, retried through a throttle.
 *
 * A rate-limited request is refused before Gmail acts on it, so retrying a send
 * cannot deliver the message twice. Anything that is not a rate limit is
 * returned untouched for the caller to interpret.
 */
async function gapi(
  url: string, init: RequestInit, what: string, patient = false,
): Promise<{ res: Response; json: GoogleError & Record<string, unknown> }> {
  const limit = patient ? SEND_RATE_RETRIES : RATE_RETRIES
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init)
    const json = res.status === 204
      ? {}
      : await res.json().catch(() => ({})) as GoogleError & Record<string, unknown>
    if (!isRateLimited(res.status, json)) return { res, json }
    if (attempt >= limit) {
      throw new GmailRateError(
        `Gmail is rate-limiting this mailbox at the moment, so ${what} did not go through. ` +
        'The connection is fine — wait a minute and try again.',
      )
    }
    await sleep(backoffMs(attempt, res.headers.get('retry-after'), patient))
  }
}

// ── caches ───────────────────────────────────────────────────────────────────
// A Google access token is valid for an hour, yet every Gmail call used to mint
// a fresh one: a 240-thread sweep meant 240 token POSTs and 240 database reads
// on top of the 240 Gmail calls, and that burst is what starved an agent's own
// reply of quota. Held in memory only, per instance, and dropped the moment a
// connection changes or Gmail answers 401.
const tokenCache = new Map<string, { token: string; expires: number }>()
// Well under the token's own hour, so a connection revoked elsewhere stops
// working here within minutes rather than within the hour.
const TOKEN_CACHE_MAX_MS = 10 * 60 * 1000

export function forgetAccessToken(email: string): void {
  tokenCache.delete(email.toLowerCase())
  aliasCache.delete(email.toLowerCase())
}

const aliasCache = new Map<string, { at: number; list: SendAsAlias[] }>()
const ALIAS_CACHE_MS = 5 * 60 * 1000

/** Fresh access token for an agent, or a clear error saying to reconnect. */
export async function accessTokenFor(email: string, cfg: GoogleConfig): Promise<string> {
  const key = email.toLowerCase()
  const hit = tokenCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.token

  const t = await readToken(email)
  if (!t) throw new GmailAuthError('Gmail is not connected for this account. Connect it to send email.')
  if (t.revoked) throw new GmailAuthError(t.revokedReason || 'Gmail access was revoked. Reconnect to send email.')
  const refresh = open(t.enc)
  if (!refresh) {
    throw new GmailAuthError('The stored Gmail credential could not be read. Reconnect Gmail to send email.')
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      refresh_token: refresh, grant_type: 'refresh_token',
    }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    // invalid_grant means the user really did revoke access or change their
    // password. Record THAT, so the UI can say "reconnect" instead of retrying
    // forever.
    if (j.error === 'invalid_grant') {
      const reason = 'Google has revoked this Gmail connection (access withdrawn or password changed). Reconnect to send email.'
      await markRevoked(email, reason)
      throw new GmailAuthError(reason)
    }
    // Anything else — Google throttling the token endpoint, a 5xx, a network
    // blip — is temporary. Marking it revoked here was a bug: one bad minute
    // permanently flagged a working connection and forced a needless reconnect.
    if (res.status === 429 || res.status >= 500 || j.error === 'slow_down') {
      throw new GmailRateError(
        'Google is throttling this account\u2019s sign-in right now. The connection is fine \u2014 try again in a few seconds.',
      )
    }
    throw new GmailAuthError(
      `Google refused to refresh the Gmail token: ${j.error_description || j.error || res.status}`,
    )
  }

  const token = j.access_token as string
  const lifetimeMs = (Number(j.expires_in) || 3600) * 1000
  tokenCache.set(key, {
    token,
    // A minute of headroom, so a token never expires mid-flight.
    expires: Date.now() + Math.min(lifetimeMs - 60_000, TOKEN_CACHE_MAX_MS),
  })
  return token
}

// ── verified aliases ─────────────────────────────────────────────────────────
export interface SendAsAlias {
  email: string
  displayName: string
  isPrimary: boolean
  isDefault: boolean
}

// The list Google itself considers verified. The client is never trusted for
// this: a from-address is checked against THIS list at send time, so an agent
// cannot spoof an address Google has not confirmed they own.
export async function verifiedAliases(email: string, cfg: GoogleConfig): Promise<SendAsAlias[]> {
  // Verified aliases change about once a year. Re-reading them on every single
  // send spent a Gmail call — and the quota that went with it — proving
  // something that had not moved since the last message.
  const key = email.toLowerCase()
  const cached = aliasCache.get(key)
  if (cached && Date.now() - cached.at < ALIAS_CACHE_MS) return cached.list

  const token = await accessTokenFor(email, cfg)
  const { res, json: j } = await gapi(
    `${API}/settings/sendAs`, { headers: { Authorization: `Bearer ${token}` } },
    'your send-as addresses could not be read', true,
  )
  if (res.status === 401 || res.status === 403) {
    forgetAccessToken(email)
    throw new GmailAuthError('Gmail refused the request. Reconnect Gmail and grant the alias permission.')
  }
  if (!res.ok) throw new Error(`Could not read your Gmail aliases (${res.status})`)
  type RawAlias = { sendAsEmail: string; displayName?: string; isPrimary?: boolean; isDefault?: boolean; verificationStatus?: string }
  const list: SendAsAlias[] = ((j.sendAs as RawAlias[]) ?? [])
    .filter((a: { verificationStatus?: string; isPrimary?: boolean }) =>
      // The primary address needs no verification; every alias must be
      // 'accepted' before Google will let it be used as a From.
      a.isPrimary === true || a.verificationStatus === 'accepted')
    .map((a: { sendAsEmail: string; displayName?: string; isPrimary?: boolean; isDefault?: boolean }) => ({
      email: a.sendAsEmail,
      displayName: a.displayName ?? '',
      isPrimary: a.isPrimary === true,
      isDefault: a.isDefault === true,
    }))
  aliasCache.set(key, { at: Date.now(), list })
  return list
}

// ── sending ──────────────────────────────────────────────────────────────────
export interface OutgoingEmail {
  from: string
  fromName?: string
  to: string
  cc?: string
  subject: string
  body: string
  /** The same message with formatting. When present it is sent ALONGSIDE
   *  `body` as a multipart/alternative, never instead of it — a client that
   *  cannot render HTML falls back to the plain part, and a message with only
   *  an HTML part arrives blank in those. */
  html?: string
  // ── threading (Phase 6) ────────────────────────────────────────────────────
  // Both halves are needed and they do different jobs. `threadId` is Gmail's
  // own grouping and is what keeps the message in the same conversation in the
  // sender's mailbox. In-Reply-To / References are the RFC 5322 headers every
  // OTHER mail client threads on — without them the customer's Gmail, Outlook
  // or Apple Mail shows a brand-new conversation even though ours looks right.
  /** Gmail thread to append to. */
  threadId?: string
  /** RFC Message-ID of the message being replied to. */
  inReplyTo?: string
  /** The full chain, oldest first — In-Reply-To is appended to it. */
  references?: string[]
  /** Files already fetched into memory, ready to be encoded into the MIME. */
  attachments?: { name: string; mime: string; bytes: Uint8Array }[]
  /** Extra headers, e.g. List-Unsubscribe on a promotional email. Values are
   *  stripped of CR/LF like every other header. */
  headers?: Record<string, string>
}

export interface SentResult { id: string; threadId: string; messageId: string }

/** RFC 5322 with a UTF-8 body. Headers are encoded so non-ASCII names survive. */
// RFC 2047 for a filename that is not plain ASCII, so "devis-été.pdf" arrives
// with its name intact rather than as mojibake.
function encWord(s: string): string {
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
}

function buildMime(m: OutgoingEmail, messageId: string): string {
  const enc = (s: string) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)
  // Strip CR/LF from header values — an unescaped newline in a subject is a
  // header-injection vector.
  const h = (s: string) => s.replace(/[\r\n]+/g, ' ').trim()
  const from = m.fromName ? `${enc(h(m.fromName))} <${h(m.from)}>` : h(m.from)

  const lines = [
    `From: ${from}`,
    `To: ${h(m.to)}`,
    ...(m.cc ? [`Cc: ${h(m.cc)}`] : []),
    `Subject: ${enc(h(m.subject))}`,
    `Message-ID: ${messageId}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${h(m.inReplyTo)}`] : []),
    // References carries the whole ancestry; duplicates are dropped so a long
    // exchange does not grow a header full of repeats.
    ...(() => {
      const chain = [...(m.references ?? []), ...(m.inReplyTo ? [m.inReplyTo] : [])]
        .map((r) => h(r)).filter(Boolean)
      const seen = new Set<string>()
      const uniq = chain.filter((r) => (seen.has(r) ? false : (seen.add(r), true)))
      return uniq.length ? [`References: ${uniq.join(' ')}`] : []
    })(),
    ...Object.entries(m.headers ?? {})
      .filter(([k]) => /^[A-Za-z][A-Za-z0-9-]*$/.test(k))
      .map(([k, v]) => `${k}: ${h(v)}`),
    'MIME-Version: 1.0',
  ]

  const b64 = (buf: Buffer) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n')
  const part = (mime: string, content: string) => [
    `Content-Type: ${mime}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from(content, 'utf8')),
  ]

  // A formatted message is multipart/alternative: the SAME message twice, plain
  // first and HTML second. Order matters — a client shows the LAST part it can
  // render, so plain-then-html means "use the formatting if you can".
  let bodyPart: string[]
  let bodyHeader: string[] = []
  if (m.html) {
    const alt = `zee_alt_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`
    bodyHeader = [`Content-Type: multipart/alternative; boundary="${alt}"`]
    bodyPart = [
      '',
      `--${alt}`,
      ...part('text/plain', m.body),
      '',
      `--${alt}`,
      ...part('text/html', m.html),
      '',
      `--${alt}--`,
    ]
  } else {
    bodyPart = part('text/plain', m.body)
  }

  // No attachments: keep the message single-part (or a bare alternative), so
  // the common case gains no MIME machinery it does not need.
  if (!m.attachments?.length) {
    return [...lines, ...bodyHeader, ...bodyPart].join('\r\n')
  }

  // multipart/mixed: the text first, then one part per file. The boundary is
  // random so it cannot collide with anything inside the content.
  const boundary = `zee_${Date.now().toString(36)}_${randomBytes(12).toString('hex')}`
  const out = [
    ...lines,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...bodyHeader,
    ...bodyPart,
  ]
  for (const a of m.attachments) {
    const filename = encWord(h(a.name))
    out.push(
      '',
      `--${boundary}`,
      `Content-Type: ${h(a.mime) || 'application/octet-stream'}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64(Buffer.from(a.bytes)),
    )
  }
  out.push('', `--${boundary}--`, '')
  return out.join('\r\n')
}

export async function sendEmail(agentEmail: string, cfg: GoogleConfig, m: OutgoingEmail): Promise<SentResult> {
  const token = await accessTokenFor(agentEmail, cfg)

  // Verify the From against Google's own list on every send — the composer's
  // dropdown is a convenience, not the authority.
  const aliases = await verifiedAliases(agentEmail, cfg)
  const match = aliases.find((a) => a.email.toLowerCase() === m.from.trim().toLowerCase())
  if (!match) {
    throw new Error(`"${m.from}" is not a verified send-as address on your Google account.`)
  }

  // A Message-ID we generate ourselves, so a future inbound reply can be tied
  // back to this exact send via its In-Reply-To/References header (Phase 6).
  const domain = m.from.split('@')[1] || 'zeeops.dev'
  const messageId = `<${Date.now().toString(36)}.${randomBytes(8).toString('hex')}@${domain}>`

  const raw = Buffer.from(buildMime({ ...m, fromName: m.fromName || match.displayName }, messageId), 'utf8')
    .toString('base64url')

  // A throttled send is refused before Gmail acts on it, so the retry inside
  // gapi() cannot deliver the same message twice.
  const { res, json: j } = await gapi(`${API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // threadId here is what makes Gmail file it in the existing conversation
    // rather than starting a new one.
    body: JSON.stringify(m.threadId ? { raw, threadId: m.threadId } : { raw }),
  }, 'your email', true)
  if (res.status === 401 || res.status === 403) {
    forgetAccessToken(agentEmail)
    throw new GmailAuthError(j.error?.message || 'Gmail refused to send. Reconnect Gmail and try again.')
  }
  if (!res.ok) throw new Error(j.error?.message || `Gmail rejected the message (${res.status})`)
  if (!j.id) throw new Error('Gmail did not confirm the send.')

  return { id: j.id as string, threadId: (j.threadId as string) ?? (j.id as string), messageId }
}

// ── reading replies (Phase 6) ────────────────────────────────────────────────
// Fetch ONE thread by the id we recorded when we sent. There is deliberately no
// list/search helper in this module: the only way to reach a message is to
// already know the thread we started, so an agent's wider mailbox is
// unreachable by construction rather than by policy.

export interface InboundAttachmentRef {
  attachmentId: string
  name: string
  mime: string
  size: number
}

export interface InboundMessage {
  gmailId: string
  threadId: string
  messageId: string
  inReplyTo: string | null
  from: string
  to: string
  subject: string
  bodyText: string
  at: string
  /** Gmail labels — used only to skip our own copy in SENT. */
  labelIds: string[]
  /** Declared attachments — metadata only; bytes are fetched separately. */
  attachments: InboundAttachmentRef[]
}

function headerOf(headers: { name: string; value: string }[], name: string): string {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

// Walk the MIME tree for the best body. text/plain is strongly preferred: it is
// what the quote-stripping heuristics are written against, and it avoids having
// to sanitise arbitrary sender HTML before rendering it.
function extractBody(payload: unknown): string {
  const plain = findPart(payload, 'text/plain')
  if (plain) return plain
  const html = findPart(payload, 'text/html')
  return html ? htmlToText(html) : ''
}

function findPart(node: unknown, mime: string): string | null {
  if (!node || typeof node !== 'object') return null
  const p = node as { mimeType?: string; body?: { data?: string }; parts?: unknown[] }
  if (p.mimeType === mime && p.body?.data) {
    return Buffer.from(p.body.data, 'base64url').toString('utf8')
  }
  for (const child of p.parts ?? []) {
    const found = findPart(child, mime)
    if (found) return found
  }
  return null
}

// Walk the MIME tree for real attachments. Anything with an attachmentId and a
// filename counts; inline parts without a filename (signature images, the HTML
// alternative) are skipped, which is what keeps a footer logo out of the
// Attachments panel on every single reply.
function findAttachments(node: unknown, out: InboundAttachmentRef[] = []): InboundAttachmentRef[] {
  if (!node || typeof node !== 'object') return out
  const p = node as {
    filename?: string; mimeType?: string
    body?: { attachmentId?: string; size?: number }
    parts?: unknown[]
  }
  if (p.filename && p.body?.attachmentId) {
    out.push({
      attachmentId: p.body.attachmentId,
      name: p.filename,
      mime: p.mimeType ?? 'application/octet-stream',
      size: p.body.size ?? 0,
    })
  }
  for (const child of p.parts ?? []) findAttachments(child, out)
  return out
}

/** The bytes of one attachment. Called only after the caller has vetted it. */
export async function fetchAttachment(
  agentEmail: string, cfg: GoogleConfig, gmailId: string, attachmentId: string,
): Promise<Uint8Array | null> {
  const token = await accessTokenFor(agentEmail, cfg)
  const { res, json: j } = await gapi(
    `${API}/messages/${encodeURIComponent(gmailId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
    'an attachment could not be downloaded',
  )
  if (!res.ok) return null
  if (typeof j.data !== 'string') return null
  return new Uint8Array(Buffer.from(j.data, 'base64url'))
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    // Table cells: "<td>Name</td><td>AHA W</td>" must read "Name AHA W", not
    // "NameAHA W" — HTML-only form mails are laid out as label/value tables.
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class GmailScopeError extends Error {
  constructor(message: string) { super(message); this.name = 'GmailScopeError' }
}

/**
 * Message ids matching a Gmail search, newest first. ONLY for the quote-intake
 * pull (lib/gmailintake.ts), on the one intake mailbox, with a query that
 * targets our own sites' form notifications. Added 2026-10-15 after the Apps
 * Script intake stopped overnight and leads sat in Gmail for six hours; the
 * thread-only rule in CLAUDE.md still holds for every agent mailbox.
 */
export async function searchIntakeMessageIds(agentEmail: string, cfg: GoogleConfig, q: string, max = 100): Promise<{ id: string; threadId: string }[]> {
  const token = await accessTokenFor(agentEmail, cfg)
  const { res, json: j } = await gapi(`${API}/messages?maxResults=${Math.min(max, 500)}&q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 'the intake mailbox could not be searched')
  if (res.status === 401) { forgetAccessToken(agentEmail); throw new GmailAuthError('Gmail refused the request. Reconnect Gmail.') }
  if (!res.ok) throw new Error(`Intake search failed (${res.status})`)
  return ((j as { messages?: { id: string; threadId: string }[] }).messages ?? [])
}

/** Every message in one thread we started. Throws rather than returning []. */
export async function fetchThread(agentEmail: string, cfg: GoogleConfig, threadId: string): Promise<InboundMessage[]> {
  const token = await accessTokenFor(agentEmail, cfg)
  const { res, json: j } = await gapi(`${API}/threads/${encodeURIComponent(threadId)}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  }, 'the reply could not be read')
  // Not a rate limit — gapi() has already ruled that out — so a 403 here really
  // is the missing read scope.
  if (res.status === 403) {
    // Sending works, reading does not — the connection predates the read scope.
    throw new GmailScopeError('Gmail replies need the read permission. Reconnect Gmail to enable reply capture.')
  }
  if (res.status === 401) {
    forgetAccessToken(agentEmail)
    throw new GmailAuthError('Gmail refused the request. Reconnect Gmail.')
  }
  // A thread the agent deleted permanently: not an error worth alarming about.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Could not read the Gmail thread (${res.status})`)

  type RawMessage = {
    id: string; threadId: string; internalDate?: string; labelIds?: string[]
    payload?: { headers?: { name: string; value: string }[] }
  }
  return ((j.messages as RawMessage[]) ?? []).map((m: {
    id: string; threadId: string; internalDate?: string; labelIds?: string[]
    payload?: { headers?: { name: string; value: string }[] }
  }) => {
    const headers = m.payload?.headers ?? []
    return {
      gmailId: m.id,
      threadId: m.threadId,
      messageId: headerOf(headers, 'Message-ID'),
      inReplyTo: headerOf(headers, 'In-Reply-To') || null,
      from: headerOf(headers, 'From'),
      to: headerOf(headers, 'To'),
      subject: headerOf(headers, 'Subject'),
      bodyText: extractBody(m.payload),
      at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
      labelIds: m.labelIds ?? [],
      attachments: findAttachments(m.payload),
    }
  })
}
