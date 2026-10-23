import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getMember } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// The intake engine, served to the Gmail Apps Script LOADER
// (scripts/quote-intake-loader.gs). The owner pastes the loader ONCE; every
// run fetches the current engine from here, so a change to
// scripts/quote-intake-apps-script.gs ships with a normal deploy and nobody
// pastes anything again (owner, 2026-10-23: "rozana update karwate ho, aik hi
// dafa karlo"). Same secret as /api/quote-intake: the code is only handed to
// the script that already holds it.
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-quote-secret')
  const ok = !!secret && secret === process.env.QUOTE_INTAKE_SECRET
  // A signed-in admin may read it too, to check what the loader will run.
  if (!ok) { const m = await getMember(req); if (m?.role !== 'admin') return new NextResponse('Unauthorized', { status: 401 }) }
  const src = readFileSync(path.join(process.cwd(), 'scripts', 'quote-intake-apps-script.gs'), 'utf8')
  return new NextResponse(src, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
}
