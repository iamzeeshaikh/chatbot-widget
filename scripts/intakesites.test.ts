// Every packaging site must be placeable by the quote intake: a code on the
// server (QUOTE_SITE_CODES) and the same code + domain in the Apps Script's
// SITE_DOMAINS. Eleven sites launched 19-22 Oct 2026 were in neither, and
// their forms never reached ZeeOps. Run: npm run test:intakesites
import fs from 'node:fs'; import vm from 'node:vm'
import { PACKAGING_SITES, isRetiredLeadSite } from '../lib/workspaces.ts'
import { SITE_DOMAINS } from '../lib/sitedomains.ts'
import { QUOTE_SITE_CODES } from '../lib/quoteintake.ts'
const src = fs.readFileSync('scripts/quote-intake-apps-script.gs', 'utf8')
const ctx: Record<string, unknown> = { Session: {}, Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) }, Utilities: {} }
vm.createContext(ctx); vm.runInContext(src + '\n;this.__D = SITE_DOMAINS;', ctx)
const gs = new Map(Object.entries(ctx.__D as Record<string, string>).map(([c, d]) => [d.toLowerCase(), c]))
const server = new Map(Object.entries(QUOTE_SITE_CODES).map(([c, s]) => [s, c]))
const bad: string[] = []
for (const site of PACKAGING_SITES) {
  if (isRetiredLeadSite(site)) continue
  const dom = SITE_DOMAINS[site]
  const a = dom ? gs.get(dom.toLowerCase()) : undefined, b = server.get(site)
  if (!dom || !a || !b || a !== b) bad.push(`${site} (${dom ?? 'no domain'}): script ${a ?? 'MISSING'}, server ${b ?? 'MISSING'}`)
}
if (bad.length) { console.error('Sites the intake cannot place:\n  ' + bad.join('\n  ')); process.exit(1) }
console.log(`intake sites: all ${PACKAGING_SITES.length} packaging sites placeable`)
