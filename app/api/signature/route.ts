import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { writeControlRow } from '@/lib/leadrecord'
import { REMINDER_SITE } from '@/lib/reminders'
import {
  CRM_SIGNATURE_ROLE, SIGNATURE_SESSION,
  loadAgentSignatures, loadSiteContacts, renderSignature,
} from '@/lib/signature'

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

  const [agents, sites, mine] = await Promise.all([
    loadAgentSignatures(), loadSiteContacts(), memberSites(member),
  ])
  const agent = agents.get(member.email.toLowerCase()) ?? null
  const siteId = req.nextUrl.searchParams.get('siteId') ?? ''

  return NextResponse.json({
    agent,
    // Only the sites this member can actually work — the same scope every
    // other endpoint uses, so a signature editor cannot become a directory of
    // the other workspace's businesses.
    sites: mine.map((id) => sites.get(id) ?? { siteId: id, company: '', phone: '', website: '', address: '' }),
    // Rendered server-side so the composer and anything else that sends mail
    // can never disagree about what the signature looks like.
    signature: siteId && mine.includes(siteId)
      ? renderSignature(agent, sites.get(siteId), { email: member.email })
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
