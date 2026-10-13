// The signature a CRM email goes out with — one builder for every sender.
//
// Lifted out of /api/leads/[id]/email so the quote bot (lib/quotebot.ts), which
// sends AS an agent, signs exactly the way that agent's own emails sign. Two
// copies of these rules would drift, and a customer would get one signature
// from the agent and a different one from "the agent" an hour later.

import { supabase } from './supabase'
import { loadAgentSignatures, loadSiteContacts, renderSignature, renderSignatureHtml } from './signature'
import { storedMemberNames } from './membername'
import type { Workspace } from './workspaces'

export async function buildSendSignature(opts: {
  memberEmail: string
  workspace: Workspace
  siteId: string
  /** The verified alias the mail goes out from. */
  from: string
  /** Absolute base for the logo URL — the recipient's client fetches it from outside. */
  base: string
}): Promise<{ text: string; html: string }> {
  const [agentSigs, siteContacts, allSites, chatNames] = await Promise.all([
    loadAgentSignatures(), loadSiteContacts(),
    supabase.from('sites').select('site_id, name'), storedMemberNames(),
  ])
  const siteNameOf = new Map((allSites.data ?? []).map((r) => [r.site_id, String(r.name ?? '')]))
  // Same rule as /api/signature, and it must stay the same rule: a chat display
  // name is the person's name for most members and a BRAND for one, so it is
  // used unless it matches a site name. If these two ever disagree, the
  // signature shown in the composer is not the one the customer receives.
  const brandNames = new Set(Array.from(siteNameOf.values()).map((n) => n.toLowerCase()))
  const chatName = chatNames.get(opts.memberEmail.trim().toLowerCase()) ?? ''
  const fallback = {
    // Same rule as /api/signature: sports signs as the site when the agent has
    // no name of their own; a brand-named chat display name never counts.
    name: (brandNames.has(chatName.toLowerCase()) ? '' : chatName)
      || (opts.workspace === 'sports' ? (siteNameOf.get(opts.siteId) ?? '') : ''),
    email: opts.from,
    company: siteNameOf.get(opts.siteId) ?? '',
    logoSrc: `${opts.base}/api/logo/${encodeURIComponent(opts.siteId)}`,
  }
  const mySig = agentSigs.get(opts.memberEmail.toLowerCase()) ?? null
  const mySite = siteContacts.get(opts.siteId)
  return {
    text: renderSignature(mySig, mySite, fallback),
    html: renderSignatureHtml(mySig, mySite, fallback),
  }
}
