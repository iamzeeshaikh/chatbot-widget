// The payment link, and who is allowed to read it.
//
// ── The problem this exists for ──────────────────────────────────────────────
// The sports workspace hides customer contacts from its agents (lib/pii.ts),
// and that held everywhere in ZeeOps — and then leaked completely outside it.
// The owner raises the invoice in PayPal, which REQUIRES the customer's email
// address; PayPal mails back a link; the owner passes that link to the agent to
// forward on. The agent opens the link to check it, and PayPal's own page shows
// them the address ZeeOps spent all that effort hiding. Masking every field in
// our product is worth nothing if the last step hands the whole thing over.
//
// ── The rule ─────────────────────────────────────────────────────────────────
// The link is treated as PII in its own right. A member who may not see the
// customer's address may not see the link either — not in a field, not in an
// href, not in the page source, and not in any API response. The URL is stored
// here, read back only for an admin, and otherwise exists on the server alone.
//
// What the agent gets instead is a button. Pressing it makes the SERVER resolve
// the real link and the real recipient and send the mail. The agent moves the
// sale forward and never learns either value — which is the whole point, and is
// also why "just hide the field in the UI" would not have done: the answer has
// to be that the browser is never told.
//
// No DDL, so this is a chat_logs control row like everything else, newest-wins,
// append-only. Two kinds share the role: the link itself, and a record of each
// time it was sent.

import { supabase } from './supabase'
import { canSeeContacts } from './pii'
import type { Member } from './auth'

export const PAY_LINK_ROLE = 'crm_pay_link'

/** Six dots. Deliberately not a truncated URL — a prefix is still a leak. */
export const HIDDEN_LINK = '••••••'

export type PayChannel = 'email' | 'whatsapp'

export interface PayLinkRow {
  kind: 'link' | 'sent'
  /** Only on 'link'. */
  url?: string
  /** Only on 'sent'. Absent on rows written before WhatsApp was an option. */
  channel?: PayChannel
  by: string
  at: string
}

/**
 * How this customer can be reached, best first.
 *
 * Email when there is one, because a payment link is a thing people open on a
 * desktop and keep. WhatsApp when there is not — a lead that arrived through
 * the widget or a WhatsApp message often has a number and nothing else, and
 * "this lead has no email address" is a dead end when the customer is sitting
 * in a chat we can already write to.
 *
 * Pure, so the panel and the send cannot disagree about which button to show
 * and which channel to use.
 */
export function payChannel(opts: { email: boolean; phone: boolean; canEmail: boolean; canWhatsApp: boolean }): PayChannel | null {
  if (opts.email && opts.canEmail) return 'email'
  if (opts.phone && opts.canWhatsApp) return 'whatsapp'
  return null
}

export interface PayLinkState {
  present: boolean
  /** Whether the lead can be reached at all. Offering Send with nowhere to send
   *  it produces a refusal after the click instead of before it. */
  canSend: boolean
  /** Which way it will go, so the button can say so. */
  channel: PayChannel | null
  /** Whether this member may SET the link. Sent explicitly rather than inferred
   *  from `url` being present: an admin with nothing saved yet and an agent
   *  with nothing saved yet look identical from the client's side, and the one
   *  that guessed offered the agent a field the server would refuse. */
  canEdit: boolean
  /** The real URL — ONLY ever populated for a member who may see contacts. */
  url: string | null
  savedBy: string
  savedAt: string
  lastSent: { by: string; at: string; channel: PayChannel } | null
}

const MAX_URL = 2000

/**
 * Is this something we are willing to mail a customer?
 *
 * https only, and a real host. An agent never types this — an admin does — but
 * the value ends up in an email we send from the company's own mailbox, so a
 * `javascript:` or a bare word has no business reaching that far.
 */
