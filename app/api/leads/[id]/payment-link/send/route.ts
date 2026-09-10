import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, leadPhone, leadRecipient, writeControlRow } from '@/lib/leadrecord'
import { hasFeature } from '@/lib/workspaces'
import { twilioConfig, twilioProblem, sendWhatsApp } from '@/lib/twilio'
import { CRM_WA_OUT_ROLE } from '@/lib/crm'
import { canSeeContacts } from '@/lib/pii'
import { connectedAddresses, connectionFor, googleConfig, sendEmail, verifiedAliases, GmailAuthError, GmailRateError, configProblem, type SendAsAlias } from '@/lib/gmail'
import { CRM_EMAIL_ROLE, MAX_SUBJECT, makeSnippet, newEmailId, type CrmEmailEntry } from '@/lib/crmemail'
import { plainToHtml } from '@/lib/richtext'
import { loadAgentSignatures, loadSiteContacts, renderSignature, renderSignatureHtml } from '@/lib/signature'
import { storedMemberNames } from '@/lib/membername'
import { payChannel, readPayLink, recordPayLinkSent, redactedForTimeline } from '@/lib/paylink'
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
  // Gated on 'records', not 'email': a lead that only has a WhatsApp number is
  // exactly the case this route now covers, and gating the whole thing on the
  // email feature would refuse it before the channel was even chosen.
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { link } = await readPayLink(id)
  const url = link?.url
  if (!url) {
    return NextResponse.json({ error: 'There is no payment link saved on this lead yet.' }, { status: 400 })
  }

  // Both come from our rows, never from the request — the browser was handed
  // "•••••• hidden" for each of them and would post that straight back.
  const [to, phone] = await Promise.all([leadRecipient(id), leadPhone(id)])
  const ws = access.member.workspace
  const channel = payChannel({
    email: Boolean(to), phone: Boolean(phone),
    canEmail: hasFeature(ws, 'email'), canWhatsApp: hasFeature(ws, 'telephony'),
  })
  if (!channel) {
    return NextResponse.json({
      error: 'This lead has no email address and no phone number on file, so the link cannot be sent.',
    }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const note = String(body?.note ?? '').trim().slice(0, MAX_NOTE)
  const opening = note || 'Thank you for your order. You can complete the payment using the secure link below.'

  // ── WhatsApp: the customer who never gave us an address ───────────────────
  // A widget or WhatsApp lead often has a number and nothing else. Refusing to
  // send is a dead end when we are already in a conversation with them.
  if (channel === 'whatsapp' && phone) {
    const waProblem = twilioProblem(ws)
    const waCfg = twilioConfig(ws)
    if (waProblem || !waCfg) return NextResponse.json({ error: waProblem, needsSetup: true }, { status: 503 })

    const text = `${opening}\n\n${url}\n\nIf you have any questions before paying, just reply here.`
    let waSent
    try {
      waSent = await sendWhatsApp(waCfg, phone, text, `${req.nextUrl.origin}/api/twilio/whatsapp/status?leadId=${encodeURIComponent(id)}`)
    } catch (e) {
      // Outside WhatsApp's 24-hour window a freeform message is refused
      // (Twilio 63016) — reported as it is, rather than as a generic failure.
      return NextResponse.json({ error: e instanceof Error ? e.message : 'WhatsApp refused the message.' }, { status: 502 })
    }
    await writeControlRow({
      sessionId: id, siteId: access.siteId, role: CRM_WA_OUT_ROLE,
      message: JSON.stringify({
        sid: waSent.sid, from: waCfg.whatsappFrom.replace(/^whatsapp:/, ''), to: phone,
        // Redacted for the same reason the email copy is: the timeline is
        // served straight back to the agent.
        body: redactedForTimeline(text, url),
        at: new Date().toISOString(), sentBy: access.member.email,
        direction: 'outbound' as const, status: waSent.status || 'queued',
      }),
    })
    await recordPayLinkSent(id, access.siteId, access.member.email, 'whatsapp')
    return NextResponse.json({ ok: true, channel: 'whatsapp', sentAt: new Date().toISOString() })
  }

  // ── Email ─────────────────────────────────────────────────────────────────
  // payChannel only returns 'email' when there is one; this narrows the type
  // and would catch the two ever disagreeing.
  if (!to) return NextResponse.json({ error: 'This lead has no email address on file.' }, { status: 400 })
  const problem = configProblem()
  if (problem) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })
  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured.', needsSetup: true }, { status: 503 })

  // The mail goes out through the SIGNED-IN PERSON'S OWN Gmail, exactly as the
  // composer's send does. So the first question is whether this member has one
  // connected at all — asked plainly, because swallowing the answer turned "your
  // Google account is not connected" into "no verified send-as address is
  // available", which names a thing the reader has never heard of and gives them
  // nothing to do about it.
  const conn = await connectionFor(access.member.email)
  if (!conn || conn.revoked) {
    // Name who CAN send it. "Connect your Gmail" is the obvious advice and for
    // some accounts it is a dead end — this OAuth app is Internal to one Google
    // Workspace org, so a consumer Gmail is refused by Google itself with
    // `403 org_internal`. Sending it out through an account that is already
    // connected is the answer that actually works, and the person reading this
    // has no way to know which those are.
    const others = (await connectedAddresses()).filter((e) => e !== access.member.email.toLowerCase())
    const who = others.length
      ? ` Or sign in as an account that already has Gmail connected (${others.slice(0, 3).join(', ')}) and press Send there — the mail goes out through whoever is signed in.`
      : ''
    return NextResponse.json({
      error: (conn?.revokedReason ?? `Gmail is not connected for ${access.member.email}, so this cannot be sent from here.`) + who,
      needsReconnect: true,
    }, { status: 401 })
  }

  let aliases: SendAsAlias[]
  try {
    aliases = await verifiedAliases(access.member.email, cfg)
  } catch (e) {
    if (e instanceof GmailRateError) return NextResponse.json({ error: e.message, retryable: true }, { status: 429 })
    if (e instanceof GmailAuthError) return NextResponse.json({ error: e.message, needsReconnect: true }, { status: 401 })
    return NextResponse.json({ error: 'Gmail could not be reached to check which address this may be sent from.' }, { status: 502 })
  }

  const [agentSigs, siteContacts, allSites, chatNames] = await Promise.all([
    loadAgentSignatures(), loadSiteContacts(),
    db.from('sites').select('site_id, name'), storedMemberNames(),
  ])
  const siteNameOf = new Map((allSites.data ?? []).map((r) => [r.site_id, String(r.name ?? '')]))
  const siteName = siteNameOf.get(access.siteId) ?? ''
  const alias = aliasForSite(aliases, access.siteId, siteName)
  if (!alias) {
    return NextResponse.json({
      error: `${access.member.email} has Gmail connected, but Google lists no verified send-as address on it. Add the site's address as a send-as alias in Gmail settings, then try again.`,
      needsSetup: true,
    }, { status: 503 })
  }

  const subject = `Payment link for your order${siteName ? ` — ${siteName}` : ''}`.slice(0, MAX_SUBJECT)
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
  await recordPayLinkSent(id, access.siteId, access.member.email, 'email')

  // Masked on the way out too, or the send would undo itself in one line.
  const hide = !canSeeContacts(access.member)
  return NextResponse.json({
    ok: true,
    channel: 'email',
    sentAt: entry.at,
    to: hide ? null : to,
    from: alias.email,
  })
}
