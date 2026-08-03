// Inbound email replies — Phase 6.
//
//   crm_email_in — one row per inbound Gmail message captured against a lead.
//
// Registered in CRM_ROLES (lib/crm.ts), which is the single entry that keeps it
// out of the chat transcript, the conversation previews, the message counts and
// the visitor widget.
//
// ── Only threads we started ──────────────────────────────────────────────────
// The sweep never lists or searches the mailbox. It reads the `threadId` off
// each crm_email row WE wrote when sending, and fetches exactly those threads by
// id. An agent's wider inbox is never touched, which is the whole reason the
// read scope is acceptable — see GMAIL_READ_SCOPE in lib/gmail.ts.
//
// ── Dedupe ───────────────────────────────────────────────────────────────────
// Keyed on Gmail's own immutable message id. The sweep is therefore idempotent:
// running late, twice, or after a missed window can never duplicate a reply.

import { parseEmailAttachments, type EmailAttachment } from './emailattach'

export const CRM_EMAIL_IN_ROLE = 'crm_email_in'
/** Marks an inbound message as read by an agent. Also a crm_* control row. */
export const CRM_EMAIL_READ_ROLE = 'crm_email_read'

export const MAX_INBOUND_BODY = 40000
/** Where the sweep records its last run. Lives on the reserved zeeops-crm site,
 *  and is registered in CRM_ROLES anyway as a second line of defence. */
export const CRM_EMAIL_SWEEP_ROLE = 'crm_email_sweep'


export interface CrmEmailInEntry {
  /** Gmail's message id — the dedupe key. */
  gmailId: string
  threadId: string
  /** RFC Message-ID of this inbound message. */
  messageId: string
  /** The Message-ID it replies to, when present — ties it to our exact send. */
  inReplyTo: string | null
  from: string
  fromName: string | null
  to: string
  subject: string
  /** The new content, with quoted history and signature removed. */
  body: string
  /** Everything trimmed off: the quoted chain and signature, for "show more". */
  quoted: string | null
  /** True when the reply carried no new text — usually an attachment on its own. */
  textless?: boolean
  snippet: string
  /** When Gmail says the message was sent (ms epoch -> ISO). */
  at: string
  direction: 'inbound'
  /** Files the customer sent, copied into the private bucket. */
  attachments?: EmailAttachment[]
  /** Anything refused, so a dropped file is visible rather than silent. */
  skippedAttachments?: { name: string; why: string }[]
}

export function parseCrmEmailIn(message: string | null | undefined): CrmEmailInEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.gmailId !== 'string' || !o.gmailId) return null
    if (o.direction !== 'inbound') return null
    const str = (v: unknown) => (typeof v === 'string' ? v : '')

    // Repair a row written before the capture-time fix: its `body` holds nothing
    // but quoted history. Move it where it belongs so the "show history" toggle
    // still reveals it, rather than leaving it stranded on a field we no longer
    // render.
    let body = str(o.body)
    let quoted = typeof o.quoted === 'string' && o.quoted ? o.quoted : null
    const textless = o.textless === true || isAllQuote(body)
    if (textless && body) { quoted = quoted ? `${body}\n${quoted}` : body; body = '' }

    return {
      gmailId: o.gmailId,
      threadId: str(o.threadId),
      messageId: str(o.messageId),
      inReplyTo: typeof o.inReplyTo === 'string' && o.inReplyTo ? o.inReplyTo : null,
      from: str(o.from),
      fromName: typeof o.fromName === 'string' && o.fromName ? o.fromName : null,
      to: str(o.to),
      subject: str(o.subject),
      body,
      quoted,
      textless,
      snippet: str(o.snippet),
      at: str(o.at),
      direction: 'inbound',
      attachments: parseEmailAttachments(o.attachments),
      skippedAttachments: Array.isArray(o.skippedAttachments)
        ? o.skippedAttachments
            .filter((x: unknown) => x && typeof (x as { name?: unknown }).name === 'string')
            .map((x: { name: string; why?: string }) => ({ name: x.name, why: String(x.why ?? 'not allowed') }))
        : undefined,
    }
  } catch {
    return null
  }
}

/** Which inbound messages an agent has marked read. */
export interface CrmEmailReadEntry { gmailId: string; by: string; at: string }

export function parseCrmEmailRead(message: string | null | undefined): CrmEmailReadEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.gmailId !== 'string' || !o.gmailId) return null
    return { gmailId: o.gmailId, by: String(o.by ?? ''), at: String(o.at ?? '') }
  } catch {
    return null
  }
}

// ── Quoted-history stripping ─────────────────────────────────────────────────
// A reply arrives with the entire prior conversation underneath it. Showing
// that in the timeline makes the record unreadable by the second exchange, so
// the new content is split from the history and the rest is kept behind a
// "show quoted text" toggle — trimmed, never discarded.
//
// These are heuristics over the plain-text part, matched against what Gmail,
// Outlook and Apple Mail actually emit. Anything unrecognised stays in the
// visible body: showing slightly too much is a cosmetic problem, hiding real
// content the customer wrote is a correctness one.

const ATTRIBUTION_RE = [
  // Gmail / Apple Mail: "On Mon, 2 Aug 2026 at 21:04, Someone <a@b.com> wrote:"
  /^\s*On .{6,120}\bwrote:\s*$/i,
  // Sometimes wrapped across two lines, ending in "wrote:"
  /^\s*On .{6,200}$/i,
  // Outlook
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*From:\s.+$/i,
  // Localised / misc
  /^\s*Le .{6,120}\ba écrit\s*:\s*$/i,
  /^\s*Am .{6,120}\bschrieb\s.*:\s*$/i,
]

