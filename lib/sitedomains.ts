// Which website each site_id actually IS.
//
// The bot is told this in its system prompt so it can never name the wrong
// company or invent a domain — an 8B model asked "what site is this?" will
// happily make one up, and a visitor reading a fabricated URL in our own chat
// widget is the worst possible answer.
//
// There is no `domain` column and no DDL access (CLAUDE.md §3), so the mapping
// lives here in code. Every entry below was verified on 2026-08-20 by loading
// the live site: the packaging domains match the production Apps Script's
// SITE_DOMAINS (which resolves quote-form "Page URL:" hosts to these same
// sites), and each sports domain was confirmed by reading the `siteId=` its own
// widget tag declares.
//
// An unlisted site is not an error: siteDomain() returns null and the prompt
// simply names the company without a URL. Never guess an entry — a wrong domain
// is worse than none.
export const SITE_DOMAINS: Record<string, string> = {
  // Packaging workspace
  shopcardboardboxes: 'shopcardboardboxes.com',
  thetubepackaging: 'thetubepackaging.com',
  smallfoodboxes: 'smallfoodboxes.com',
  kraftboxpack: 'kraftboxpack.com',
  theburgerboxes: 'theburgerboxes.com',
  zeecustomboxes: 'zeecustomboxes.com',
  thecandlepackaging: 'thecandlepackaging.com',
  thepapercups: 'thepapercups.com',
  peptidesboxes: 'peptidesboxes.com',
  thecoffeesleeves: 'thecoffeesleeves.com',
  thewaxpapers: 'thewaxpapers.co',
  thecustomstickers: 'thecustomstickers.co',
  zeepack: 'zeepack.co',
  thecerealboxes: 'thecerealboxes.com',
  hotdogtrays: 'hotdogtrays.com',
  theburgersleeves: 'theburgersleeves.com',
  thecandlesleeves: 'thecandlesleeves.com',
  cardboardcups: 'cardboardcups.com',
  shopbubblemailers: 'shopbubblemailers.com',
  insertshub: 'insertshub.com',
  thediecutstickers: 'thediecutstickers.com',
  customperfumeboxes: 'customperfumeboxes.com',
  shopdisplayboxes: 'shopdisplayboxes.com',
  lipboxes: 'lipboxes.com',
  thepolymailers: 'thepolymailers.com',
  theretailpackaging: 'theretailpackaging.com',
  thefoodtrays: 'thefoodtrays.com',
  // Sports workspace
  texasfootball: 'texasfootballuniforms.com',
  volleyballuniforms: 'thevolleyballuniforms.com',
  californiasoccer: 'californiasoccerjerseys.com',
  baseballjerseys: 'thebaseballjerseys.com',
  floridabasketball: 'floridabasketballjerseys.com',
}

export function siteDomain(siteId: string): string | null {
  return SITE_DOMAINS[siteId] ?? null
}

// The identity paragraph pinned to the TOP of every bot system prompt. It is
// deliberately about who the bot is and what it must not invent — the site's own
// row supplies the product knowledge underneath it.
export function siteIdentityPrompt(siteId: string, siteName: string): string {
  const domain = siteDomain(siteId)
  const name = (siteName || '').trim() || siteId
  return [
    `— WHO YOU ARE —`,
    domain
      ? `You are the live chat assistant for ${name}, the company behind the website ${domain}. The visitor is already on ${domain} right now.`
      : `You are the live chat assistant for ${name}. The visitor is already on that company's website right now.`,
    `Always call the company "${name}". Never call it anything else, never mention or recommend another company or supplier, and never state a website address, email address or phone number that is not written below. If you are asked for a contact detail that is not below, say a specialist will confirm it.`,
    ``,
  ].join('\n')
}
