import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { identityFor, mintVoiceToken, voiceTokenConfig, voiceTokenProblem } from '@/lib/voicetoken'

export const dynamic = 'force-dynamic'

// The browser asks for permission to be a phone.
//
// Authenticated like any other endpoint here — the token is minted for the
// SIGNED-IN member's own identity, never for one named in the request. A member
// cannot ask for somebody else's line, which is the whole reason the identity
// is derived server-side rather than posted.
//
// A workspace without 'telephony' is refused: there is one Twilio account and
// it belongs to sports.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!hasFeature(member.workspace, 'telephony')) {
    return NextResponse.json({ error: 'Calling is not available for this workspace.' }, { status: 403 })
  }

  const cfg = voiceTokenConfig()
  if (!cfg) {
    // 200, not an error: "not set up yet" is a state the UI shows calmly, and a
    // 503 here would make every lead page log a failed request.
    return NextResponse.json({ ready: false, reason: voiceTokenProblem() })
  }

  const minted = mintVoiceToken(cfg, identityFor(member.email))
  return NextResponse.json({ ready: true, ...minted }, { headers: { 'Cache-Control': 'no-store' } })
}
