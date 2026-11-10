// What a packaging site itself says about its products — the ONLY source the
// WhatsApp assistant may quote a number from.
//
// The rule (owner): MOQ and "Starting from X per unit" exactly as the lead's
// own site states them, nothing invented. Those figures live on the sites,
// not in this database: each site publishes them in its FAQ (FAQPage JSON-LD,
// "minimum order is 100 boxes, starting from $0.20 per box"), and the newer
// sites also serve a plain /llms.txt summary. The widget bot's hand-written
// `sites.system_prompt` is added too, but it is partial (most entries carry no
// price at all) and can be stale, so the live site comes first.
//
// Fetched server-side, cached per site for 6 hours in-process. A site that
// cannot be read yields whatever the prompt holds — and the assistant's checks
// (lib/wabot.ts) then refuse any figure that is not in this text, so a failed
// fetch can only make it say less, never something wrong.

import { supabase } from './supabase'
import { SITE_DOMAINS } from './sitedomains'

export interface SiteFacts {
  siteId: string
  domain: string | null
  /** Plain text the model reads, ≤ MAX_FACTS characters. */
  text: string
  /** Where it came from, for the dry-run report. */
  sources: string[]
}

const MAX_FACTS = 9000
const TTL_MS = 6 * 60 * 60 * 1000
const cache = new Map<string, { at: number; facts: SiteFacts }>()

const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))

async function get(url: string, ms = 8000): Promise<{ ok: boolean; type: string; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ZeeOpsAssistant/1.0 (+https://chat.zeeops.dev)' },
      signal: AbortSignal.timeout(ms), redirect: 'follow',
    })
    return { ok: res.ok, type: res.headers.get('content-type') ?? '', text: res.ok ? await res.text() : '' }
  } catch {
    return { ok: false, type: '', text: '' }
  }
}

/** FAQ questions and answers out of the page's JSON-LD, one "Q: … A: …" each. */
export function faqFromHtml(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown
    try { data = JSON.parse(m[1]) } catch { continue }
    const walk = (v: unknown) => {
      if (Array.isArray(v)) { v.forEach(walk); return }
      if (!v || typeof v !== 'object') return
      const o = v as Record<string, unknown>
      if (o['@type'] === 'Question' && typeof o.name === 'string') {
        const a = o.acceptedAnswer as Record<string, unknown> | undefined
        const text = typeof a?.text === 'string' ? a.text : ''
        if (text) out.push(`Q: ${decode(o.name).trim()} A: ${decode(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}`)
      }
      for (const k of Object.keys(o)) if (k !== 'acceptedAnswer') walk(o[k])
    }
    walk(data)
  }
  return [...new Set(out)]
}

/** The page's meta description and the visible sentences that carry a fact we care about. */
export function factLinesFromHtml(html: string): string[] {
  const out: string[] = []
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
  if (desc) out.push(decode(desc))
  const body = decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')).replace(/[ \t]+/g, ' ')
  const lines = body.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 12 && l.length < 300)
  const want = /starting from|per (unit|box|cup|sleeve|piece|tray|bag|sheet|sticker|label|mailer)|minimum order|\bMOQ\b|business days|turnaround|free shipping|free design|mockup|materials?|kraft|corrugated|rigid|cardstock|finish|lamination|foil|emboss|printing|CMYK|PMS/i
  for (const l of lines) if (want.test(l)) out.push(l)
  return [...new Set(out)]
}

export async function siteFacts(siteId: string): Promise<SiteFacts> {
  const hit = cache.get(siteId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.facts
  const domain = SITE_DOMAINS[siteId] ?? null
  const parts: string[] = []
  const sources: string[] = []
  if (domain) {
    const [llms, home] = await Promise.all([get(`https://${domain}/llms.txt`), get(`https://${domain}/`)])
    // Some hosts answer a missing llms.txt with their HTML 404 page at 200.
    if (llms.ok && /text\/plain|markdown/i.test(llms.type) && !/<html/i.test(llms.text.slice(0, 500))) {
      parts.push(`FROM ${domain}/llms.txt:\n${llms.text.trim().slice(0, 4000)}`)
      sources.push('llms.txt')
    }
    if (home.ok) {
      const faq = faqFromHtml(home.text)
      if (faq.length) { parts.push(`FROM THE ${domain} HOMEPAGE FAQ:\n${faq.join('\n')}`); sources.push(`faq(${faq.length})`) }
      const lines = factLinesFromHtml(home.text)
      if (lines.length) { parts.push(`FROM THE ${domain} HOMEPAGE TEXT:\n${lines.slice(0, 40).join('\n')}`); sources.push(`page(${lines.length})`) }
    }
  }
  const { data } = await supabase.from('sites').select('system_prompt').eq('site_id', siteId).maybeSingle()
  const prompt = String(data?.system_prompt ?? '').trim()
  if (prompt) { parts.push(`FROM OUR NOTES FOR THIS SITE:\n${prompt.slice(0, 3000)}`); sources.push('system_prompt') }
  const facts: SiteFacts = { siteId, domain, text: parts.join('\n\n').slice(0, MAX_FACTS), sources }
  // Only a successful site read is cached for the full TTL; a failure retries in 10 minutes.
  cache.set(siteId, { at: sources.some((s) => s !== 'system_prompt') ? Date.now() : Date.now() - TTL_MS + 10 * 60 * 1000, facts })
  return facts
}
