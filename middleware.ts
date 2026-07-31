import { NextRequest, NextResponse } from 'next/server'

export function middleware(req: NextRequest) {
  const session = req.cookies.get('zee-session')
  if (!session) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}

export const config = {
  // Protect the dashboard root, member management, the CRM lead records and the
  // task queue. This only bounces signed-out browsers to /login — per-site
  // access for a signed-in member is enforced server-side in /api/leads/[id]
  // and /api/tasks.
  matcher: ['/', '/members', '/leads/:path*', '/tasks'],
}
