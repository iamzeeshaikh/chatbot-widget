import { NextRequest, NextResponse } from 'next/server'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { workspaceForHost } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

// The chat widget as the ZeeDesk sites load it: https://chat.zeedesk.dev/w.js.
//
// It is public/widget.js, the same code the ZeeOps sites run, with two things
// changed on the way out, because a script tag is public and the owner wants
// nothing on a ZeeDesk site to point at his other sites:
//   1. it talks to the host it was loaded from, not chat.zeeops.dev;
//   2. every "zee" identifier (class names, storage keys, the global guard)
//      is renamed, so the two widgets do not share a recognisable fingerprint.
// None of those names reach the server: the API sees site ids and session ids
// only, so the rename needs nothing on the other side.
//
// Served only on a ZeeDesk host. Anywhere else it does not exist, so the
// renamed copy cannot be fetched from the ZeeOps domain and compared.
let cache: { src: string; out: string } | null = null

function transform(src: string, origin: string): string {
  // The host goes in last, through a placeholder: it contains "zee" itself and
  // the rename would otherwise turn chat.zeedesk.dev into chat.dkdesk.dev.
  const HOLD = '\u0001ORIGIN\u0001'
  return src
    .split('https://chat.zeeops.dev').join(HOLD)
    .replace(/^\s*console\.log\('WIDGET LOADED[^\n]*\n/m, '')
    .replace(/ZEE/g, 'DK').replace(/Zee/g, 'Dk').replace(/zee/g, 'dk')
    .split(HOLD).join(origin)
}

export async function GET(req: NextRequest) {
  const host = (req.headers.get('host') || '').toLowerCase().split(':')[0]
  if (workspaceForHost(host) !== 'zeedesk') return new NextResponse('Not found', { status: 404 })
  const src = readFileSync(path.join(process.cwd(), 'public', 'widget.js'), 'utf8')
  const origin = `https://${host}`
  if (!cache || cache.src !== src + origin) cache = { src: src + origin, out: transform(src, origin) }
  return new NextResponse(cache.out, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