const SIGNATURE_RE = /^\s*--\s*$/

// Is this body nothing but quoted history? Asked on READ as well as on capture,
// because rows written before the capture-time fix already have the quote sitting
// in `body` — and a stored row is append-only, so the repair has to happen here
// rather than by rewriting history. An attachment-only reply rendered as prose
// reads as though the customer sent our own words back at us, which is worse
// than saying plainly that they wrote nothing.
//
// Deliberately strict: ONE line of real prose anywhere and this is false, so a
// genuine message can never be suppressed by it.
export function isAllQuote(body: string): boolean {
  const lines = (body ?? '').replace(/\r\n/g, '\n').split('\n')
  let sawQuote = false
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('>')) { sawQuote = true; continue }
    if (/^(On|Le|Am)\b.*(wrote|écrit|schrieb)\s*:?\s*$/i.test(t)) { sawQuote = true; continue }
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(t)) { sawQuote = true; continue }
    if (/^(From|Sent|To|Cc|Subject|Date|Reply-To):/i.test(t)) { sawQuote = true; continue }
    if (/^[-_=]{3,}$/.test(t)) continue
    return false   // real prose — they said something
  }
  return sawQuote
}

export function splitQuoted(raw: string): { visible: string; quoted: string | null; textless?: boolean } {
  const text = (raw ?? '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  let cut = -1
  // How sure we are about the boundary. A `--` signature and an
  // "-----Original Message-----" banner are explicit delimiters the sending
  // client wrote on purpose; everything below them is quoted body or signature
  // and is SUPPOSED to read as ordinary unprefixed prose. The "On … wrote:"
  // attribution and a bare "From:/Sent:" block are heuristics we inferred, and
  // only those need second-guessing below.
  let certain = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // A run of quoted lines starting here.
    if (/^\s*>/.test(line)) { cut = i; break }

    if (SIGNATURE_RE.test(line)) { cut = i; certain = true; break }
    if (/^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(line)) { cut = i; certain = true; break }

    // "On … wrote:" — accept the one-line form, or a first line that runs on
    // and ends with "wrote:" within the next couple of lines.
    if (ATTRIBUTION_RE[0].test(line) || ATTRIBUTION_RE[2].test(line)
      || ATTRIBUTION_RE[3].test(line) || ATTRIBUTION_RE[5].test(line) || ATTRIBUTION_RE[6].test(line)) {
      cut = i; break
    }
    if (/^\s*On\b/i.test(line)) {
      const joined = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ')
      if (/\bwrote:\s*$/i.test(joined.trimEnd())) { cut = i; break }
    }
    // A bare "From: …" block only counts when followed by another header,
    // otherwise it matches a customer legitimately writing "From: our old order".
    if (ATTRIBUTION_RE[4].test(line) && /^\s*(Sent|To|Subject|Date):/i.test(lines[i + 1] ?? '')) {
      cut = i; break
    }
  }

  if (cut < 0) return { visible: tidy(text), quoted: null }
  const visible = tidy(lines.slice(0, cut).join('\n'))
  const tail = lines.slice(cut)
  const quoted = tidy(tail.join('\n'))

  // FAIL-SAFE 1 — bottom-posting. Some people reply UNDER the quote, and some
  // answer inline between quoted lines. Cutting at an inferred attribution then
  // buries their actual message inside `quoted`, which is the one outcome worth
  // avoiding: hiding text a customer wrote. So where the boundary was a guess
  // rather than an explicit delimiter, and the tail still holds real prose —
  // lines that are neither quote markers nor mail headers — distrust the
  // boundary and show the whole message. Being uncertain must cost the agent a
  // few lines of duplicated history, never a lost sentence.
  const tailProse = tail.filter((l) => {
    const t = l.trim()
    if (!t) return false
    if (t.startsWith('>')) return false
    if (/^(On|Le|Am)\b.*(wrote|écrit|schrieb)\s*:?\s*$/i.test(t)) return false
    if (/^(From|Sent|To|Cc|Subject|Date|Reply-To):/i.test(t)) return false
    if (/^-{2,}\s*(Original Message|Forwarded message)/i.test(t)) return false
    if (/^[-_=]{3,}$/.test(t)) return false
    return t.length > 2
  })
  if (!certain && tailProse.length > 0) return { visible: tidy(text), quoted: null }

  // FAIL-SAFE 2 — nothing new at all. An attachment-only reply is entirely
  // quote. Promoting that quote to the message body (what used to happen) reads
  // as though the customer wrote our own words back at us. Say plainly that
  // there was no text and keep the history behind the toggle.
  if (!visible) return { visible: '', quoted: quoted || null, textless: true }

  return { visible, quoted: quoted || null }
}

function tidy(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

export function inboundSnippet(body: string, limit = 180): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** Display name and address out of an RFC From header. */
export function parseFromHeader(v: string): { name: string | null; email: string } {
  const m = v.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (m) {
    const name = m[1].replace(/^["']|["']$/g, '').trim()
    return { name: name || null, email: m[2].trim().toLowerCase() }
  }
  return { name: null, email: v.trim().toLowerCase() }
}
