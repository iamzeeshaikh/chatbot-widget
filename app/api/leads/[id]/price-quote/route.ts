import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, leadRecipient, loadLeadRecord, writeControlRow } from '@/lib/leadrecord'
import { googleConfig, sendEmail, GmailAuthError, GmailRateError, verifiedAliases } from '@/lib/gmail'
import { threadContextFor } from '@/lib/emailsweep'
import { buildSendSignature } from '@/lib/sendsignature'
import { openPixelHtml } from '@/lib/emailtrack'
import { makeSnippet, newEmailId, type CrmEmailEntry } from '@/lib/crmemail'
import { CRM_EMAIL_ROLE, CRM_NOTE_ROLE, CRM_VALUE_ROLE } from '@/lib/crm'
import { applyStageChange } from '@/lib/stagechange'
import { customerCc } from '@/lib/customercc'
import { cleanRows, quoteHtml, quoteProblems, quoteText, money, type PriceQuote } from '@/lib/pricequote'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET: what the quote page needs — who it goes to, the From choices, the
// customer's CCs and the thread it answers.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const record = await loadLeadRecord(access.member, id)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const cfg = googleConfig(req.nextUrl.origin)
  let aliases: { email: string; displayName: string }[] = []
  try { if (cfg) aliases = (await verifiedAliases(access.member.email, cfg)).map((a) => ({ email: a.email, displayName: a.displayName })) } catch { aliases = [] }
  const to = await leadRecipient(id)
  const lastIn = [...record.timeline].reverse().find((e) => e.kind === 'email_in')
  const cc = to ? customerCc({ customer: to, leadText: record.quoteMessage }) : []
  return NextResponse.json({
    ok: true, name: record.contact.name, siteId: record.siteId, siteName: record.siteName, product: record.quoteMessage ? '' : '',
    toKnown: !!to, cc, aliases, replyTo: lastIn ? { title: lastIn.title } : null,
  })
}

// POST: send it from the agent's own mailbox, then mark the stage Quote Sent
// and record the value — the moment the bot's quote follow-ups start from.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const body = await req.json().catch(() => ({}))
  const q = body.quote as PriceQuote
  if (!q || typeof q !== 'object') return NextResponse.json({ error: 'Nothing to send' }, { status: 400 })
  const problems = quoteProblems(q)
  if (problems.length) return NextResponse.json({ error: `Add ${problems.join(' and ')}.` }, { status: 400 })
  const from = String(body.from ?? '').trim()
  if (!from) return NextResponse.json({ error: 'Choose which address to send from.' }, { status: 400 })
  const to = await leadRecipient(id)
  if (!to) return NextResponse.json({ error: 'This lead has no email address on file.' }, { status: 400 })
  const record = await loadLeadRecord(access.member, id)
  if (!record) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Cc: only people the customer copied, or others at the customer's company.
  const allowed = new Set(customerCc({ customer: to, leadText: record.quoteMessage }))
  const dom = to.split('@')[1]?.toLowerCase()
  const cc = (String(body.cc ?? '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])
    .map((a) => a.toLowerCase()).filter((a) => allowed.has(a) || a.split('@')[1] === dom).slice(0, 6).join(', ')

  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured.' }, { status: 503 })
  const subject = String(body.subject ?? '').trim().slice(0, 200) || `Price quote — ${q.product} - ${record.siteName}`
  // Threaded under the customer's latest email when there is one.
  const lastIn = [...record.timeline].reverse().find((e) => e.kind === 'email_in') as { id?: string } | undefined
  const gmailId = lastIn?.id?.replace(/^email-in-/, '') ?? ''
  const thread = gmailId ? await threadContextFor(id, gmailId).catch(() => null) : null

  const base = (process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin).replace(/\/$/, '')
  const sig = await buildSendSignature({ memberEmail: access.member.email, workspace: access.member.workspace, siteId: access.siteId, from, base })
  const text = quoteText(q)
  const emailId = newEmailId()
  const finalText = sig.text ? `${text}\n\n${sig.text}` : text
  const finalHtml = `${quoteHtml(q)}${sig.html}${openPixelHtml(base, id, emailId)}`
  let sent
  try {
    const msg = { from, to, cc: cc || undefined, subject, body: finalText, html: finalHtml, inReplyTo: thread?.inReplyTo, references: thread?.references }
    try {
      sent = await sendEmail(access.member.email, cfg, { ...msg, threadId: thread?.threadId })
    } catch (e) {
      // The thread lives in another agent's mailbox (the customer wrote to
      // Steve, Samir sends the quote): Gmail answers 404. The headers still
      // thread it in the customer's mail client, so send without the id.
      if (!thread?.threadId || !/not found/i.test(e instanceof Error ? e.message : '')) throw e
      sent = await sendEmail(access.member.email, cfg, msg)
    }
  } catch (e) {
    if (e instanceof GmailRateError) return NextResponse.json({ error: e.message }, { status: 429 })
    if (e instanceof GmailAuthError) return NextResponse.json({ error: e.message, needsReconnect: true }, { status: 401 })
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Gmail rejected the message' }, { status: 502 })
  }
  const at = new Date().toISOString()
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: access.member.email, from, to, cc: cc || undefined, subject,
    body: finalText, html: finalHtml, snippet: makeSnippet(text), at,
    gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId, direction: 'outbound',
  }
  await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
  const rows = cleanRows(q)
  if (record.stage !== 'quote_sent') await applyStageChange({ leadId: id, siteId: access.siteId, stage: 'quote_sent', previous: record.stage, actorEmail: access.member.email })
  await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_VALUE_ROLE,
    message: JSON.stringify({ estimated: Math.round(rows[0].total), won: record.value?.won ?? null, currency: q.currency || 'USD', updated_by: access.member.email, at }) })
  await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify({
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, author: access.member.email, at,
    body: `Price quote sent — ${q.product}: ${rows.map((r) => `${r.qty.toLocaleString('en-US')} × ${money(r.unit, q.currency)} = ${money(r.total, q.currency)}`).join(' · ')}`,
  }) })
  return NextResponse.json({ ok: true, emailId })
}
