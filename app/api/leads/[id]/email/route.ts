import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { leadRecipient, markThreadRepliesRead } from '@/lib/leadrecord'
import { canSeeContacts, scrubText, HIDDEN_EMAIL } from '@/lib/pii'
import { googleConfig, sendEmail, GmailAuthError, configProblem } from '@/lib/gmail'
import { threadContextFor } from '@/lib/emailsweep'
import { supabase } from '@/lib/supabase'
import {
  EMAIL_ATTACHMENT_BUCKET, MAX_EMAIL_ATTACHMENTS, MAX_EMAIL_ATTACHMENTS_TOTAL,
  parseEmailAttachments, humanSize,
} from '@/lib/emailattach'
import {
  CRM_EMAIL_ROLE, MAX_SUBJECT, MAX_BODY, makeSnippet, newEmailId,
  parseAddressList, type CrmEmailEntry,
} from '@/lib/crmemail'
import { sanitizeHtml, htmlToPlain, plainToHtml } from '@/lib/richtext'
import { loadAgentSignatures, loadSiteContacts, renderSignature, renderSignatureHtml } from '@/lib/signature'
import { storedMemberNames } from '@/lib/membername'
import { supabase as db } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Send an email to a lead, as the agent, through their own Gmail.
//
// ── Atomic from the user's point of view ─────────────────────────────────────
// The order is deliberate and must not be swapped: Gmail is called FIRST, and
// the crm_email control row is written only after Gmail returns a message id.
// So a row existing is proof the mail left, and a failure leaves no timeline
// entry claiming otherwise. If the row write fails afterwards the mail HAS gone
// — that is reported honestly rather than pretending the send failed, because
// telling someone their email did not send when it did is the worse lie.
//
// ── Access ───────────────────────────────────────────────────────────────────
// guardLeadAccess: an agent cannot email a lead on a site they are not assigned
// to, whether they clicked a link or typed the id. The From address is checked
// against Gmail's own verified send-as list inside sendEmail — the client's
// dropdown is never trusted.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const problem = configProblem()
  if (problem) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const from = String(body.from ?? '').trim()
  const to = String(body.to ?? '').trim()
  const cc = String(body.cc ?? '').trim()
  const subject = String(body.subject ?? '').trim().slice(0, MAX_SUBJECT)
  // The composer sends the formatted body; the plain text is derived from it
  // here rather than trusted from the client, so the two halves of the message
  // can never say different things.
  const rawHtml = String(body.html ?? '')
  const html = rawHtml.trim() ? sanitizeHtml(rawHtml) : ''
  const text = html ? htmlToPlain(html) : String(body.body ?? '')
  // The client only ever names WHICH message it is replying to. The thread and
  // the header chain are rebuilt from our own rows below — a browser must not
  // be able to post an arbitrary threadId and drop a message into a
  // conversation on someone else's lead.
  const replyToGmailId = String(body.replyToGmailId ?? '').trim()
  // Only the storage PATHS come from the client; the bytes are read here, from
  // a bucket only this server can reach.
  const attachments = parseEmailAttachments(body.attachments).slice(0, MAX_EMAIL_ATTACHMENTS)

  if (!from) return NextResponse.json({ error: 'Choose which address to send from.' }, { status: 400 })
  if (!subject) return NextResponse.json({ error: 'A subject is required.' }, { status: 400 })
  if (!text.trim()) return NextResponse.json({ error: 'The message is empty.' }, { status: 400 })
  if (text.length > MAX_BODY) return NextResponse.json({ error: 'That message is too long to send.' }, { status: 400 })

  // ── WHERE THIS EMAIL IS ALLOWED TO GO ─────────────────────────────────────
  // An agent's email goes to the lead. Not to an address they typed.
  //
  // The composer let anyone put anything in To, which meant the company's own
  // Gmail could be used to send a customer list — with attachments — to a
  // personal address, and it would leave looking like ordinary company mail.
  // That is the one exfiltration route the product itself provides, so it is
  // the one worth closing. Everything else an agent could do (copy the screen,
  // photograph it) is outside what this code can reach, and pretending
  // otherwise would be theatre.
  //
  // The recipient is therefore READ FROM OUR OWN ROWS for any non-admin, never
  // taken from the request. Admins are unrestricted — they are the ones who
  // forward a lead to a supplier or a colleague.
  //
  // CC follows the same logic but keeps one real case alive: copying somebody
  // ELSE AT THE SAME COMPANY (buyer + purchasing). So a non-admin's CC is kept
  // only where its domain matches the customer's own. A member who may not even
  // see the address gets no CC at all — a CC to themselves would deliver a
  // message whose To: header is the address they are not allowed to read.
  const canSee = canSeeContacts(access.member)
  const isAdmin = access.member.role === 'admin'
  let toValue = to
  let ccValue = cc
  if (!isAdmin) {
    const real = await leadRecipient(id)
    if (!real) {
      return NextResponse.json({ error: 'This lead has no email address on file, so it cannot be emailed.' }, { status: 400 })
    }
    toValue = real
    if (!canSee) {
      ccValue = ''
    } else {
      const domain = real.split('@')[1]?.toLowerCase() ?? ''
      const kept = parseAddressList(cc)
      ccValue = kept.ok
        ? kept.list.filter((a) => a.split('@')[1]?.toLowerCase() === domain).join(', ')
        : ''
    }
  }

  const toList = parseAddressList(toValue)
  if (!toList.ok || toList.list.length === 0) {
    return NextResponse.json({ error: toList.ok ? 'A recipient is required.' : `"${toList.bad}" is not a valid email address.` }, { status: 400 })
  }
  if (ccValue) {
    const ccList = parseAddressList(ccValue)
    if (!ccList.ok) return NextResponse.json({ error: `"${ccList.bad}" is not a valid CC address.` }, { status: 400 })
  }

  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured.', needsSetup: true }, { status: 503 })

  // ── 0a. pull the attachments back out of storage ──────────────────────────
  // Re-checked server-side rather than trusting the sizes the browser reported:
  // the composer's limit is a courtesy to the agent, this is the one that stops
  // Gmail rejecting a message they have already written.
  const files: { name: string; mime: string; bytes: Uint8Array }[] = []
  let totalBytes = 0
  for (const a of attachments) {
    const { data: blob, error: dlErr } = await supabase.storage.from(EMAIL_ATTACHMENT_BUCKET).download(a.path)
    if (dlErr || !blob) {
      return NextResponse.json({ error: `"${a.name}" could not be read back — remove it and attach it again.` }, { status: 400 })
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_EMAIL_ATTACHMENTS_TOTAL) {
      return NextResponse.json({
        error: `Those attachments come to more than ${humanSize(MAX_EMAIL_ATTACHMENTS_TOTAL)}, which Gmail will refuse. Remove one or send a download link.`,
      }, { status: 413 })
    }
    files.push({ name: a.name, mime: a.mime, bytes })
  }

  // ── 0. resolve the thread from OUR rows, not from the request ─────────────
  const thread = replyToGmailId ? await threadContextFor(id, replyToGmailId) : null

  // ── the signature ─────────────────────────────────────────────────────────
  // Appended HERE, not in the composer. It is built from stored fields rather
  // than from anything the agent typed, which is what lets it use a table and
  // inline styles: the sanitiser above would strip both, and it has to, because
  // the body IS agent-authored. Doing it at send time also means a signature
  // cannot arrive half-deleted because somebody edited around it.
  const [agentSigs, siteContacts, allSites, chatNames] = await Promise.all([
    loadAgentSignatures(), loadSiteContacts(),
    db.from('sites').select('site_id, name'), storedMemberNames(),
  ])
  const siteNameOf = new Map((allSites.data ?? []).map((r) => [r.site_id, String(r.name ?? '')]))
  // Same rule as /api/signature, and it must stay the same rule: a chat display
  // name is the person's name for most members and a BRAND for one, so it is
  // used unless it matches a site name. If these two ever disagree, the
  // signature shown in the composer is not the one the customer receives.
  const brandNames = new Set(Array.from(siteNameOf.values()).map((n) => n.toLowerCase()))
  const chatName = chatNames.get(access.member.email.trim().toLowerCase()) ?? ''
  // Absolute, and from the configured base rather than the request host: the
  // recipient's mail client fetches this from outside, where a relative URL or
  // a preview hostname resolves to nothing.
  const base = (process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin).replace(/\/$/, '')
  const sigFallback = {
    name: brandNames.has(chatName.toLowerCase()) ? '' : chatName,
    email: from,
    company: siteNameOf.get(access.siteId) ?? '',
    logoSrc: `${base}/api/logo/${encodeURIComponent(access.siteId)}`,
  }
  const mySig = agentSigs.get(access.member.email.toLowerCase()) ?? null
  const mySite = siteContacts.get(access.siteId)
  const sigText = renderSignature(mySig, mySite, sigFallback)
  const sigHtml = renderSignatureHtml(mySig, mySite, sigFallback)

  // The plain part gets the plain signature and the HTML part the designed one
  // — the same information, each in the form its half of the message can show.
  const finalText = sigText ? `${text}\n\n${sigText}` : text
  const bodyHtml = html || plainToHtml(text)
  const finalHtml = sigHtml ? `${bodyHtml}${sigHtml}` : (html || '')

  // ── 1. Gmail first ─────────────────────────────────────────────────────────
  let sent
  try {
    sent = await sendEmail(access.member.email, cfg, {
      from, to: toList.list.join(', '), cc: ccValue || undefined, subject, body: finalText,
      html: finalHtml || undefined,
      threadId: thread?.threadId,
      inReplyTo: thread?.inReplyTo,
      references: thread?.references,
      attachments: files,
    })
  } catch (e) {
    if (e instanceof GmailAuthError) {
      // Expired / revoked: a specific, actionable message and a flag the UI uses
      // to offer the reconnect button, never a silent failure.
      return NextResponse.json({ error: e.message, needsReconnect: true }, { status: 401 })
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Gmail rejected the message.' }, { status: 502 })
  }

  // ── 2. only now, the timeline row ──────────────────────────────────────────
  const entry: CrmEmailEntry = {
    id: newEmailId(),
    sentBy: access.member.email,
    from,
    to: toList.list.join(', '),
    cc: ccValue || undefined,   // what was actually sent, not what was asked for
    subject,
    body: finalText,
    // Kept so the timeline can show the message the way it was sent. The body
    // half is sanitised above and the signature half is ours, so what is stored
    // is safe to render back into another agent's browser.
    html: finalHtml || undefined,
    // The snippet is the AGENT's words, not the signature — a preview reading
    // "Steve Hayes Sales Executive" tells nobody what the email said.
    snippet: makeSnippet(text),
    at: new Date().toISOString(),
    gmailId: sent.id,
    threadId: sent.threadId,
    messageId: sent.messageId,
    direction: 'outbound',
    attachments,
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry),
  })

  // Answering IS reading: the badge on this lead says "awaiting your reply", so
  // a successful send clears the unread replies on the thread it answered. It
  // used to take a separate click on the message itself, which meant a lead you
  // had already replied to kept asking for attention.
  await markThreadRepliesRead(id, access.siteId, sent.threadId ?? thread?.threadId, access.member.email)

  // The row we STORE keeps the real recipient — that is the record of what was
  // sent, and an admin must be able to read it. What goes back to the browser
  // is masked for a member who may not see contacts: the send resolved an
  // address they are not allowed to know, and handing it straight back in the
  // response would undo every other masking in one line. (Found by sending as
  // the agent and reading the reply — the timeline was already safe.)
  const shown = canSee ? entry : {
    ...entry,
    to: HIDDEN_EMAIL,
    cc: entry.cc ? HIDDEN_EMAIL : entry.cc,
    subject: scrubText(entry.subject) ?? '',
    body: scrubText(entry.body) ?? '',
    snippet: scrubText(entry.snippet) ?? '',
  }
  if (error) {
    console.error('[email] sent but the timeline row failed:', error)
    return NextResponse.json({
      ok: true, sent: true, recorded: false, email: shown,
      warning: 'The email was sent, but it could not be recorded on the timeline.',
    })
  }

  return NextResponse.json({ ok: true, sent: true, recorded: true, email: shown })
}
