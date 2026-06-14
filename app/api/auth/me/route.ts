import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Server-validated identity. The UI relies on this (not the readable cookie) so
// the displayed workspace/role/sites always match what the server enforces.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({
    email: member.email,
    role: member.role,
    workspace: member.workspace,
    sites: memberSites(member),
  })
}
