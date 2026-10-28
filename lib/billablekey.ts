// Who counts as ONE billable customer. Same site + same email always did; since
// 2026-10-28 (owner) two people at the same company on the same site are one
// customer too — Centigrade Logistics, Figmints, Fedpoint and Dylan's Candy Bar
// each showed up as two. Free mail domains never merge: two gmail.com addresses
// are two people. Client-safe; the billing API and the Billing page share it.

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com', 'qq.com', '163.com', 'btinternet.com',
  'sky.com', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net', 'rocketmail.com', 'live.co.uk', 'outlook.co.uk',
])

export function billableKey(siteId: string, email: string | null | undefined, sessionId: string): string {
  const e = String(email ?? '').split(',')[0].trim().toLowerCase()
  if (!e || !e.includes('@')) return `manual::${sessionId}`
  const domain = e.split('@')[1]
  return FREE_MAIL.has(domain) ? `${siteId}::${e}` : `${siteId}::@${domain}`
}
