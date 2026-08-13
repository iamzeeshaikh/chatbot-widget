import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { googleConfig, connectionFor, verifiedAliases, configProblem, GmailAuthError } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

// Whether this agent can send, from which addresses, AND whether their consent
// covers reading replies.
//
// `canReadReplies` is reported separately from `connected` on purpose. A
// connection made before Phase 6 sends perfectly well, so calling it
// "disconnected" would be wrong and would block sending for no reason — but
// leaving it looking wholly healthy is worse, because replies then never arrive
// and nothing on screen says why. It is a third state, and the UI shows it.
//
// The alias list comes from Google every time rather than being cached: an alias
// removed or unverified in Google Workspace must disappear from the composer
// immediately, and this is also what the send path validates against.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Not an error: a workspace without the email feature simply has no Gmail to report.
  if (!hasFeature(member.workspace, 'email')) return NextResponse.json({ connected: false, available: false })

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
    return NextResponse.json({
      connected: true, configured: true, connectedAt: conn.connectedAt, aliases,
      canReadReplies: conn.canRead,
      // Named so the composer can say exactly what is missing and what it costs.
      replyCaptureReason: conn.canRead
        ? null
        : 'This Gmail connection was made before reply capture existed, so customer replies will not appear on the record. Reconnect to switch it on — sending keeps working either way.',
    })
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
