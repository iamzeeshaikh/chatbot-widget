// "Somebody on THIS site is about to phone us."
//
// THE PROBLEM: one phone number serves every site, so an inbound call carries
// no clue about which business the caller was looking at. The phone network
// cannot help — the call knows only which number was dialled. The website can:
// at the moment a visitor taps the number, we know exactly which site they are
// on. If a call arrives seconds later, it is almost certainly that person.
//
// THIS IS A GUESS AND IS LABELLED AS ONE. It is right when one person tapped
// and then rang; it is ambiguous when two people on different sites tapped
// inside the same few minutes. In that case NOTHING is asserted — the record
// lists the candidates and says it could not tell, which is the honest answer
// and the one that does not send an agent into the wrong conversation.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'
import type { Workspace } from './workspaces'
import { SPORTS_SITES, PACKAGING_SITES } from './workspaces'

export const CALL_INTENT_ROLE = 'call_intent'
export const CALL_INTENT_SESSION = 'zeeops-call-intent'

/** How long a tap stays relevant. Long enough for someone to pick up a phone
 *  and dial, short enough that yesterday's tap never explains today's call. */
export const INTENT_WINDOW_MS = 10 * 60 * 1000

export interface CallIntent { siteId: string; at: string; page?: string }

export async function recordCallIntent(siteId: string, page?: string): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE, session_id: CALL_INTENT_SESSION, role: CALL_INTENT_ROLE,
    message: JSON.stringify({ siteId, at: new Date().toISOString(), page: page?.slice(0, 300) }),
  })
}

/**
 * Which site, if any, this call most likely came from.
 *
 * `sure` is false whenever more than one site was tapped inside the window —
 * the caller could be either, and saying so is the point.
 */
export async function siteFromRecentTap(
  workspace: Workspace,
): Promise<{ siteId: string | null; sure: boolean; candidates: string[] }> {
  const since = new Date(Date.now() - INTENT_WINDOW_MS).toISOString()
  const { data } = await supabase.from('chat_logs')
    .select('message, created_at')
    .eq('site_id', REMINDER_SITE).eq('session_id', CALL_INTENT_SESSION).eq('role', CALL_INTENT_ROLE)
    .gte('created_at', since)
    .order('created_at', { ascending: false }).limit(50)

  const mine = workspace === 'sports' ? SPORTS_SITES : PACKAGING_SITES
  const seen: string[] = []
  for (const r of data ?? []) {
    try {
      const o = JSON.parse(r.message ?? '') as CallIntent
      // A packaging caller must never be attributed to a sports site: the two
      // share a Twilio account but not a customer list.
      if (o?.siteId && mine.includes(o.siteId) && !seen.includes(o.siteId)) seen.push(o.siteId)
    } catch { /* malformed row */ }
  }
  if (seen.length === 0) return { siteId: null, sure: false, candidates: [] }
  // Newest first, so a single tap wins outright and the most recent leads.
  return { siteId: seen[0], sure: seen.length === 1, candidates: seen }
}
