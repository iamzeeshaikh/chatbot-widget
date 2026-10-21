import { NextRequest, NextResponse } from 'next/server'
import { JOBS_ONLY_UIDS } from './lib/jobsonly'

// The member id inside the session cookie, read WITHOUT verifying it. That is
// enough for a redirect and nothing more: the real refusal for a jobs-only
// account happens server-side in getMember (lib/auth.ts).
function cookieUid(value: string): string {
  try {
    const part = value.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')
    const o = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)))
    return o?.t === 'm' && typeof o.uid === 'string' ? o.uid : ''
  } catch { return '' }
}

export function middleware(req: NextRequest) {
  const session = req.cookies.get('zee-session')
  if (!session) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  // The designer/estimator's account lives on /jobs (lib/jobsonly.ts).
  if (JOBS_ONLY_UIDS.includes(cookieUid(session.value)) && !req.nextUrl.pathname.startsWith('/jobs')) {
    return NextResponse.redirect(new URL('/jobs', req.url))
  }
  return NextResponse.next()
}

export const config = {
  // Protect the dashboard root, member management, the CRM lead records and the
  // task queue. This only bounces signed-out browsers to /login — per-site
  // access for a signed-in member is enforced server-side in /api/leads/[id]
  // and /api/tasks.
  matcher: ['/', '/members', '/leads/:path*', '/tasks', '/pipeline', '/reports', '/jobs', '/jobs/:path*', '/inbox', '/sales', '/opportunities'],
}
