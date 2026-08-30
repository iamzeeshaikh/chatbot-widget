// "Somebody we may not know just contacted us on a phone number."
//
// WhatsApp messages, voicemails and answered inbound calls all have to answer
// the same question — whose lead is this? — and all three had their own copy of
// the answer. Three copies is where the next parser fix lands in two of them,
// which is this project's oldest recurring bug, so it lives here once.
//
// The rule:
//   • match on the LAST NINE DIGITS (lib/identity.ts), never the full string —
//     the same line arrives as "+1 213 449 3746", "213-449-3746" and
//     "2134493746" depending on who typed it;
//   • only within this workspace's sites, because a phone number belongs to one
//     business;
//   • no match means a NEW LEAD, not a dropped message. A stranger phoning
//     about uniforms is a lead, and losing them because there was no row to
//     attach the call to is exactly the silent loss the rest of this codebase
//     keeps having to fix.

import { supabase } from './supabase'
import { phoneKey } from './identity'
import { quoteSessionId, QUOTE_TAG } from './quoteintake'
import { SPORTS_SITES } from './workspaces'

// ── Which SITE did they contact? ────────────────────────────────────────────
// A phone call carries no site. Five websites print the same number, so the
// only thing that could tell them apart is WHICH NUMBER WAS DIALLED — and today
// there is one number, so the honest answer is "we do not know".
//
// This was worse before it was written down: a new caller was filed under the
// first site in the list and the record displayed "Texas Football Uniforms" as
// though it were a fact. A guess presented as data is worse than a blank,
// because nobody goes back and checks it.
//
// TWILIO_SITE_NUMBERS is how that gets fixed for real, without a deploy: buy a
// number per site, point each at the same webhook, and set
//
//   TWILIO_SITE_NUMBERS="texasfootball=+1213…,baseballjerseys=+1424…"
//
// The number Twilio reports in `To` then names the site exactly. Until that
// variable lists a number, an inbound contact is filed on the fallback site and
// SAYS SO on the record, so an agent knows the site still has to be settled.
const INBOUND_SITE = SPORTS_SITES[0] ?? 'texasfootball'

/** The site that owns a given business number, or null if we cannot tell. */
export function siteForCalledNumber(to: string | null | undefined): string | null {
  const dialled = String(to || '').replace(/^whatsapp:/, '').replace(/[^\d+]/g, '')
  if (!dialled) return null
  for (const pair of String(process.env.TWILIO_SITE_NUMBERS || '').split(',')) {
    const [site, number] = pair.split('=').map((v) => v.trim())
    if (!site || !number) continue
    if (!SPORTS_SITES.includes(site)) continue
    // Compared on the last nine digits, like every other phone in this codebase
    // — the same line is written +1 213 449 3746 and 2134493746 by different
    // people, and an env var is typed by a person.
    if (phoneKey(number) && phoneKey(number) === phoneKey(dialled)) return site
  }
  return null
}

export interface InboundLead { sessionId: string; siteId: string; created: boolean }

/**
 * Whose lead is this number — WITHOUT creating one.
 *
 * A ringing phone is not yet a lead: a spam call that rings out and is never
 * answered would otherwise leave a record behind every time. So the ring path
 * only looks, and the paths that mean something actually happened (a voicemail,
 * an answered call, a WhatsApp message) are the ones that create.
 */
export async function findLeadByPhone(phone: string): Promise<{ leadId: string; sessionId: string; siteId: string; name: string } | null> {
  const key = phoneKey(String(phone || '').trim())
  if (!key) return null
  const { data: leads } = await supabase.from('leads')
    .select('id, site_id, phone, name')
    .in('site_id', SPORTS_SITES).not('phone', 'is', null)
    .order('created_at', { ascending: false }).limit(2000)
  const match = (leads ?? []).find((l) => phoneKey(l.phone) === key)
  if (!match) return null
  return { leadId: match.id, sessionId: quoteSessionId(match.id), siteId: match.site_id, name: match.name ?? '' }
}

export async function leadForCaller(
  phone: string,
  newLeadMessage: string,
  extra?: { name?: string; calledNumber?: string },
): Promise<InboundLead | null> {
  const from = String(phone || '').trim()
  if (!from) return null

  const match = await findLeadByPhone(from)
  if (match) return { sessionId: match.sessionId, siteId: match.siteId, created: false }

  const known = siteForCalledNumber(extra?.calledNumber)
  const siteId = known ?? INBOUND_SITE
  // Said on the record rather than left to be discovered. Without this line the
  // lead asserts a site nobody chose.
  const caveat = known ? '' : '\n\nSite not identified — this phone line is shared by all five sites, so it was filed here as a placeholder. Please set the right one.'
  const { data: created } = await supabase.from('leads').insert([{
    site_id: siteId,
    name: extra?.name || null,
    phone: from,
    message: `${QUOTE_TAG}${newLeadMessage}${caveat}`.slice(0, 4000),
  }]).select('id').maybeSingle()
  if (!created?.id) return null
  return { sessionId: quoteSessionId(created.id), siteId, created: true }
}
