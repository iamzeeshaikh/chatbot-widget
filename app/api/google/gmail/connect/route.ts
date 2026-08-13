import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { googleConfig, consentUrl, configProblem, signState } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

// Step 1 of the Gmail connection: bounce the agent to Google's consent screen.
//
// Its own OAuth flow, its own scopes (gmail.send + gmail.settings.basic) and its
// own consent, deliberately not layered onto any other Google integration — so
// revoking mail access can never take anything else down with it.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.redirect(new URL('/login', req.nextUrl.origin))
  if (!hasFeature(member.workspace, 'email')) {
    return NextResponse.redirect(new URL('/?gmail=unavailable', req.nextUrl.origin))
  }

  const back = req.nextUrl.searchParams.get('back') || '/'
  const problem = configProblem()
  if (problem) {
    const url = new URL(back, req.nextUrl.origin)
    url.searchParams.set('gmail', 'error')
    url.searchParams.set('reason', problem)
    return NextResponse.redirect(url)
  }
  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured' }, { status: 500 })

  return NextResponse.redirect(consentUrl(cfg, signState(member.email, back), member.email))
}
