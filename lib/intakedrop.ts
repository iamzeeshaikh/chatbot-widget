// Every lead the intake endpoint accepted and did NOT store.
//
// /api/quote-intake answers `{ success: true }` in three cases where nothing is
// written: the site is retired, the body looks like spam, or the submission is
// a duplicate. Answering success is correct — the Apps Script must label the
// thread Processed and stop retrying — but until now the lead simply ceased to
// exist. No row, no log, no trace. When an agent said "leads are missing", the
// honest answer was that nobody could tell whether any had been dropped, which
// is exactly how a filter with a hole in it stays hidden.
//
// So a drop is recorded. It is a CONTROL ROW on the reserved zeeops-crm site,
// the same no-DDL pattern the rest of the CRM uses, carrying enough of the
// submission to recognise a real customer in it and recover them by hand.
//
// It is deliberately NOT a lead: it is not counted, not billed, and not shown
// on any dashboard tile. It is the evidence that the count is right.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'

export const INTAKE_DROP_ROLE = 'crm_intake_drop'
export const INTAKE_DROP_SESSION = 'zeeops-crm-intake-drops'

export type DropReason = 'spam' | 'retired' | 'duplicate'

export interface IntakeDrop {
  at: string
  siteId: string
  reason: DropReason
  /** Which rule fired, when we know — so a false positive names its own cause. */
  detail?: string
  name?: string
  email?: string
  phone?: string
  product?: string
  /** Enough of the body to recognise a real enquiry, not the whole thing. */
  excerpt?: string
  /** For a duplicate, the lead it was folded into. */
  mergedInto?: string
}

export function parseIntakeDrop(message: string | null | undefined): IntakeDrop | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.siteId !== 'string' || typeof o.reason !== 'string') return null
    return o as IntakeDrop
  } catch { return null }
}

/**
 * Record one drop. Never throws: a failure to write the audit row must not
 * turn a silent drop into a failed request the Apps Script would retry
 * forever.
 */
export async function recordIntakeDrop(d: Omit<IntakeDrop, 'at'> & { at?: string }): Promise<void> {
  try {
    const row: IntakeDrop = {
      at: d.at ?? new Date().toISOString(),
      siteId: d.siteId,
      reason: d.reason,
      ...(d.detail ? { detail: d.detail } : {}),
      ...(d.name ? { name: d.name.slice(0, 120) } : {}),
      ...(d.email ? { email: d.email.slice(0, 200) } : {}),
      ...(d.phone ? { phone: d.phone.slice(0, 40) } : {}),
      ...(d.product ? { product: d.product.slice(0, 200) } : {}),
      ...(d.excerpt ? { excerpt: d.excerpt.replace(/\s+/g, ' ').trim().slice(0, 600) } : {}),
      ...(d.mergedInto ? { mergedInto: d.mergedInto } : {}),
    }
    await supabase.from('chat_logs').insert({
      site_id: REMINDER_SITE,
      session_id: INTAKE_DROP_SESSION,
      role: INTAKE_DROP_ROLE,
      message: JSON.stringify(row),
    })
  } catch (e) {
    console.error('[intake-drop] could not record:', e instanceof Error ? e.message : e)
  }
}

/** Recent drops, newest first, optionally limited to a set of sites. */
export async function recentIntakeDrops(sites?: string[], limit = 200): Promise<IntakeDrop[]> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', INTAKE_DROP_ROLE)
    .eq('session_id', INTAKE_DROP_SESSION)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit * 3, 1000))
  const out: IntakeDrop[] = []
  for (const r of data ?? []) {
    const d = parseIntakeDrop(r.message)
    if (!d) continue
    if (sites && !sites.includes(d.siteId)) continue
    out.push(d)
    if (out.length >= limit) break
  }
  return out
}
