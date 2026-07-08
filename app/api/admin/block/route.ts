import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { setIpBlocked, getBlockedIps } from '@/lib/blocklist'

// Block / unblock a visitor IP (admin only — blocking is destructive enough
// that standard agents shouldn't wield it). GET lists the current blocklist.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member || member.role !== 'admin') return NextResponse.json({ ips: [] }, { status: member ? 403 : 401 })
  return NextResponse.json({ ips: Array.from(await getBlockedIps()).sort() })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'Admins only' }, { status: 403 })

  const { ip, block } = await req.json()
  const cleanIp = typeof ip === 'string' ? ip.trim() : ''
  // Loose sanity check (IPv4 or IPv6-ish) — mainly to prevent junk rows.
  if (!cleanIp || cleanIp.length > 45 || !/^[0-9a-fA-F.:]+$/.test(cleanIp)) {
    return NextResponse.json({ error: 'Invalid IP' }, { status: 400 })
  }
  await setIpBlocked(cleanIp, block !== false, member.email)
  return NextResponse.json({ success: true })
}
