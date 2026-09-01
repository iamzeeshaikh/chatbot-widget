import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { supabase } from '@/lib/supabase'
import { twilioAuth } from '@/lib/twilio'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE } from '@/lib/crm'
import { parseWaMessage } from '@/lib/whatsapp'
import { WHATSAPP_MEDIA_BUCKET } from '@/lib/whatsappmedia'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Serve a file that travelled over WhatsApp.
//
// TWO KINDS, one endpoint:
//   • what the CUSTOMER sent — a Twilio media URL that needs the account's own
//     credentials to fetch. It cannot be put in an <img src>, so it is streamed
//     through here.
//   • what WE sent — an object in Storage.
//
// THE CHECK THAT MATTERS: the requested file must appear on a WhatsApp row
// belonging to THIS lead. Without it, an agent who can open one lead could pull
// any customer's document out of the account by guessing a URL — and the media
// id is not a secret, it is in Twilio's logs.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'telephony')
  if (!access.ok) return new NextResponse('Not allowed', { status: access.status })

  const want = req.nextUrl.searchParams.get('url') ?? ''
  const path = req.nextUrl.searchParams.get('path') ?? ''
  if (!want && !path) return new NextResponse('Nothing asked for', { status: 400 })

  // Does this file actually belong to this lead?
  const { data: rows } = await supabase.from('chat_logs')
    .select('message').eq('session_id', id)
    .in('role', [CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE])
    .order('created_at', { ascending: false }).limit(300)

  let match: { url?: string; type: string; path?: string; name?: string } | null = null
  for (const r of rows ?? []) {
    const w = parseWaMessage(r.message)
    for (const m of w?.media ?? []) {
      if ((want && m.url === want) || (path && m.path === path)) { match = m; break }
    }
    if (match) break
  }
  if (!match) return new NextResponse('Not found on this lead', { status: 404 })

  // Ours: stream it out of Storage.
  if (match.path) {
    const { data, error } = await supabase.storage.from(WHATSAPP_MEDIA_BUCKET).download(match.path)
    if (error || !data) return new NextResponse('Not available', { status: 404 })
    return new NextResponse(await data.arrayBuffer(), {
      headers: {
        'Content-Type': match.type || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${(match.name || 'file').replace(/"/g, '')}"`,
        'Cache-Control': 'private, max-age=300',
      },
    })
  }

  // Theirs: fetch from Twilio with the account's credentials.
  const auth = twilioAuth()
  if (!auth || !match.url) return new NextResponse('Not available', { status: 404 })
  if (!/^https:\/\/api\.twilio\.com\//.test(match.url)) {
    // The stored URL is compared against our own rows above, but this is the
    // second lock: whatever else happens, this endpoint only ever fetches from
    // Twilio — never an arbitrary address someone managed to write into a row.
    return new NextResponse('Not available', { status: 400 })
  }
  const res = await fetch(match.url, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${auth.sid}:${auth.token}`).toString('base64') },
    redirect: 'follow',
  })
  if (!res.ok) return new NextResponse('Not available', { status: 502 })

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': res.headers.get('content-type') || match.type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
    },
  })
}
