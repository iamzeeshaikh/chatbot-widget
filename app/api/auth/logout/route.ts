import { NextResponse } from 'next/server'
import { SESSION_COOKIE, UI_COOKIE } from '@/lib/auth'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { maxAge: 0, path: '/' })
  res.cookies.set(UI_COOKIE, '', { maxAge: 0, path: '/' })
  return res
}
