// The people a customer copied on their enquiry, so our replies keep them in
// the loop (owner, 2026-10-22: Dylan's Candy Bar's buyer CC'd two colleagues
// and the bot answered her alone). Read from "Cc:" lines in the stored
// enquiry (forwarded headers, or the line the intake adds) and from the Cc of
// every email the customer has sent us. Our own addresses and the customer
// themself are dropped; at most six, in the order first seen.
import { SITE_DOMAINS } from './sitedomains'

const TEAM_DOMAINS = ['shopcardboardboxes.com', 'zeecustomboxes.com', 'zeeops.dev', 'thecosmeticboxes.com']
const OUR_DOMAINS = new Set([...Object.values(SITE_DOMAINS), ...TEAM_DOMAINS].map((d) => d.toLowerCase().replace(/^www\./, '')))
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export function isOurAddress(addr: string): boolean {
  const d = addr.split('@')[1]?.toLowerCase() ?? ''
  return OUR_DOMAINS.has(d) || [...OUR_DOMAINS].some((o) => d.endsWith(`.${o}`))
}

/** "Cc:" header lines (with continuation lines) anywhere in a text. */
export function ccLinesIn(text: string): string[] {
  const out: string[] = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*[>*\s]*cc\s*:\s*(.*)$/i.exec(lines[i])
    if (!m) continue
    let v = m[1]
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*\w[\w-]*\s*:/.test(lines[i + 1])) v += ' ' + lines[++i].trim()
    out.push(v)
  }
  // A forwarded header flattened onto one line ("... To: x Cc: a <b>, c <d> Good Afternoon")
  for (const m of String(text ?? '').matchAll(/\bCc:\s*((?:[^<>\n]*<\s*[^>\s]+@[^>\s]+\s*>\s*,?\s*)+)/gi)) out.push(m[1])
  return out
}

export function customerCc(opts: { customer: string; leadText?: string | null; inboundCc?: (string | null | undefined)[] }): string[] {
  const me = opts.customer.trim().toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  const take = (raw: string) => {
    for (const a of raw.match(EMAIL) ?? []) {
      const e = a.toLowerCase()
      if (e === me || seen.has(e) || isOurAddress(e)) continue
      seen.add(e); out.push(e)
    }
  }
  for (const l of ccLinesIn(opts.leadText ?? '')) take(l)
  for (const c of opts.inboundCc ?? []) if (c) take(c)
  return out.slice(0, 6)
}
