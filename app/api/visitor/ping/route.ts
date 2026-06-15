import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

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
    const { sessionId, siteId, pageUrl, pageTitle, referrer, visits, userAgent, screenWidth, status } = body
    if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400, headers: corsHeaders })

    if (status === 'left') {
      await supabase
        .from('active_visitors')
        .update({ status: 'left', last_seen: new Date().toISOString() })
        .eq('session_id', sessionId)
      return NextResponse.json({ ok: true }, { headers: corsHeaders })
    }

    const { browser, os, device_type } = parseUserAgent(userAgent ?? '')

    // Get IP from headers (Vercel sets x-forwarded-for)
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()
    const geo = await getGeo(ip)

    const flag = countryToFlag(geo.country)

    // The active_visitors table has no columns for page title / referrer / visit
    // count, and we can't run DDL — so pack them with the URL into page_url as a
    // small JSON blob. /api/visitor/active unpacks it. (Plain-URL legacy rows
    // are still handled there.)
    const packedUrl = JSON.stringify({
      u: pageUrl ?? null,
      t: pageTitle ?? null,
      r: referrer ?? null,
      v: typeof visits === 'number' ? visits : (parseInt(visits, 10) || 1),
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
