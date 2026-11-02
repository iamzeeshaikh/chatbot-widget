import { NextRequest, NextResponse } from 'next/server'
import { siteDomain } from '@/lib/sitedomains'

// A site's own icon, for the dashboard's site cards. The icon the site's pages
// declare (<link rel="icon">) wins over /favicon.ico: three sites still serve
// Vercel's default triangle at /favicon.ico while their pages point at the
// real icon (owner, 2 Nov 2026: "vercel wale nahi hone chaie"). Redirects to
// the icon; the browser and Vercel's CDN keep the answer for a day.
export const dynamic = 'force-dynamic'

const DAY = 86400

function pick(html: string, base: string): string | null {
  const links = html.match(/<link\b[^>]*>/gi) ?? []
  const icons: { href: string; score: number }[] = []
  for (const tag of links) {
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').toLowerCase()
    if (!/\bicon\b/.test(rel) || /mask-icon/.test(rel)) continue
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href) continue
    const size = Number(tag.match(/\bsizes\s*=\s*["'](\d+)x\d+/i)?.[1] ?? 0)
    // An SVG scales; otherwise the size nearest 64px, a declared one before none.
    const score = /\.svg(\?|$)|image\/svg/i.test(tag) ? 1000 : size ? 500 - Math.abs(size - 64) : 100
    try { icons.push({ href: new URL(href, base).toString(), score }) } catch { /* bad href */ }
  }
  icons.sort((a, b) => b.score - a.score)
  return icons[0]?.href ?? null
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await ctx.params
  const domain = siteDomain(siteId)
  const google = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=64`
  if (!domain) return new NextResponse(null, { status: 404 })
  const base = `https://${domain}/`
  let target = `${base}favicon.ico`
  try {
    const res = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'ZeeOps-dashboard-icon/1.0' } })
    const found = res.ok ? pick(await res.text(), res.url || base) : null
    if (found) target = found
    else {
      const ico = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => null)
      if (!ico?.ok || !(ico.headers.get('content-type') ?? '').startsWith('image')) target = google(domain)
    }
  } catch {
    target = google(domain)
  }
  return NextResponse.redirect(target, { status: 302, headers: { 'cache-control': `public, max-age=${DAY}, s-maxage=${DAY}` } })
}