export function cleanPayLink(raw: unknown): string | null {
  const s = String(raw ?? '').trim().slice(0, MAX_URL)
  if (!s) return null
  let u: URL
  try { u = new URL(s) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (!u.hostname.includes('.')) return null
  return u.toString()
}

export async function readPayLink(leadId: string): Promise<{ link: PayLinkRow | null; sent: PayLinkRow | null }> {
  const { data } = await supabase.from('chat_logs')
    .select('message, created_at')
    .eq('session_id', leadId).eq('role', PAY_LINK_ROLE)
    .order('created_at', { ascending: false }).limit(50)
  let link: PayLinkRow | null = null
  let sent: PayLinkRow | null = null
  for (const r of data ?? []) {
    let o: PayLinkRow
    try { o = JSON.parse(r.message) } catch { continue }
    if (!link && o.kind === 'link') link = o
    if (!sent && o.kind === 'sent') sent = o
    if (link && sent) break
  }
  // A cleared link is stored as a 'link' row with no url, so clearing is a
  // further row rather than a delete — the history stays readable.
  return { link, sent }
}

/**
 * The state as this member is allowed to receive it.
 *
 * `url` is populated ONLY for a member who may see contacts. Everyone else gets
 * `present` and nothing they could reconstruct the link from.
 */
export function payLinkFor(
  member: Pick<Member, 'role' | 'workspace'>,
  link: PayLinkRow | null,
  sent: PayLinkRow | null,
  channel: PayChannel | null = 'email',
): PayLinkState {
  const present = Boolean(link?.url)
  return {
    present,
    canSend: present && channel !== null,
    channel,
    canEdit: member.role === 'admin',
    url: present && canSeeContacts(member) ? (link?.url ?? null) : null,
    savedBy: link?.by ?? '',
    savedAt: link?.at ?? '',
    lastSent: sent ? { by: sent.by, at: sent.at, channel: sent.channel ?? 'email' } : null,
  }
}

// Inserted here rather than through leadrecord's writeControlRow: leadrecord
// imports the redaction helpers from this file, and a module that imports its
// own importer is a cycle waiting to resolve in the wrong order.
async function writeRow(leadId: string, siteId: string, row: PayLinkRow) {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: siteId, session_id: leadId, role: PAY_LINK_ROLE, message: JSON.stringify(row),
  })
  return { error: error?.message ?? null }
}

export async function savePayLink(leadId: string, siteId: string, url: string | null, by: string) {
  return writeRow(leadId, siteId, { kind: 'link', url: url ?? undefined, by, at: new Date().toISOString() })
}

export async function recordPayLinkSent(leadId: string, siteId: string, by: string, channel: PayChannel) {
  return writeRow(leadId, siteId, { kind: 'sent', by, at: new Date().toISOString(), channel })
}

/**
 * The link as it is written into the TIMELINE copy of the email.
 *
 * The mail that leaves carries the real URL; the row we keep does not. That is
 * deliberate and it is the only reason this works: the timeline is served to
 * the agent, so storing what was actually sent would hand back, one screen
 * later, exactly the value the send was built to withhold. Nothing is lost —
 * the URL is on its own row, with who saved it and when, where an admin reads
 * it.
 */
export function redactedForTimeline(text: string, url: string): string {
  return text.split(url).join(`[payment link — ${HIDDEN_LINK}]`)
}

/**
 * Take every payment link this lead has ever carried out of text served to a
 * member who may not see it.
 *
 * The outbound copy was never stored (see redactedForTimeline) and that was not
 * enough: the CUSTOMER quotes it straight back. A reply saying "I got that,
 * https://www.paypal.com/invoice/p/#…" puts the link on the timeline in the
 * customer's own words, and the quoted chain under it carries our whole
 * original message. Anything that reproduces the link reproduces the leak,
 * whoever typed it.
 *
 * Every link ever saved on the lead, not just the current one: a superseded
 * link still opens the same invoice.
 */
export function redactLinks<T extends string | null | undefined>(text: T, links: string[]): string | null {
  if (!text) return (text ?? null) as string | null
  let out = String(text)
  for (const l of links) {
    if (!l) continue
    out = out.split(l).join(`[payment link \u2014 ${HIDDEN_LINK}]`)
  }
  return out
}

/** Every payment link on a lead, read out of rows the caller already has. */
export function payLinksInRows(rows: { role: string; message: string }[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.role !== PAY_LINK_ROLE) continue
    try {
      const o = JSON.parse(r.message) as PayLinkRow
      if (o?.url) out.add(o.url)
    } catch { /* skip */ }
  }
  return Array.from(out)
}
