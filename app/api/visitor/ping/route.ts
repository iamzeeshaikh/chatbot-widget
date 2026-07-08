import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { unpackVisitor, packVisitor, appendHistory, LIVE_MAX_ON_SITE_MS, asUtcIso } from '@/lib/visitor'
import { resolveCountryCode } from '@/lib/geo'
import { isWidgetBlocked } from '@/lib/workspaces'
import { getBlockedIps, requestIp } from '@/lib/blocklist'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

function parseUserAgent(ua: string): { browser: string; os: string; device_type: string } {
  const s = ua ?? ''

  let browser = 'Unknown'
  if (/Edg\//.test(s)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera'
  else if (/Firefox\//.test(s)) browser = 'Firefox'
  else if (/Chrome\//.test(s)) browser = 'Chrome'
  else if (/Safari\//.test(s)) browser = 'Safari'

  let os = 'Unknown'
  if (/Windows/.test(s)) os = 'Windows'
  else if (/Android/.test(s)) os = 'Android'
  else if (/iPhone|iPad/.test(s)) os = 'iOS'
  else if (/Mac OS X/.test(s)) os = 'Mac'
  else if (/Linux/.test(s)) os = 'Linux'

  let device_type = 'Desktop'
  if (/iPad|Tablet/.test(s)) device_type = 'Tablet'
  else if (/Mobile|iPhone|Android.*Mobile/.test(s)) device_type = 'Mobile'

  return { browser, os, device_type }
}

async function getGeo(ip: string): Promise<{ country: string; city: string }> {
  // Skip private/loopback IPs
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return { country: '', city: '' }
  }
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`, {
      headers: { 'User-Agent': 'chatbot-widget/1.0' },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return { country: '', city: '' }
    const data = await res.json()
    return {
      country: data.country_name ?? '',
      city: data.city ?? '',
    }
  } catch {
    return { country: '', city: '' }
  }
}

function countryToFlag(country: string): string {
  const map: Record<string, string> = {
    'Australia': '🇦🇺', 'United States': '🇺🇸', 'United Kingdom': '🇬🇧',
    'Pakistan': '🇵🇰', 'India': '🇮🇳', 'Canada': '🇨🇦', 'Germany': '🇩🇪',
    'France': '🇫🇷', 'Netherlands': '🇳🇱', 'Singapore': '🇸🇬', 'UAE': '🇦🇪',
    'United Arab Emirates': '🇦🇪', 'Saudi Arabia': '🇸🇦', 'Bangladesh': '🇧🇩',
    'New Zealand': '🇳🇿', 'South Africa': '🇿🇦', 'Brazil': '🇧🇷', 'Japan': '🇯🇵',
  }
  return map[country] ?? '🌐'
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { sessionId, siteId, pageUrl, pageTitle, referrer, visits, userAgent, screenWidth, status, visitorId } = body
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders })

    if (status === 'left') {
      await supabase
        .from('active_visitors')
        .update({ status: 'left', last_seen: new Date().toISOString() })
        .eq('session_id', sessionId)
      return NextResponse.json({ ok: true }, { headers: corsHeaders })
    }

    // Admin IP blocklist: a blocked visitor never records presence.
    const reqIp = requestIp(req.headers)
    if (reqIp && (await getBlockedIps()).has(reqIp)) {
      return NextResponse.json({ ok: true, blocked: true }, { headers: corsHeaders })
    }

    // Geo-block enforcement (defense-in-depth): a blocked South-Asian visitor on
    // a packaging site must NEVER produce a live-visitor row, even if an old or
    // cached widget keeps pinging. Country comes from the reliable Vercel edge
    // header (ipapi fallback in dev). Sports sites are never blocked.
    if (siteId) {
      const code = await resolveCountryCode(req.headers)
      if (isWidgetBlocked(siteId, code)) {
        return NextResponse.json({ ok: true, blocked: true }, { headers: corsHeaders })
      }
    }

    const { browser, os, device_type } = parseUserAgent(userAgent ?? '')

    // Get IP from headers (Vercel sets x-forwarded-for)
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
    const geo = await getGeo(ip)

    const flag = countryToFlag(geo.country)

    // The active_visitors table has no columns for page title / referrer / visit
    // count / IP / page history, and we can't run DDL — so we pack them with the
    // URL into page_url as a small JSON blob (see lib/visitor.ts). Read the prior
    // row first so we can extend the page-history trail instead of overwriting it.
    const { data: existing } = await supabase
      .from('active_visitors')
      .select('page_url, created_at')
      .eq('session_id', sessionId)
      .maybeSingle()
    const prev = unpackVisitor(existing?.page_url ?? null)

    // Stop a passive heartbeat from keeping an ancient session "live": if this
    // session started longer ago than the live cap, it's stale (e.g. a tab left
    // open since yesterday still pinging the old sessionId). Mark it ended and
    // don't refresh last_seen, so it can never resurface as "active now". A fresh
    // sessionId (the widget rotates after inactivity) gets a clean new row.
    if (existing?.created_at) {
      const startedMs = new Date(asUtcIso(existing.created_at)!).getTime()
      if (Date.now() - startedMs > LIVE_MAX_ON_SITE_MS) {
        await supabase.from('active_visitors').update({ status: 'left' }).eq('session_id', sessionId)
        return NextResponse.json({ ok: true, expired: true }, { headers: corsHeaders })
      }
    }

    const packedUrl = packVisitor({
      page_url: pageUrl ?? null,
      page_title: pageTitle ?? null,
      referrer: referrer ?? null,
      visits: typeof visits === 'number' ? visits : (parseInt(visits, 10) || 1),
      ip: ip || prev.ip || null,
      vid: (typeof visitorId === 'string' && visitorId) || prev.vid || null,
      history: appendHistory(prev.history, pageUrl ?? null, pageTitle ?? null),
    })

    // UPSERT keyed on session_id: update last_seen (and details) when the
    // session already exists, only INSERT when it's truly new — never a new row
    // per ping.
    await supabase.from('active_visitors').upsert({
      session_id: sessionId,
      site_id: siteId,
      page_url: packedUrl,
      user_agent: userAgent ?? null,
      device_type,
      browser,
      os,
      screen_width: screenWidth ?? null,
      country: geo.country ? `${flag} ${geo.country}` : null,
      city: geo.city || null,
      status: 'active',
      last_seen: new Date().toISOString(),
    }, { onConflict: 'session_id' })

    return NextResponse.json({ ok: true }, { headers: corsHeaders })
  } catch (err) {
    console.error('Visitor ping error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders })
  }
}
