// Who is on the other end of a WhatsApp lead, in the terms a message to them
// needs: their first name, which of our sites they came from, which line they
// talk on (US or UK), and whose lead it is.
//
// Shared by the template sender (lib/watemplates.ts) and the WhatsApp
// assistant (lib/wabot.ts) so the two can never introduce the company
// differently to the same customer.
//
// THE SITE IS OFTEN A PLACEHOLDER. One WhatsApp number serves every packaging
// site, so a lead whose first message did not carry its site's domain was filed
// on the workspace's first site with a "Site not identified" caveat
// (lib/inbound.ts). Real threads show the site is usually still in the text —
// every site's WhatsApp button prefills "Hi <Site Name>! I need more info about
// …" — so the thread is read for a domain or that greeting before giving up.
// When it still cannot be told, `siteKnown` is false and nothing site-specific
// (prices, minimums) may be said.

import { supabase } from './supabase'
import { SITE_DOMAINS } from './sitedomains'
import { PACKAGING_SITES } from './workspaces'
import { CRM_FIELD_ROLE, CRM_WA_IN_ROLE } from './crm'
import { ASSIGNMENT_ROLE } from './assignment'
import { lineForLead, isUkSite, type WaLine } from './metawa'
import { parseWaMessage } from './whatsapp'
import { resolveLeadSite } from './leadrecord'

export interface WaLeadContext {
  sessionId: string
  /** The lead's own site_id (may be the placeholder). */
  leadSiteId: string
  /** The site the customer actually contacted, or null when it cannot be told. */
  siteId: string | null
  siteName: string
  siteDomain: string | null
  siteKnown: boolean
  line: WaLine
  /** UK customer: the UK line or a .co.uk site — British spelling, £. */
  uk: boolean
  firstName: string | null
  assignee: string | null
}

const PLACEHOLDER_RE = /Site not identified|Site is a BEST GUESS/i

/** The verified WhatsApp display names of the two lines — what the customer
 *  already sees at the top of the chat, so the safe name when no site is known. */
export function lineBrand(line: WaLine): string {
  return line === 'meta' ? 'ZEE Pack UK' : 'ZEE Pack'
}

let siteNames: { at: number; map: Map<string, string> } | null = null
export async function packagingSiteNames(): Promise<Map<string, string>> {
  if (siteNames && Date.now() - siteNames.at < 10 * 60 * 1000) return siteNames.map
  const { data } = await supabase.from('sites').select('site_id, name').in('site_id', PACKAGING_SITES)
  const map = new Map<string, string>((data ?? []).map((s) => [String(s.site_id), String(s.name ?? s.site_id)]))
  siteNames = { at: Date.now(), map }
  return map
}

/** A site the customer's own words name: a domain first, then the prefilled
 *  "Hi <Site Name>!" / "Hi <Site Name> team" greeting. Ambiguity names nothing. */
export function siteFromThreadText(text: string, names: Map<string, string>, preferUk: boolean): string | null {
  const hay = text.toLowerCase()
  const byDomain = PACKAGING_SITES.filter((id) => SITE_DOMAINS[id] && hay.includes(SITE_DOMAINS[id].toLowerCase()))
  if (byDomain.length === 1) return byDomain[0]
  // Longest domain wins over a shorter one it contains (thepapercups.co.uk vs thepapercups.com does not
  // collide, but zeepack.co is inside zeepack.com-like strings).
  if (byDomain.length > 1) return byDomain.sort((a, b) => SITE_DOMAINS[b].length - SITE_DOMAINS[a].length)[0]
  const greet = [...text.matchAll(/\bHi,?\s+(?:the\s+)?([A-Z][\w&' ]{2,40}?)(?:\s+team)?\s*[!,.]/gi)].map((m) => m[1].trim().toLowerCase())
  if (!greet.length) return null
  const hits = PACKAGING_SITES.filter((id) => {
    const n = (names.get(id) ?? '').toLowerCase().replace(/^the\s+/, '')
    return n.length > 3 && greet.some((g) => g.replace(/^the\s+/, '') === n)
  })
  if (hits.length === 1) return hits[0]
  // Two sites share a display name (US + UK twins): the line decides.
  if (hits.length > 1) return hits.find((id) => isUkSite(id) === preferUk) ?? null
  return null
}

/** First name a stranger can be greeted by, or null (a company, a handle, unsure). */
export function greetableFirstName(raw: string | null | undefined): string | null {
  const first = String(raw ?? '').trim().split(/\s+/)[0] ?? ''
  if (!/^[A-Za-zÀ-ÿ'-]{2,20}$/.test(first)) return null
  if (/^(info|sales|admin|contact|hello|team|office|support|customer|the|mr|mrs|ms|dr|packaging|package|boxes?|print(ing)?|design|shop|store|company|business|official)$/i.test(first)) return null
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
}

export async function waLeadContext(sessionId: string): Promise<WaLeadContext | null> {
  const resolved = await resolveLeadSite(sessionId)
  if (!resolved) return null
  const leadSiteId = resolved.siteId
  const [rowsRes, names, line] = await Promise.all([
    supabase.from('chat_logs').select('role, message')
      .eq('session_id', sessionId).in('role', [CRM_WA_IN_ROLE, CRM_FIELD_ROLE, ASSIGNMENT_ROLE])
      .order('created_at', { ascending: true }).limit(300),
    packagingSiteNames(),
    lineForLead(sessionId, leadSiteId),
  ])
  const rows = rowsRes.data ?? []
  let name = resolved.lead?.name ?? ''
  let assignee: string | null = null
  const inbound: string[] = []
  for (const r of rows) {
    if (r.role === CRM_FIELD_ROLE) {
      try { const o = JSON.parse(r.message ?? ''); if (o?.field === 'name') name = String(o.value ?? '') } catch { /* skip */ }
    } else if (r.role === ASSIGNMENT_ROLE) {
      assignee = String(r.message ?? '').trim().toLowerCase() || null
    } else {
      const w = parseWaMessage(r.message)
      if (w?.body) inbound.push(w.body)
    }
  }
  const uk = line === 'meta' || isUkSite(leadSiteId)
  const placeholder = PLACEHOLDER_RE.test(resolved.lead?.message ?? '')
  let siteId: string | null = placeholder ? null : leadSiteId
  // Even a "known" site is re-read from the thread: a returning customer whose
  // phone matched an old lead on another site is writing about THIS one.
  const named = siteFromThreadText(inbound.join('\n'), names, uk)
  if (named) siteId = named
  if (siteId && !PACKAGING_SITES.includes(siteId)) siteId = null
  return {
    sessionId, leadSiteId, siteId,
    siteName: siteId ? (names.get(siteId) ?? siteId) : lineBrand(line),
    siteDomain: siteId ? (SITE_DOMAINS[siteId] ?? null) : null,
    siteKnown: !!siteId,
    line, uk: siteId ? (isUkSite(siteId) || line === 'meta') : uk,
    firstName: greetableFirstName(name),
    assignee,
  }
}
