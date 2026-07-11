import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { savePushSubscription, removePushSubscription } from '@/lib/push'

// GET  → the VAPID public key the browser needs to subscribe.
// POST → save this device's push subscription ({ subscription }) or remove it
//        ({ endpoint, remove: true }).
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (body?.remove && typeof body.endpoint === 'string') {
    await removePushSubscription(member.email, member.workspace, body.endpoint)
    return NextResponse.json({ success: true })
  }
  const sub = body?.subscription
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }
  await savePushSubscription(member.email, member.workspace, sub)
  return NextResponse.json({ success: true })
}
