import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, leadRecipient, writeControlRow } from '@/lib/leadrecord'
import { canSeeContacts } from '@/lib/pii'
import { googleConfig, sendEmail, verifiedAliases, GmailAuthError, GmailRateError, configProblem } from '@/lib/gmail'
import { CRM_EMAIL_ROLE, MAX_SUBJECT, makeSnippet, newEmailId, type CrmEmailEntry } from '@/lib/crmemail'
import { plainToHtml } from '@/lib/richtext'
import { loadAgentSignatures, loadSiteContacts, renderSignature, renderSignatureHtml } from '@/lib/signature'
import { storedMemberNames } from '@/lib/membername'
import { readPayLink, recordPayLinkSent, redactedForTimeline } from '@/lib/paylink'
import { supabase as db } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Send the customer their payment link — without telling the sender what it is.
//
// This is the whole feature. An agent who may not see the customer's address
// presses one button; everything that would identify the customer, and the link
// that would reveal them on PayPal's own page, is resolved HERE, on the server,
// from our own rows. Nothing about the recipient or the URL is accepted from
// the request, and nothing about either goes back in the response.
//
// The timeline row deliberately does NOT store the URL (see redactedForTimeline
// in lib/paylink.ts): the timeline is served straight back to the agent, so
// storing what was sent would hand over, one screen later, the exact value this
// route exists to withhold.
const MAX_NOTE = 600

/** The alias that belongs to this lead's site — the same rule the composer uses. */
function aliasForSite(aliases: { email: string; displayName: string; isPrimary: boolean; isDefault: boolean }[], siteId: string, siteName: string) {
  const site = siteId.toLowerCase()
  const name = siteName.toLowerCase().replace(/[^a-z]/g, '')
  const match = aliases.find((a) => {
    const local = a.email.split('@')[0].toLowerCase()
    const domain = (a.email.split('@')[1] ?? '').toLowerCase().replace(/[^a-z]/g, '')
    return domain.includes(site) || (name && domain.includes(name)) || local.includes(site)
  })
  return match ?? aliases.find((a) => a.isDefault) ?? aliases.find((a) => a.isPrimary) ?? aliases[0] ?? null
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const problem = configProblem()
  if (problem) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })
  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured.', needsSetup: true }, { status: 503 })

  const { link } = await readPayLink(id)
  const url = link?.url
  if (!url) {
    return NextResponse.json({ error: 'There is no payment link saved on this lead yet.' }, { status: 400 })
  }

  // The recipient comes from our rows, never from the request — the browser was
  // handed a masked address and would post it straight back.
  const to = await leadRecipient(id)
  if (!to) {
    return NextResponse.json({ error: 'This lead has no email address on file, so it cannot be emailed.' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const note = String(body?.note ?? '').trim().slice(0, MAX_NOTE)

  const [aliases, agentSigs, siteContacts, allSites, chatNames] = await Promise.all([
    verifiedAliases(access.member.email, cfg).catch(() => []),
    loadAgentSignatures(), loadSiteContacts(),
    db.from('sites').select('site_id, name'), storedMemberNames(),
  ])
  const siteNameOf = new Map((allSites.data ?? []).map((r) => [r.site_id, String(r.name ?? '')]))
  const siteName = siteNameOf.get(access.siteId) ?? ''
  const alias = aliasForSite(aliases, access.siteId, siteName)
  if (!alias) {
    return NextResponse.json({ error: 'No verified send-as address is available on the connected Google account.', needsSetup: true }, { status: 503 })
  }

  const subject = `Payment link for your order${siteName ? ` — ${siteName}` : ''}`.slice(0, MAX_SUBJECT)
  const opening = note || 'Thank you for your order. You can complete the payment using the secure link below.'
  const text = `${opening}\n\n${url}\n\nIf you have any questions before paying, just reply to this email.`

  // The signature, built exactly the way the composer's send builds it, so a
  // payment mail does not arrive looking like it came from somewhere else.
  const brandNames = new Set(Array.from(siteNameOf.values()).map((n) => n.toLowerCase()))
  const chatName = chatNames.get(access.member.email.trim().toLowerCase()) ?? ''
  const base = (process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin).replace(/\/$/, '')
  const sigFallback = {
    name: (brandNames.has(chatName.toLowerCase()) ? '' : chatName)
      || (access.member.workspace === 'sports' ? siteName : ''),
    email: alias.email,
    company: siteName,
    logoSrc: `${base}/api/logo/${encodeURIComponent(access.siteId)}`,
  }
  const mySig = agentSigs.get(access.member.email.toLowerCase()) ?? null
  const mySite = siteContacts.get(access.siteId)
  const sigText = renderSignature(mySig, mySite, sigFallback)
  const sigHtml = renderSignatureHtml(mySig, mySite, sigFallback)

  const finalText = sigText ? `${text}\n\n${sigText}` : text
  const finalHtml = `${plainToHtml(text)}${sigHtml ?? ''}`

  let sent
  try {
    sent = await sendEmail(access.member.email, cfg, {
      from: alias.email, to, subject, body: finalText, html: finalHtml,
    })
  } catch (e) {
    if (e instanceof GmailRateError) return NextResponse.json({ error: e.message, retryable: true }, { status: 429 })
    if (e instanceof GmailAuthError) return NextResponse.json({ error: e.message, needsReconnect: true }, { status: 401 })
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Gmail rejected the message.' }, { status: 502 })
  }

  // Gmail first, the row second — a row existing is proof the mail left, the
  // same order /api/leads/[id]/email keeps and for the same reason.
  const entry: CrmEmailEntry = {
    id: newEmailId(),
    sentBy: access.member.email,
    from: alias.email,
    to,
    subject,
    body: redactedForTimeline(finalText, url),
    html: redactedForTimeline(finalHtml, url),
    snippet: makeSnippet(redactedForTimeline(text, url)),
    at: new Date().toISOString(),
    gmailId: sent.id,
    threadId: sent.threadId,
    messageId: sent.messageId,
    direction: 'outbound',
  }
  await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify(entry) })
  await recordPayLinkSent(id, access.siteId, access.member.email)

  // Masked on the way out too, or the send would undo itself in one line.
  const hide = !canSeeContacts(access.member)
  return NextResponse.json({
    ok: true,
    sentAt: entry.at,
    to: hide ? null : to,
    from: alias.email,
  })
}
