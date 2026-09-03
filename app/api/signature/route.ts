import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { writeControlRow } from '@/lib/leadrecord'
import { REMINDER_SITE } from '@/lib/reminders'
import {
  CRM_SIGNATURE_ROLE, SIGNATURE_SESSION,
  loadAgentSignatures, loadSiteContacts, renderSignature, renderSignatureHtml,
} from '@/lib/signature'
import { supabase } from '@/lib/supabase'
import { storedMemberNames } from '@/lib/membername'

export const dynamic = 'force-dynamic'

// The signature a member's emails end with.
//
// GET  — this member's own details, the site details, and (with ?siteId=) the
//        finished signature the composer drops into a new message.
// POST — save this member's own details. An admin may pass `email` to edit
//        somebody else's, because agents join and leave and the person who has
//        to fix a wrong job title is usually not the person who typed it.
//
// The SITE half is a separate route: an address belongs to the business, not to
// whoever last opened the composer, and letting any agent rewrite it would put
// twenty different versions of one address on outgoing mail.

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'email')) {
    return NextResponse.json({ error: 'Email is not enabled for this workspace' }, { status: 403 })
  }

  const [agents, sites, mine, chatNames] = await Promise.all([
    loadAgentSignatures(), loadSiteContacts(), memberSites(member), storedMemberNames(),
  ])
  // ── the name, when the agent has not set one ──────────────────────────────
  // The chat widget's display name is used, because for eight of the nine
  // people here it IS their name — Samir Khan, Steve Hayes, Danny Diaz. But
  // that field is allowed to hold a BRAND instead: dev@zeecustomboxes.com's is
  // "Shop Cardboard Boxes", and borrowing that signed its mail with two company
  // names and no person. So a chat name that matches one of the site names is
  // rejected and the line is left out — better incomplete than wrong.
  const agent = agents.get(member.email.toLowerCase()) ?? null
  const siteId = req.nextUrl.searchParams.get('siteId') ?? ''
  // The address the composer is actually sending FROM, which on these sites is
  // a per-site alias — samirkhan@peptidesboxes.com, not the login. Signing a
  // Peptides email with a Shop Cardboard Boxes address invites the customer to
  // reply somewhere nobody is reading.
  const from = req.nextUrl.searchParams.get('from')?.trim() ?? ''

  // A brand-new agent has filled nothing in, and a signature that is only an
  // email address is worse than useless. Their display name and the site's own
  // name stand in until somebody types something better.
  const { data: siteRows } = await supabase.from('sites').select('site_id, name')
  const siteNames = new Map((siteRows ?? []).map((r) => [r.site_id, String(r.name ?? '')]))
  const isCompanyName = new Set(Array.from(siteNames.values()).map((n) => n.toLowerCase()))
  const chatName = chatNames.get(member.email.trim().toLowerCase()) ?? ''
  const fallbackName = isCompanyName.has(chatName.toLowerCase()) ? '' : chatName
  const siteName = siteId && mine.includes(siteId) ? (siteNames.get(siteId) ?? '') : ''

  return NextResponse.json({
    agent,
    // Only the sites this member can actually work — the same scope every
    // other endpoint uses, so a signature editor cannot become a directory of
    // the other workspace's businesses.
    sites: mine.map((id) => sites.get(id) ?? { siteId: id, company: '', phone: '', website: '', address: '' }),
    // Rendered server-side so the composer and anything else that sends mail
    // can never disagree about what the signature looks like.
    signature: siteId && mine.includes(siteId)
      ? renderSignature(agent, sites.get(siteId), {
          name: fallbackName,
          email: from || member.email,
          company: siteName,
        })
      : '',
    // The designed block, for the Members page preview. Exactly what the send
    // route appends, from the same function — a preview built any other way is
    // a drawing of the feature rather than the feature.
    signatureHtml: siteId && mine.includes(siteId)
      ? renderSignatureHtml(agent, sites.get(siteId), {
          name: fallbackName,
          email: from || member.email,
          company: siteName,
          logoSrc: `${req.nextUrl.origin}/api/logo/${encodeURIComponent(siteId)}`,
        })
      : '',
    // Admins get everyone's, so they can fill in a new starter's details.
    all: member.role === 'admin' ? Array.from(agents.values()) : undefined,
  })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'email')) {
    return NextResponse.json({ error: 'Email is not enabled for this workspace' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const target = String(body.email ?? '').trim().toLowerCase() || member.email.toLowerCase()
  if (target !== member.email.toLowerCase() && member.role !== 'admin') {
    return NextResponse.json({ error: 'You can only edit your own signature.' }, { status: 403 })
  }

  const entry = {
    email: target,
    name: String(body.name ?? '').trim().slice(0, 120),
    title: String(body.title ?? '').trim().slice(0, 120),
    phone: String(body.phone ?? '').trim().slice(0, 40),
  }
  const { error } = await writeControlRow({
    sessionId: SIGNATURE_SESSION, siteId: REMINDER_SITE,
    role: CRM_SIGNATURE_ROLE, message: JSON.stringify(entry),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, agent: entry })
}
