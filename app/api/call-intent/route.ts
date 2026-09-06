import { NextRequest, NextResponse } from 'next/server'
import { recordCallIntent } from '@/lib/callintent'
import { isLeadTracked } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export function OPTIONS() { return new NextResponse(null, { headers: cors }) }

// A visitor tapped the phone number on one of the sites.
//
// Public and unauthenticated, like the rest of the widget's endpoints — it is
// called from a customer's browser. It writes nothing but a site id and a
// timestamp, and the site id is checked against our own list, so the worst a
// forged call can do is add noise to a ten-minute window.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const siteId = String(body?.siteId ?? '').trim()
    if (!siteId || !isLeadTracked(siteId)) {
      return NextResponse.json({ ok: false }, { status: 400, headers: cors })
    }
    await recordCallIntent(siteId, typeof body?.page === 'string' ? body.page : undefined)
    return NextResponse.json({ ok: true }, { headers: cors })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400, headers: cors })
  }
}
