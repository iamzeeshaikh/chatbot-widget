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

export async function saveConnection(email: string, refreshToken: string, scope: string): Promise<void> {
  await writeToken({ email, enc: seal(refreshToken), connectedAt: new Date().toISOString(), scope })
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

/** Fresh access token for an agent, or a clear error saying to reconnect. */
export async function accessTokenFor(email: string, cfg: GoogleConfig): Promise<string> {
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
    // invalid_grant means the user revoked access or changed their password.
    // Record it so the UI can say "reconnect" instead of retrying forever.
    const reason = j.error === 'invalid_grant'
      ? 'Google has revoked this Gmail connection (access withdrawn or password changed). Reconnect to send email.'
      : `Google refused to refresh the Gmail token: ${j.error_description || j.error || res.status}`
    await markRevoked(email, reason)
    throw new GmailAuthError(reason)
  }
  return j.access_token as string
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
  const token = await accessTokenFor(email, cfg)
  const res = await fetch(`${API}/settings/sendAs`, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 401 || res.status === 403) {
    throw new GmailAuthError('Gmail refused the request. Reconnect Gmail and grant the alias permission.')
  }
  if (!res.ok) throw new Error(`Could not read your Gmail aliases (${res.status})`)
  const j = await res.json()
  return (j.sendAs ?? [])
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
}

// ── sending ──────────────────────────────────────────────────────────────────
export interface OutgoingEmail {
  from: string
  fromName?: string
  to: string
  cc?: string
  subject: string
  body: string
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
    'MIME-Version: 1.0',
  ]

  const b64 = (buf: Buffer) => buf.toString('base64').replace(/(.{76})/g, '$1\r\n')
  const bodyPart = [
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(Buffer.from(m.body, 'utf8')),
  ]

  // No attachments: keep the simple single-part message exactly as before, so
  // the common case gains no MIME machinery it does not need.
  if (!m.attachments?.length) {
    return [...lines, ...bodyPart].join('\r\n')
  }

  // multipart/mixed: the text first, then one part per file. The boundary is
  // random so it cannot collide with anything inside the content.
  const boundary = `zee_${Date.now().toString(36)}_${randomBytes(12).toString('hex')}`
  const out = [
    ...lines,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
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

  const res = await fetch(`${API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    // threadId here is what makes Gmail file it in the existing conversation
    // rather than starting a new one.
    body: JSON.stringify(m.threadId ? { raw, threadId: m.threadId } : { raw }),
  })
  const j = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) {
    throw new GmailAuthError(j.error?.message || 'Gmail refused to send. Reconnect Gmail and try again.')
  }
  if (!res.ok) throw new Error(j.error?.message || `Gmail rejected the message (${res.status})`)
  if (!j.id) throw new Error('Gmail did not confirm the send.')

  return { id: j.id, threadId: j.threadId ?? j.id, messageId }
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
  const res = await fetch(
    `${API}/messages/${encodeURIComponent(gmailId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) return null
  const j = await res.json()
  if (typeof j.data !== 'string') return null
  return new Uint8Array(Buffer.from(j.data, 'base64url'))
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export class GmailScopeError extends Error {
  constructor(message: string) { super(message); this.name = 'GmailScopeError' }
}

/** Every message in one thread we started. Throws rather than returning []. */
export async function fetchThread(agentEmail: string, cfg: GoogleConfig, threadId: string): Promise<InboundMessage[]> {
  const token = await accessTokenFor(agentEmail, cfg)
  const res = await fetch(`${API}/threads/${encodeURIComponent(threadId)}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 403) {
    // Sending works, reading does not — the connection predates the read scope.
    throw new GmailScopeError('Gmail replies need the read permission. Reconnect Gmail to enable reply capture.')
  }
  if (res.status === 401) throw new GmailAuthError('Gmail refused the request. Reconnect Gmail.')
  // A thread the agent deleted permanently: not an error worth alarming about.
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`Could not read the Gmail thread (${res.status})`)

  const j = await res.json()
  return (j.messages ?? []).map((m: {
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
