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

// ── The designed version ─────────────────────────────────────────────────────
//
// Built server-side from stored FIELDS, never from anything an agent typed, so
// it is trusted HTML and does not go through lib/richtext.ts's whitelist —
// which would strip the table and every inline style and leave a bare list of
// lines. It is appended at SEND time rather than inserted into the composer,
// which also means a signature cannot be half-deleted by an agent editing
// around it.
//
// Written the way email HTML has to be written, not the way a web page is:
//   • a TABLE for layout — Outlook's renderer is Word's, and it does not do
//     flexbox or grid at all;
//   • every style INLINE — Gmail strips <style> blocks entirely;
//   • text glyphs, not images or SVG, for the little icons. Gmail removes
//     <svg>, blocks data: URIs in <img>, and hides remote images until the
//     reader clicks "display images" — so any of those leaves four broken
//     boxes down the side of the signature on first read.

const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const ACCENT = '#2563eb'
const INK = '#111827'
const MUTED = '#6b7280'
const BODY = '#374151'

function row(glyph: string, inner: string): string {
  return '<tr>'
    // Fixed-width icon column so the four lines align down a single edge —
    // letting it size to content staggers them, which is most of why a
    // signature looks thrown together rather than set.
    + `<td width="22" style="width:22px;padding:3px 0;font-size:13px;line-height:20px;color:${ACCENT};vertical-align:top;">${glyph}</td>`
    + `<td style="padding:3px 0;font-size:13px;line-height:20px;color:${BODY};vertical-align:top;">${inner}</td>`
    + '</tr>'
}

function link(href: string, text: string): string {
  return `<a href="${esc(href)}" style="color:${BODY};text-decoration:none;">${esc(text)}</a>`
}

export function renderSignatureHtml(
  agent: AgentSignature | null | undefined,
  site: SiteContact | null | undefined,
  fallback: { name?: string; email?: string; company?: string } = {},
): string {
  const name = agent?.name || fallback.name || ''
  const company = site?.company || fallback.company || ''
  const title = agent?.title || ''
  const phone = agent?.phone || site?.phone || ''
  const email = fallback.email || ''
  const website = (site?.website || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const address = site?.address || ''

  const rows = [
    phone ? row('&#9743;', link(`tel:${phone.replace(/[^\d+]/g, '')}`, phone)) : '',
    email ? row('&#9993;', link(`mailto:${email}`, email)) : '',
    website ? row('&#127760;', link(`https://${website}`, website)) : '',
    address ? row('&#128205;', `<span style="color:${BODY};">${esc(address)}</span>`) : '',
  ].filter(Boolean).join('')

  // Nothing to say — no empty box, no lonely rule.
  if (!name && !company && !rows) return ''

  // The name block. When there is no name yet the company takes its size and
  // weight rather than sitting there in small type next to a blank space.
  const left = [
    name
      ? `<div style="font-size:18px;font-weight:700;color:${INK};line-height:24px;letter-spacing:-0.2px;">${esc(name)}</div>`
      : '',
    title ? `<div style="font-size:13px;color:${MUTED};line-height:19px;padding-top:1px;">${esc(title)}</div>` : '',
    company
      ? (name
          ? `<div style="font-size:13px;font-weight:600;color:${ACCENT};line-height:19px;padding-top:4px;">${esc(company)}</div>`
          : `<div style="font-size:18px;font-weight:700;color:${ACCENT};line-height:24px;letter-spacing:-0.2px;">${esc(company)}</div>`)
      : '',
  ].filter(Boolean).join('')

  // A hairline above the whole block, so it reads as a signature rather than
  // as another paragraph of the email.
  return '<div style="margin-top:22px;padding-top:14px;border-top:1px solid #e5e7eb;">'
    + '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:-apple-system,Segoe UI,Arial,Helvetica,sans-serif;">'
    + '<tr>'
    + (left
        ? `<td style="padding:0 20px 0 0;border-right:3px solid ${ACCENT};vertical-align:middle;">${left}</td>`
        : '')
    + (rows
        ? `<td style="padding:0 0 0 ${left ? '20px' : '0'};vertical-align:middle;">`
          + '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' + rows + '</table>'
          + '</td>'
        : '')
    + '</tr></table></div>'
}
