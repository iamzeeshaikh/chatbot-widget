import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { googleConfig, exchangeCode, saveConnection, verifyState, GMAIL_SCOPES } from '@/lib/gmail'

export const dynamic = 'force-dynamic'

// Step 2: Google sends the agent back here with a one-time code.
//
// Three things are checked before anything is stored:
//   1. the signed `state` matches a flow this session actually started (CSRF)
//   2. the Google account that consented is the same person as the session —
//      otherwise an agent could attach someone else's mailbox to their own login
//   3. Google actually granted both scopes we asked for
function back(origin: string, to: string, params: Record<string, string>): NextResponse {
  const url = new URL(to.startsWith('/') ? to : '/', origin)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin
  const sp = req.nextUrl.searchParams
  const state = verifyState(sp.get('state') ?? '')
  const to = state?.back && state.back.startsWith('/') ? state.back : '/'

  const member = await getMember(req)
  if (!member) return NextResponse.redirect(new URL('/login', origin))

  // The agent declined, or Google refused.
  const err = sp.get('error')
  if (err) return back(origin, to, { gmail: 'error', reason: err === 'access_denied' ? 'You declined the Gmail permission.' : err })

  if (!state) return back(origin, to, { gmail: 'error', reason: 'That Gmail connection link has expired. Try again.' })
  if (state.email.toLowerCase() !== member.email.toLowerCase()) {
    return back(origin, to, { gmail: 'error', reason: 'That connection was started by a different account.' })
  }

  const code = sp.get('code')
  if (!code) return back(origin, to, { gmail: 'error', reason: 'Google did not return an authorisation code.' })

  const cfg = googleConfig(origin)
  if (!cfg) return back(origin, to, { gmail: 'error', reason: 'Google OAuth is not configured on the server.' })

  try {
    const t = await exchangeCode(cfg, code)
    // Without a refresh token the connection cannot outlive one hour. Google
    // only withholds it when consent was skipped, so ask again explicitly.
    if (!t.refreshToken) {
      return back(origin, to, { gmail: 'error', reason: 'Google did not return a refresh token. Remove ZeeOps from your Google account permissions and connect again.' })
    }
    const granted = new Set((t.scope ?? '').split(/\s+/))
    const missing = GMAIL_SCOPES.filter((s) => !granted.has(s))
    if (missing.length > 0) {
      return back(origin, to, { gmail: 'error', reason: 'Both the send and the alias permissions are needed. Connect again and leave every box ticked.' })
    }
    // The connection is stored against the DASHBOARD member, but keyed to the
    // Google mailbox that consented — mismatches are surfaced, not silently
    // accepted, because sending would then come from an unexpected address.
    if (t.email && t.email.toLowerCase() !== member.email.toLowerCase()) {
      return back(origin, to, {
        gmail: 'error',
        reason: `You signed in to Google as ${t.email}, but you are logged in here as ${member.email}. Connect the matching Google account.`,
      })
    }

    await saveConnection(member.email, t.refreshToken, t.scope ?? '')
    return back(origin, to, { gmail: 'connected' })
  } catch (e) {
    console.error('[gmail] callback failed:', e instanceof Error ? e.message : e)
    return back(origin, to, { gmail: 'error', reason: e instanceof Error ? e.message : 'Could not complete the Gmail connection.' })
  }
}
