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
  // THE CHAT WIDGET'S DISPLAY NAME IS NOT A FALLBACK FOR THIS, and it was one
  // for a few minutes. That name is deliberately the BRAND — customers chatting
  // on a site should see the company, not a stranger's name — so borrowing it
  // here signed dev@zeecustomboxes.com's mail "Shop Cardboard Boxes" above
  // "Peptides Boxes": two company names and no person. A signature with no name
  // is merely incomplete; one that names the wrong company is wrong.
  // The name comes from the signature's own field or not at all.
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
  let siteName = ''
  if (siteId && mine.includes(siteId)) {
    const { data } = await supabase.from('sites').select('name').eq('site_id', siteId).maybeSingle()
    siteName = String(data?.name ?? '')
  }

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
          email: from || member.email,
          company: siteName,
        })
      : '',
    // The designed block, for the Members page preview. Exactly what the send
    // route appends, from the same function — a preview built any other way is
    // a drawing of the feature rather than the feature.
    signatureHtml: siteId && mine.includes(siteId)
      ? renderSignatureHtml(agent, sites.get(siteId), {
          email: from || member.email,
          company: siteName,
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
