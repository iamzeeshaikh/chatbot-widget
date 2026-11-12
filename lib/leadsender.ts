import { getAssignment } from './assignment'
import { connectionFor, verifiedAliases, type GoogleConfig } from './gmail'
import { matchSiteAlias } from './sitealias'

// Which mailbox a bot email on a lead leaves from.
//
// A draft or follow-up remembers the agent the bot picked when it FIRST wrote
// to the customer. When a lead is handed to someone else afterwards, that
// stored agent is stale: Saifullah moved leads to the new agent and the drafts
// the new agent sent still went out from Saifullah's mailbox (2026-11-12).
// The lead's current assignee wins whenever their Gmail is connected and has an
// alias on this site's domain; otherwise the stored sender stands, because a
// guessed mailbox is worse than the one the thread already uses.
export interface LeadSender {
  agent: string
  from: string
  /** True when the mailbox changed, so a Gmail threadId from the old one is useless. */
  moved: boolean
}

export async function currentSender(leadId: string, siteId: string, agent: string, from: string, cfg: GoogleConfig): Promise<LeadSender> {
  const owner = (await getAssignment(leadId))?.toLowerCase()
  if (!owner || owner === agent.toLowerCase()) return { agent, from, moved: false }
  try {
    const conn = await connectionFor(owner)
    if (!conn || conn.revoked) return { agent, from, moved: false }
    const alias = matchSiteAlias(await verifiedAliases(owner, cfg), siteId, '')
    if (!alias) return { agent, from, moved: false }
    return { agent: owner, from: alias.email, moved: true }
  } catch {
    return { agent, from, moved: false }
  }
}
