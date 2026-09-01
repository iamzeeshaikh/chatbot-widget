import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember } from '@/lib/auth'
import { guardLeadAccess } from '@/lib/leadrecord'
import { twilioConfig } from '@/lib/twilio'
import { CRM_CALL_ROLE } from '@/lib/crm'
import { parseCall } from '@/lib/call'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Play a voicemail back.
//
// Twilio's media URL needs the account credentials, so the audio is fetched
// here and streamed on — the browser never sees a Twilio URL, and the
// credentials never leave the server.
//
// The recording id is CHECKED AGAINST THIS LEAD'S OWN ROWS before anything is
// fetched: without that, any signed-in member could read any recording in the
// account by guessing an id, which is the same class of hole the email
// attachment route closed.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'records')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const cfg = twilioConfig(access.member.workspace)
  if (!cfg) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  const wanted = req.nextUrl.searchParams.get('sid') ?? ''
  if (!wanted) return NextResponse.json({ error: 'sid required' }, { status: 400 })

  const { data: rows } = await supabase.from('chat_logs')
    .select('message').eq('session_id', id).eq('role', CRM_CALL_ROLE)
    .order('created_at', { ascending: false }).limit(200)
  const known = (rows ?? []).some((r) => parseCall(r.message)?.recordingSid === wanted)
  if (!known) return NextResponse.json({ error: 'That recording is not on this lead.' }, { status: 404 })

  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Recordings/${wanted}.mp3`,
    { headers: { Authorization: auth } },
  )
  if (!res.ok || !res.body) {
    return NextResponse.json({ error: 'The recording could not be fetched.' }, { status: 502 })
  }

  return new NextResponse(res.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=300',
    },
  })
}
