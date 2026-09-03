import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { writeControlRow } from '@/lib/leadrecord'
import { REMINDER_SITE } from '@/lib/reminders'
import { CRM_SITE_CONTACT_ROLE, SITE_CONTACT_SESSION } from '@/lib/signature'

export const dynamic = 'force-dynamic'

// The business half of a signature: company name, phone, website, address.
//
// ADMIN ONLY, deliberately. This is the text every agent's outgoing mail
// carries, so one wrong edit misrepresents the company on every message rather
// than on one person's. An agent's own name and title are theirs to change; the
// office address is not.
export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (member.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin can change a business address.' }, { status: 403 })
  }
  if (!hasFeature(member.workspace, 'email')) {
    return NextResponse.json({ error: 'Email is not enabled for this workspace' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const siteId = String(body.siteId ?? '').trim()
  if (!siteId) return NextResponse.json({ error: 'siteId required' }, { status: 400 })
  if (!(await canAccessSite(member, siteId))) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 })
  }

  const entry = {
    siteId,
    company: String(body.company ?? '').trim().slice(0, 160),
    phone: String(body.phone ?? '').trim().slice(0, 40),
    website: String(body.website ?? '').trim().slice(0, 160),
    // Left blank until somebody types a real one. An invented address on
    // outgoing mail is worse than no address at all.
    address: String(body.address ?? '').trim().slice(0, 300),
  }
  const { error } = await writeControlRow({
    sessionId: SITE_CONTACT_SESSION, siteId: REMINDER_SITE,
    role: CRM_SITE_CONTACT_ROLE, message: JSON.stringify(entry),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, site: entry })
}
