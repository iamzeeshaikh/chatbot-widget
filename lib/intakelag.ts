// How long a lead took to reach ZeeOps after the customer sent it.
//
// A lead's `created_at` is the DATE OF THE EMAIL, not the moment we stored it,
// which is right — an enquiry belongs to the hour the customer wrote it — but
// it means nothing in the database has ever recorded when a lead actually
// arrived. So "this quote came in over an hour ago and it is not on the
// portal" could only be answered with a guess, and the answer that mattered —
// how late, and how often — did not exist anywhere.
//
// It happened for real on 9 Sep 2026: a 12:24am enquiry an agent went looking
// for at 2:15am was not there, and turned up on its own some time before
// 4:30am. The cause was found by reading the Apps Script, not by reading any
// record, because there was no record to read.
//
// A row is written only when the delay is worth knowing about — the Gmail
// watcher runs every 30 minutes, so anything inside LATE_AFTER_MS is simply
// the trigger's own cadence and says nothing. Same no-DDL control-row pattern
// as lib/intakedrop.ts, on the same reserved site, so it can never reach a
// conversation list, a transcript or a preview.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'

export const INTAKE_LAG_ROLE = 'crm_intake_lag'
export const INTAKE_LAG_SESSION = 'zeeops-crm-intake-lag'

/** Below this, the delay is the 30-minute trigger cadence, not a fault. */
export const LATE_AFTER_MS = 45 * 60 * 1000

export interface IntakeLag {
  /** When we stored it. */
  at: string
  /** The date on the customer's own email. */
  sentAt: string
  minutesLate: number
  siteId: string
  leadId: string
  name?: string
  email?: string
  product?: string
}

export function parseIntakeLag(message: string | null | undefined): IntakeLag | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.siteId !== 'string' || typeof o.minutesLate !== 'number') return null
    return o as IntakeLag
  } catch { return null }
}

/**
 * Record a late arrival, if it was late. Never throws: an audit row failing to
 * write must not turn a stored lead into a 500 the Apps Script would retry.
 */
export async function recordIntakeLag(d: {
  siteId: string; leadId: string; sentAt: string
  name?: string; email?: string; product?: string
}): Promise<void> {
  try {
    const sent = new Date(d.sentAt).getTime()
    if (!Number.isFinite(sent)) return
    const now = Date.now()
    // A clock skew or a receivedAt in the future is not a late lead.
    const lag = now - sent
    if (lag < LATE_AFTER_MS) return
    const row: IntakeLag = {
      at: new Date(now).toISOString(),
      sentAt: new Date(sent).toISOString(),
      minutesLate: Math.round(lag / 60000),
      siteId: d.siteId,
      leadId: d.leadId,
      name: d.name?.slice(0, 120) || undefined,
      email: d.email?.slice(0, 200) || undefined,
      product: d.product?.slice(0, 120) || undefined,
    }
    await supabase.from('chat_logs').insert([{
      session_id: INTAKE_LAG_SESSION,
      site_id: REMINDER_SITE,
      role: INTAKE_LAG_ROLE,
      message: JSON.stringify(row),
    }])
  } catch (err) {
    console.error('[intake-lag] could not record:', err)
  }
}

/** Recent late arrivals, newest first, optionally limited to a set of sites. */
export async function recentIntakeLags(sites?: string[], limit = 100): Promise<IntakeLag[]> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', INTAKE_LAG_ROLE)
    .eq('session_id', INTAKE_LAG_SESSION)
    .order('created_at', { ascending: false })
    .limit(Math.min(limit * 3, 600))
  const out: IntakeLag[] = []
  for (const r of data ?? []) {
    const l = parseIntakeLag(r.message)
    if (!l) continue
    if (sites && !sites.includes(l.siteId)) continue
    out.push(l)
    if (out.length >= limit) break
  }
  return out
}
