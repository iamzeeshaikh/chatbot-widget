import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { googleConfig, connectionFor, verifiedAliases, configProblem, GmailAuthError } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

// Whether this agent can send, and from which addresses.
//
// The alias list comes from Google every time rather than being cached: an alias
// removed or unverified in Google Workspace must disappear from the composer
// immediately, and this is also what the send path validates against.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const problem = configProblem()
  if (problem) return NextResponse.json({ connected: false, configured: false, reason: problem, aliases: [] })

  const conn = await connectionFor(member.email)
  if (!conn || conn.revoked) {
    return NextResponse.json({
      connected: false, configured: true, aliases: [],
      reason: conn?.revokedReason ?? null,
      needsReconnect: !!conn?.revoked,
    })
  }

  const cfg = googleConfig(req.nextUrl.origin)!
  try {
    const aliases = await verifiedAliases(member.email, cfg)
    return NextResponse.json({ connected: true, configured: true, connectedAt: conn.connectedAt, aliases })
  } catch (e) {
    // An expired or withdrawn token surfaces as a clear "reconnect", never as
    // an empty dropdown with no explanation.
    const authy = e instanceof GmailAuthError
    return NextResponse.json({
      connected: false, configured: true, aliases: [],
      needsReconnect: authy,
      reason: e instanceof Error ? e.message : 'Could not reach Gmail.',
    })
  }
}
