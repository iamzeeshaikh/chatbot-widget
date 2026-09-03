// Email signatures — who the agent is, and which business they are writing for.
//
// SPLIT IN TWO ON PURPOSE. A signature is half a PERSON and half a COMPANY:
//
//   Steve Hayes                    ← the person: same on every site
//   Sales Executive · Kraft Box Pack
//   P: +1 503 461 4788             ← the company: same for every agent
//   E: steve@…
//   kraftboxpack.com
//   1234 Example St, Portland, OR
//
// Storing it as one row per (agent × site) would mean typing the same office
// address once per agent and getting it subtly different each time — and there
// are more than twenty sites. So the person is stored once per member, the
// company once per site, and they are merged when the signature is rendered.
// Correcting an address is then one edit, not twenty.
//
// NO DDL (CLAUDE.md §3): both live as chat_logs control rows on the reserved
// `zeeops-crm` site, the same trick reminders and prefs use, so they can never
// surface in a conversation list or a transcript. Newest row wins on read;
// older rows stay as the audit trail.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'

export const CRM_SIGNATURE_ROLE = 'crm_signature'
export const CRM_SITE_CONTACT_ROLE = 'crm_site_contact'

/** One session id per kind, both on the reserved site. */
export const SIGNATURE_SESSION = 'zeeops-crm-signatures'
export const SITE_CONTACT_SESSION = 'zeeops-crm-site-contacts'

/** The person. One per member, shared across every site they work. */
export interface AgentSignature {
  email: string
  /** How they want to be named — not the login, which is often an alias. */
  name: string
  /** "Sales Executive". Blank is allowed; the line is then dropped. */
  title: string
  /** Their own direct line, if they have one. Falls back to the site's. */
  phone: string
}

/** The business. One per site, shared across every agent. */
export interface SiteContact {
  siteId: string
  company: string
  phone: string
  website: string
  /** The office address. NEVER invent one — an empty address prints nothing,
   *  and a made-up address on outgoing mail is the kind of thing that costs a
   *  Merchant Center account. */
  address: string
}

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

export function parseAgentSignature(message: string | null | undefined): AgentSignature | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    const email = str(o?.email).toLowerCase()
    if (!email) return null
    return { email, name: str(o.name, 120), title: str(o.title, 120), phone: str(o.phone, 40) }
  } catch { return null }
}

export function parseSiteContact(message: string | null | undefined): SiteContact | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    const siteId = str(o?.siteId, 80)
    if (!siteId) return null
    return {
      siteId,
      company: str(o.company, 160),
      phone: str(o.phone, 40),
      website: str(o.website, 160),
      address: str(o.address, 300),
    }
  } catch { return null }
}

/** Every agent signature on record, newest row per email winning. */
export async function loadAgentSignatures(): Promise<Map<string, AgentSignature>> {
  const { data } = await supabase.from('chat_logs')
    .select('message, created_at')
    .eq('site_id', REMINDER_SITE).eq('session_id', SIGNATURE_SESSION).eq('role', CRM_SIGNATURE_ROLE)
    .order('created_at', { ascending: true }).limit(2000)
  const out = new Map<string, AgentSignature>()
  for (const r of data ?? []) {
    const s = parseAgentSignature(r.message)
    if (s) out.set(s.email, s)
  }
  return out
}

export async function loadSiteContacts(): Promise<Map<string, SiteContact>> {
  const { data } = await supabase.from('chat_logs')
    .select('message, created_at')
    .eq('site_id', REMINDER_SITE).eq('session_id', SITE_CONTACT_SESSION).eq('role', CRM_SITE_CONTACT_ROLE)
    .order('created_at', { ascending: true }).limit(2000)
  const out = new Map<string, SiteContact>()
  for (const r of data ?? []) {
    const c = parseSiteContact(r.message)
    if (c) out.set(c.siteId, c)
  }
  return out
}

/**
 * The signature as it will appear at the bottom of an email.
 *
 * Every line is dropped when its value is missing, so a half-filled record
 * produces a shorter signature rather than a line reading "P:" with nothing
 * after it. `--` is the conventional separator, and it is what mail clients
 * (including Gmail) use to fold a signature out of a quoted reply — without it
 * every reply in a long thread stacks another copy of it into the quote.
 */
export function renderSignature(
  agent: AgentSignature | null | undefined,
  site: SiteContact | null | undefined,
  fallback: { name?: string; email?: string; company?: string } = {},
): string {
  const name = agent?.name || fallback.name || ''
  const company = site?.company || fallback.company || ''
  const lines: string[] = []

  if (name) lines.push(name)
  const role = [agent?.title, company].filter(Boolean).join(' · ')
  if (role) lines.push(role)

  const phone = agent?.phone || site?.phone || ''
  if (phone) lines.push(`P: ${phone}`)
  if (fallback.email) lines.push(`E: ${fallback.email}`)
  if (site?.website) lines.push(site.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))
  if (site?.address) lines.push(site.address)

  if (lines.length === 0) return ''
  return `--\n${lines.join('\n')}`
}
