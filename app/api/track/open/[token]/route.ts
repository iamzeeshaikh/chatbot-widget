import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { resolveLeadSite } from '@/lib/leadrecord'
import { CRM_EMAIL_OPEN_ROLE, PIXEL_GIF, verifyOpenToken } from '@/lib/emailtrack'

export const dynamic = 'force-dynamic'

// The open pixel. Public and unauthenticated by nature — it is fetched by the
// customer's mail client — so it trusts nothing but the HMAC token, records
// only "this email id was opened at this time", and always answers with the
// image so a bad token cannot be told apart from a good one.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const t = token.replace(/\.gif$/i, '')
  const sessionId = req.nextUrl.searchParams.get('l') ?? ''
  const emailId = req.nextUrl.searchParams.get('e') ?? ''
  if (sessionId && emailId && t && verifyOpenToken(t, sessionId, emailId)) {
    const resolved = await resolveLeadSite(sessionId)
    if (resolved) {
      await supabase.from('chat_logs').insert([{
        session_id: sessionId, site_id: resolved.siteId, role: CRM_EMAIL_OPEN_ROLE,
        message: JSON.stringify({ emailId, at: new Date().toISOString(), ua: (req.headers.get('user-agent') ?? '').slice(0, 160) }),
      }])
    }
  }
  return new NextResponse(PIXEL_GIF, {
    headers: {
      'Content-Type': 'image/gif', 'Content-Length': String(PIXEL_GIF.length),
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', Pragma: 'no-cache', Expires: '0',
    },
  })
}
