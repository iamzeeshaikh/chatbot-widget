import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { twilioConfig } from '@/lib/twilio'

export const dynamic = 'force-dynamic'

// TEMPORARY. Creates the two Twilio objects the browser softphone needs — a
// TwiML App and an API Key — and is deleted the moment they exist.
//
// It runs on the server for one reason: the Twilio auth token lives in the
// Vercel environment and `vercel env pull` returns sensitive values EMPTY, so
// there is nowhere else the credentials can be used from. An endpoint that
// mints API keys is not something to leave lying around, admin-gated or not.
const API = 'https://api.twilio.com/2010-04-01'
const NAME = 'ZeeOps Softphone'

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!hasFeature(member.workspace, 'telephony')) {
    return NextResponse.json({ error: 'Not this workspace.' }, { status: 403 })
  }
  const cfg = twilioConfig()
  if (!cfg) return NextResponse.json({ error: 'Twilio is not configured.' }, { status: 503 })

  const auth = 'Basic ' + Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')
  const call = async (path: string, form?: Record<string, string>) => {
    const res = await fetch(`${API}/Accounts/${cfg.sid}/${path}`, {
      method: form ? 'POST' : 'GET',
      headers: { Authorization: auth, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${path}: ${j?.message ?? res.status}`)
    return j
  }

  const origin = req.nextUrl.origin
  const voiceUrl = `${origin}/api/twilio/voice/dial`

  try {
    // Reuse an app of this name rather than piling up duplicates, and point it
    // at the right URL in case one was made by hand.
    const list = await call('Applications.json?PageSize=50')
    const existing = (list.applications ?? []).find((a: { friendly_name?: string }) => a.friendly_name === NAME)
    const app = existing
      ? await call(`Applications/${existing.sid}.json`, { VoiceUrl: voiceUrl, VoiceMethod: 'POST' })
      : await call('Applications.json', { FriendlyName: NAME, VoiceUrl: voiceUrl, VoiceMethod: 'POST' })

    // A key's secret is returned once, at creation, and never again — so a new
    // key is minted rather than reusing one whose secret nobody can read.
    const key = await call('Keys.json', { FriendlyName: `${NAME} ${new Date().toISOString().slice(0, 10)}` })

    return NextResponse.json({
      ok: true,
      appSid: app.sid,
      voiceUrl: app.voice_url,
      keySid: key.sid,
      secret: key.secret,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
  }
}
