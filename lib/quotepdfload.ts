// Server half of the quotation PDF: fetches the site's logo (the same stored
// URL /api/logo proxies and the invoice PDF uses) and the Karachi date.
import { buildQuotePdf, quoteFileName } from './quotepdf'
import { loadSiteContacts } from './signature'
import { pktDayKey } from './datetime'
import type { PriceQuote } from './pricequote'

export async function quotePdfFor(o: { siteId: string; siteName: string; customerName: string; customerEmail: string; quote: PriceQuote }): Promise<{ bytes: Uint8Array; name: string }> {
  let logo: Uint8Array | null = null
  const url = (await loadSiteContacts()).get(o.siteId)?.logo ?? ''
  if (/^https:\/\//i.test(url)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'ZeeOps-Quote/1.0' }, signal: AbortSignal.timeout(8000) })
      if (r.ok) logo = new Uint8Array(await r.arrayBuffer())
    } catch { logo = null }
  }
  const bytes = await buildQuotePdf(o.quote, { logo, siteName: o.siteName, customerName: o.customerName, customerEmail: o.customerEmail, dayKey: pktDayKey(new Date()) })
  return { bytes, name: quoteFileName(o.customerName, o.siteName) }
}
