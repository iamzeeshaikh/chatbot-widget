// Server-side IP → country lookup via ipapi, used to geo-gate the widget.
// Returns the ISO country code (e.g. "PK") plus the human-readable name. On any
// failure — private IP, timeout, rate limit, bad response — both come back empty
// so callers can safely "default to allow / don't block on uncertainty".

export interface GeoResult {
  code: string // ISO 3166-1 alpha-2, uppercased (e.g. "PK"), or '' if unknown
  name: string // e.g. "Pakistan", or '' if unknown
}

const EMPTY: GeoResult = { code: '', name: '' }

// Extract the client IP from common proxy headers (Vercel sets x-forwarded-for).
export function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for') ?? ''
  return fwd.split(',')[0].trim() || (headers.get('x-real-ip') ?? '').trim()
}

// The visitor's ISO country code from the platform edge header. Vercel sets
// `x-vercel-ip-country` on every request based on the real connecting IP — it's
// instant, free, reliable and cannot be spoofed by the client. This is the
// PRIMARY source for the geo-block (ipapi is only a dev/local fallback, and it
// was getting rate-limited in production, which is why the block was failing).
export function countryCodeFromHeaders(headers: Headers): string {
  return (headers.get('x-vercel-ip-country') ?? '').trim().toUpperCase()
}

// Resolve the country code, preferring the reliable edge header and falling back
// to ipapi only when it's absent (e.g. local dev).
export async function resolveCountryCode(headers: Headers): Promise<string> {
  const fromHeader = countryCodeFromHeaders(headers)
  if (fromHeader) return fromHeader
  return (await lookupCountry(clientIp(headers))).code
}

function isPrivateIp(ip: string): boolean {
  return (
    !ip ||
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd')
  )
}

export async function lookupCountry(ip: string): Promise<GeoResult> {
  if (isPrivateIp(ip)) return EMPTY
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`, {
      headers: { 'User-Agent': 'chatbot-widget/1.0' },
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return EMPTY
    const data = await res.json()
    if (data?.error) return EMPTY
    return {
      code: typeof data.country_code === 'string' ? data.country_code.toUpperCase() : '',
      name: typeof data.country_name === 'string' ? data.country_name : '',
    }
  } catch {
    return EMPTY
  }
}
