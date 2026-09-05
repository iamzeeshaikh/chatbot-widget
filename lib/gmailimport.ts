// Which SITE a Gmail mailbox's history belongs to, for the one-time importer
// (app/api/gmail-import). A mailbox maps to exactly one site: that is the
// fallback for any conversation whose customer has no lead yet, and the scope a
// matched lead must stay inside.
//
// Keyed by the importing address (lower-case). Add a row before pointing the
// Apps Script at a new mailbox — an unmapped address is refused, on purpose, so
// history is never filed on a guessed site.
export const IMPORT_ADDRESS_SITES: Record<string, string> = {
  'stevehayes@shopcardboardboxes.com': 'shopcardboardboxes',
  'samirkhan@shopcardboardboxes.com': 'shopcardboardboxes',
  'dannydiaz@shopcardboardboxes.com': 'shopcardboardboxes',
  'jenniferwright@shopcardboardboxes.com': 'shopcardboardboxes',
  'marktaylor@shopcardboardboxes.com': 'shopcardboardboxes',
  'kabirjoshi@shopcardboardboxes.com': 'shopcardboardboxes',
}

export function siteIdForImportAddress(address: string): string | null {
  return IMPORT_ADDRESS_SITES[address.trim().toLowerCase()] ?? null
}
