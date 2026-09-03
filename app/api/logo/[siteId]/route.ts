import { NextRequest, NextResponse } from 'next/server'
import { loadSiteContacts } from '@/lib/signature'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

// A site's logo, served from OUR origin.
//
// WHY THIS EXISTS: the logos live on the sites themselves, and those sites send
// `Cross-Origin-Resource-Policy: same-origin` — which tells a browser to refuse
// to render the image anywhere but on that site. curl does not enforce it, so
// a plain fetch of the URL returns 200 and looks fine; the composer showed a
// broken-image box. Proxying moves the request server-side, where the header
// does not apply, and puts the bytes back on an origin allowed to show them.
//
// PUBLIC ON PURPOSE, and safe. It has to be reachable without a session
// because a mail client fetches it when a customer opens the email. It is not
// an open proxy: the only URL it will ever fetch is the one already stored for
// that siteId by an admin, so the request cannot name a target.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await ctx.params
  const contacts = await loadSiteContacts()
  const url = contacts.get(siteId)?.logo ?? ''
  if (!/^https:\/\//i.test(url)) return new NextResponse('No logo', { status: 404 })

  const res = await fetch(url, { headers: { 'User-Agent': 'ZeeOps-Signature/1.0' } })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !res.body || !type.startsWith('image/')) {
    return new NextResponse('No logo', { status: 404 })
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': type,
      // A year, and public: this is fetched by every recipient's mail client,
      // and the image behind a given site changes about never.
      'Cache-Control': 'public, max-age=31536000, immutable',
      // The point of the whole endpoint — the header the origin sites set is
      // exactly what has to NOT be same-origin here.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
