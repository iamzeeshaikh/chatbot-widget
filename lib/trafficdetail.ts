// One site, one point on the Overview chart: where the visits came from.
//
// The "Traffic by site" modal says The Candle Packaging had 887 visits on a
// day; the next question is always which countries, which pages and which
// sources. This folds that site's visitor rows into small counted lists ON THE
// SERVER, so the browser receives a few dozen numbers instead of thousands of
// raw rows (which also carry IPs it has no business holding).
//
// Visits are counted on exactly the rows the chart counts — the caller passes
// the same bot-burst set tally() uses — so the drill-down's total is the
// row's Visits figure, not a near miss.

import { unpackVisitor } from './visitor'
import { burstKey } from './botfilter'
import { toPktMs } from './analytics'

export interface DetailRow {
  created_at: string
  user_agent: string | null
  session_id: string
  page_url: string | null
  country: string | null
  device_type: string | null
}

export interface Count { key: string; label: string; visits: number; picked: number }

export interface SiteTrafficDetail {
  visits: number
  unique: number
  picked: number
  notPicked: number
  newVisitors: number
  returning: number
  /** Rows from Google's own crawler addresses — counted in Visits like the
   *  chart counts them, shown here so nobody mistakes them for customers. */
  crawler: number
  countries: Count[]
  sources: Count[]
  landingPages: Count[]
  pagesViewed: Count[]
  devices: Count[]
}

const TOP = 15

function hostOf(u: string | null | undefined): string {
  if (!u) return ''
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

function pathOf(u: string | null | undefined): string {
  if (!u) return '(unknown)'
  try {
    const url = new URL(u)
    return decodeURIComponent(url.pathname) || '/'
  } catch { return u.slice(0, 120) }
}

/**
 * Where a visit came from, in the words people use: Google, Google Ads,
 * Bing, ChatGPT, Facebook, Direct, or the referring site's domain.
 * Paid clicks are told apart by the click id or utm tag on the LANDING url —
 * the referrer of an ad click is plain google.com.
 */
export function sourceOf(referrer: string | null | undefined, landing: string | null | undefined, ownHost: string): string {
  const land = landing || ''
  if (/[?&](gclid|gbraid|wbraid)=/i.test(land) || /[?&]utm_medium=(cpc|ppc|paid)/i.test(land)) {
    return /bing|msclkid/i.test(land) ? 'Bing Ads' : 'Google Ads'
  }
  if (/[?&]msclkid=/i.test(land)) return 'Bing Ads'
  if (/[?&]fbclid=/i.test(land)) return 'Facebook'
  const utm = land.match(/[?&]utm_source=([^&#]+)/i)
  const h = hostOf(referrer)
  if (!h) {
    if (utm) return decodeURIComponent(utm[1]).toLowerCase()
    return 'Direct / unknown'
  }
  if (ownHost && (h === ownHost || h.endsWith(`.${ownHost}`))) return 'Within the site'
  if (/(^|\.)google\./.test(h)) return 'Google'
  if (/(^|\.)bing\.com$/.test(h)) return 'Bing'
  if (/(^|\.)(duckduckgo\.com|yahoo\.com|search\.yahoo\.com|yandex\.|ecosia\.org|brave\.com)/.test(h)) return 'Other search'
  if (/chatgpt\.com|openai\.com/.test(h)) return 'ChatGPT'
  if (/perplexity\.ai|gemini\.google|copilot\.microsoft|claude\.ai/.test(h)) return 'AI assistant'
  if (/facebook\.com|fb\.com|instagram\.com|messenger\.com/.test(h)) return 'Facebook / Instagram'
  if (/t\.co$|twitter\.com|x\.com|linkedin\.com|lnkd\.in|pinterest\.|reddit\.com|tiktok\.com|youtube\.com/.test(h)) return 'Social'
  return h
}

const CRAWLER_IP = /^66\.249\./

export function siteTrafficDetail(
  rows: DetailRow[],
  agentSessions: Set<string>,
  bursts: Set<string>,
  ownHost: string,
): SiteTrafficDetail {
  const tallies = {
    countries: new Map<string, Count>(),
    sources: new Map<string, Count>(),
    landingPages: new Map<string, Count>(),
    pagesViewed: new Map<string, Count>(),
    devices: new Map<string, Count>(),
  }
  const add = (m: Map<string, Count>, key: string, picked: boolean, label = key) => {
    const c = m.get(key) ?? { key, label, visits: 0, picked: 0 }
    c.visits++
    if (picked) c.picked++
    m.set(key, c)
  }
  const unique = new Set<string>()
  const counted = new Set<string>()
  let visits = 0, picked = 0, notPicked = 0, newVisitors = 0, returning = 0, crawler = 0

  for (const r of rows) {
    if (bursts.has(burstKey(r.user_agent, toPktMs(r.created_at)))) continue
    visits++
    const v = unpackVisitor(r.page_url)
    const isPicked = agentSessions.has(r.session_id)
    if (!counted.has(r.session_id)) {
      counted.add(r.session_id)
      if (isPicked) picked++; else notPicked++
    }
    unique.add(v.vid || v.ip || r.session_id)
    if (v.visits > 1) returning++; else newVisitors++
    if ((v.ip && CRAWLER_IP.test(v.ip)) || /googlebot|bingbot|crawler|spider/i.test(r.user_agent ?? '')) crawler++

    add(tallies.countries, r.country || 'Unknown', isPicked)
    const landing = v.history[0]?.u ?? v.page_url
    add(tallies.sources, sourceOf(v.referrer, landing, ownHost), isPicked)
    add(tallies.landingPages, pathOf(landing), isPicked)
    const seen = new Set<string>()
    for (const p of [...v.history.map((h) => h.u), v.page_url]) {
      const path = pathOf(p)
      if (!p || seen.has(path)) continue
      seen.add(path)
      add(tallies.pagesViewed, path, isPicked)
    }
    add(tallies.devices, r.device_type || 'Unknown', isPicked)
  }

  const top = (m: Map<string, Count>) => {
    const all = [...m.values()].sort((a, b) => b.visits - a.visits || a.label.localeCompare(b.label))
    if (all.length <= TOP) return all
    const rest = all.slice(TOP - 1)
    return [...all.slice(0, TOP - 1), {
      key: '__other', label: `${rest.length} more`,
      visits: rest.reduce((a, c) => a + c.visits, 0), picked: rest.reduce((a, c) => a + c.picked, 0),
    }]
  }
  return {
    visits, unique: unique.size, picked, notPicked, newVisitors, returning, crawler,
    countries: top(tallies.countries),
    sources: top(tallies.sources),
    landingPages: top(tallies.landingPages),
    pagesViewed: top(tallies.pagesViewed),
    devices: top(tallies.devices),
  }
}
