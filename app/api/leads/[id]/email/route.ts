import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { googleConfig, sendEmail, GmailAuthError, configProblem } from '@/lib/gmail'
import {
  CRM_EMAIL_ROLE, MAX_SUBJECT, MAX_BODY, makeSnippet, newEmailId,
  parseAddressList, type CrmEmailEntry,
} from '@/lib/crmemail'

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
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const problem = configProblem()
  if (problem) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const from = String(body.from ?? '').trim()
  const to = String(body.to ?? '').trim()
  const cc = String(body.cc ?? '').trim()
  const subject = String(body.subject ?? '').trim().slice(0, MAX_SUBJECT)
  const text = String(body.body ?? '')

  if (!from) return NextResponse.json({ error: 'Choose which address to send from.' }, { status: 400 })
  if (!subject) return NextResponse.json({ error: 'A subject is required.' }, { status: 400 })
  if (!text.trim()) return NextResponse.json({ error: 'The message is empty.' }, { status: 400 })
  if (text.length > MAX_BODY) return NextResponse.json({ error: 'That message is too long to send.' }, { status: 400 })

  const toList = parseAddressList(to)
  if (!toList.ok || toList.list.length === 0) {
    return NextResponse.json({ error: toList.ok ? 'A recipient is required.' : `"${toList.bad}" is not a valid email address.` }, { status: 400 })
  }
  if (cc) {
    const ccList = parseAddressList(cc)
    if (!ccList.ok) return NextResponse.json({ error: `"${ccList.bad}" is not a valid CC address.` }, { status: 400 })
  }

  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured.', needsSetup: true }, { status: 503 })

  // ── 1. Gmail first ─────────────────────────────────────────────────────────
  let sent
  try {
    sent = await sendEmail(access.member.email, cfg, {
      from, to: toList.list.join(', '), cc: cc || undefined, subject, body: text,
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
    cc: cc || undefined,
    subject,
    body: text,
    snippet: makeSnippet(text),
    at: new Date().toISOString(),
    gmailId: sent.id,
    threadId: sent.threadId,
    messageId: sent.messageId,
    direction: 'outbound',
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry),
  })
  if (error) {
    console.error('[email] sent but the timeline row failed:', error)
    return NextResponse.json({
      ok: true, sent: true, recorded: false, email: entry,
      warning: 'The email was sent, but it could not be recorded on the timeline.',
    })
  }

  return NextResponse.json({ ok: true, sent: true, recorded: true, email: entry })
}
