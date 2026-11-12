import { SITE_DOMAINS, siteDomain } from './sitedomains'

// Which Gmail send-as alias belongs to a lead's site.
//
// The old matcher (copied into the composer, the quote bot and the payment-link
// route) squashed the alias domain to letters and looked for the site id or name
// inside it. Twin sites share a name — thepapercups.com and thepapercups.co.uk,
// ordercardboardboxes.com and .co.uk — so "thepapercups" was found inside BOTH
// domains and whichever alias Gmail listed first won: UK customers got mail from
// the .com and US customers from the .co.uk (Saifullah, 2026-11-12).
//
// Now the site's real domain (lib/sitedomains) is matched exactly first. The
// loose match is kept only as a fallback for sites with no listed domain, and it
// never returns an alias whose domain is another listed site's own domain.
type Alias = { email: string }

const OWNED = new Map(Object.entries(SITE_DOMAINS).map(([id, d]) => [d.toLowerCase(), id]))

function aliasDomain(a: Alias): string {
  return (a.email.split('@')[1] ?? '').toLowerCase().trim()
}

export function matchSiteAlias<T extends Alias>(aliases: T[], siteId: string, siteName: string): T | null {
  const site = siteId.toLowerCase()
  const domain = siteDomain(site)?.toLowerCase()
  if (domain) {
    const exact = aliases.find((a) => aliasDomain(a) === domain)
    if (exact) return exact
  }
  const name = siteName.toLowerCase().replace(/[^a-z]/g, '')
  return aliases.find((a) => {
    const d = aliasDomain(a)
    const owner = OWNED.get(d)
    if (owner && owner !== site) return false
    const local = a.email.split('@')[0].toLowerCase()
    const flat = d.replace(/[^a-z]/g, '')
    return flat.includes(site) || (!!name && flat.includes(name)) || local.includes(site)
  }) ?? null
}
