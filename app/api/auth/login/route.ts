import { NextRequest, NextResponse } from 'next/server'

const ACCOUNTS = [
  { email: 'packaging@zeeops.dev', password: 'packaging123', role: 'packaging' as const },
  { email: 'sports@zeeops.dev',    password: 'sports123',    role: 'sports'    as const },
]

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    const account = ACCOUNTS.find((a) => a.email === email && a.password === password)
    if (!account) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }
    const payload = Buffer.from(JSON.stringify({ role: account.role, email: account.email })).toString('base64')
    const res = NextResponse.json({ ok: true, role: account.role })
    res.cookies.set('zee-auth', payload, {
      httpOnly: false, // readable client-side for role access
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    })
    return res
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
