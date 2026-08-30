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

/** The number is the sports business's, so an inbound contact is a sports lead.
 *  A new one lands on the first site and an agent moves it if it belongs
 *  elsewhere — a wrong site is harder to notice than an unset one. */
const INBOUND_SITE = SPORTS_SITES[0] ?? 'texasfootball'

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
  extra?: { name?: string },
): Promise<InboundLead | null> {
  const from = String(phone || '').trim()
  if (!from) return null

  const match = await findLeadByPhone(from)
  if (match) return { sessionId: match.sessionId, siteId: match.siteId, created: false }

  const { data: created } = await supabase.from('leads').insert([{
    site_id: INBOUND_SITE,
    name: extra?.name || null,
    phone: from,
    message: `${QUOTE_TAG}${newLeadMessage}`.slice(0, 4000),
  }]).select('id').maybeSingle()
  if (!created?.id) return null
  return { sessionId: quoteSessionId(created.id), siteId: INBOUND_SITE, created: true }
}
