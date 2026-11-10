// WhatsApp template messages — how an agent reaches a customer after the
// 24-hour window has closed.
//
// WhatsApp allows a free-form message only within 24 hours of the customer's
// last one; outside it, only a template Meta approved in advance is delivered
// (Twilio 63016 / Meta 131047 otherwise). So the composer offers these when the
// window is shut, fills the blanks itself, and sends them on the lead's own line.
//
// The SAME three texts exist on both lines, created 2026-11-10:
//   US +1 503-461-4788 — Twilio Content API (one Content SID each), submitted
//                        for WhatsApp approval on the Twilio WABA;
//   UK +44 7578 382054 — Meta Graph message_templates on the UK WABA, by name.
// Content SIDs and template names are identifiers, not secrets.
//
// Only APPROVED templates are ever offered: approval is read live from the
// provider (cached 10 minutes), so a template Meta rejects or pauses simply
// disappears from the menu instead of failing at send time.

import { twilioConfig, twilioTemplateStatuses } from './twilio'
import { metaWaConfig, metaTemplateStatuses, type WaLine } from './metawa'

export interface WaTemplate {
  /** The WhatsApp template name — identical on both lines. */
  name: string
  label: string
  /** {{1}} customer first name, {{2}} agent first name, {{3}} site name. */
  body: string
  twilioSid: string
  language: string
}

export const WA_TEMPLATES: readonly WaTemplate[] = [
  {
    name: 'zeeops_followup', label: 'Follow up on their request', language: 'en',
    twilioSid: 'HX834b7e75763957eafe0acdb556cd23a5',
    body: 'Hi {{1}}, this is {{2}} from {{3}}. Following up on your packaging request. Just reply to this message and I will pick it up from here.',
  },
  {
    name: 'zeeops_quote_ready', label: 'Your custom quote is ready', language: 'en',
    twilioSid: 'HX034371ede71fd9c2fb572d34e42ad2f0',
    body: 'Hi {{1}}, this is {{2}} from {{3}}. Your custom quote for your packaging request is ready. Reply to this message and I will share it with you here.',
  },
  {
    name: 'zeeops_order_update', label: 'We tried to reach you about your order', language: 'en',
    twilioSid: 'HXa9276d8f11b3aaca61948446c059d889',
    body: 'Hi {{1}}, this is {{2}} from {{3}}. We tried to reach you about your order. Please reply to this message when you have a moment so we can continue.',
  },
]

export function templateByName(name: string): WaTemplate | null {
  return WA_TEMPLATES.find((t) => t.name === name) ?? null
}

/** The text the customer will read, blanks filled. */
export function renderTemplate(t: WaTemplate, vars: string[]): string {
  return t.body.replace(/\{\{(\d)\}\}/g, (_, n) => vars[Number(n) - 1] ?? '')
}

/** A template variable Meta will accept: no newlines/tabs, no 4+ spaces, short. */
export function cleanVar(v: string, fallback: string): string {
  const s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 60)
  return s || fallback
}

const cache: Partial<Record<WaLine, { at: number; status: Map<string, string> }>> = {}

/** Approval state per template on a line: 'approved' | 'pending' | 'rejected' | 'unknown'. */
export async function templateStatuses(line: WaLine): Promise<Map<string, 'approved' | 'pending' | 'rejected' | 'unknown'>> {
  const hit = cache[line]
  let raw: Map<string, string>
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) raw = hit.status
  else {
    raw = new Map()
    try {
      if (line === 'meta') {
        const cfg = metaWaConfig()
        if (cfg) raw = await metaTemplateStatuses(cfg)
      } else {
        const cfg = twilioConfig('packaging')
        if (cfg) raw = await twilioTemplateStatuses(cfg)
      }
      cache[line] = { at: Date.now(), status: raw }
    } catch (e) {
      console.error(`[wa-templates] approval lookup failed on ${line}:`, e instanceof Error ? e.message : e)
    }
  }
  const out = new Map<string, 'approved' | 'pending' | 'rejected' | 'unknown'>()
  for (const t of WA_TEMPLATES) {
    const s = String(raw.get(line === 'meta' ? t.name : t.twilioSid) ?? '').toLowerCase()
    out.set(t.name, s === 'approved' ? 'approved'
      : /reject|disabled|paused/.test(s) ? 'rejected'
      : /pending|received|in_appeal|submitted/.test(s) ? 'pending' : 'unknown')
  }
  return out
}
