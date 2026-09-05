import { PACKAGING_SITES, SPORTS_SITES, type Workspace } from './workspaces'
import { SITE_DOMAINS } from './sitedomains'

// The one-time Gmail history importer (app/api/gmail-import).
//
// A single agent mailbox (e.g. samirkhan@shopcardboardboxes.com) handles the
// mail for the WHOLE portfolio through GSuite send-as aliases — one thread is
// about Shop Cardboard Boxes, the next about The Paper Cups. So a mailbox maps
// to a WORKSPACE, not a site; the site of each individual conversation is
// resolved from the lead it belongs to (leads already exist), and only failing
// that from the alias domain or the subject.

// Agent mailboxes allowed to import, and which workspace their history is.
// A bare @shopcardboardboxes.com / sports address also falls through to the
// right workspace below, so a new agent works without editing this.
const PACKAGING_IMPORT_DOMAINS = ['shopcardboardboxes.com', 'zeecustomboxes.com']
const SPORTS_IMPORT_DOMAINS = ['thebaseballjerseys.com']
const EXPLICIT: Record<string, Workspace> = {
  'shanimazhar82@gmail.com': 'packaging',
}

export function workspaceForImportAddress(address: string): Workspace | null {
  const a = address.trim().toLowerCase()
  if (!a.includes('@')) return null
  if (EXPLICIT[a]) return EXPLICIT[a]
  const domain = a.split('@')[1]
  if (PACKAGING_IMPORT_DOMAINS.includes(domain)) return 'packaging'
  if (SPORTS_IMPORT_DOMAINS.includes(domain)) return 'sports'
  return null
}

// Reverse of SITE_DOMAINS: an alias/link domain → its site id, scoped to the
// workspace so a stray domain can never pull a lead across the two businesses.
export function siteForDomain(domain: string, workspace: Workspace): string | null {
  const d = domain.trim().toLowerCase().replace(/^www\./, '')
  if (!d) return null
  const mine = workspace === 'sports' ? SPORTS_SITES : PACKAGING_SITES
  for (const siteId of mine) {
    const sd = SITE_DOMAINS[siteId]
    if (sd && sd.toLowerCase() === d) return siteId
  }
  return null
}
