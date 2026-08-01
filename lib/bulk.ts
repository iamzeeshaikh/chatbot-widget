// Bulk edits from the pipeline list.
//
// 401 leads sat in New because categorising them meant opening 401 record
// pages. This applies one change across a selection — but a bulk write is the
// easiest place to quietly do the wrong thing to a lot of rows at once, so:
//
//  • Site access is decided PER LEAD, never once for the batch. The lookup is
//    batched (two queries for the whole selection instead of one per lead), but
//    canAccessSite still runs for every id. A selection spanning sites the
//    member cannot write to applies the ones they can and reports the rest as
//    skipped — it never applies anything they lack access to, and never fails
//    the whole batch because one lead was out of scope.
//  • Writes are append-only control rows, so a partial failure leaves the
//    successful ones intact. There is no transaction to roll back and we do not
//    pretend otherwise: the response says exactly which ids landed.
//  • Every lead gets its OWN control row, so the per-lead audit trail and
//    timeline are identical to what a single edit produces.
//
// Undo is real, and is a compensating change rather than a rollback: it writes
// a further row restoring each lead's previous value. History keeps both events
// on purpose — that is the point of an append-only audit trail.

import { supabase } from './supabase'
import { canAccessSite, type Member } from './auth'
import { isQuoteSessionId } from './quoteintake'

// How many leads one request may touch. 400 leads is two writes each; the cap
// keeps a single request bounded and is well clear of the real backlog.
export const BULK_MAX_IDS = 500

// Writes run in waves rather than all at once (which would open 800 sockets and
// spike the Micro-instance Postgres this repo has already crashed once) and
// rather than sequentially (400 round trips would time out).
export const BULK_CONCURRENCY = 8

export type SkipReason = 'no-access' | 'not-found'

export interface BulkOutcome {
  applied: string[]
  skipped: { id: string; reason: SkipReason }[]
  failed: { id: string; error: string }[]
}

/** Resolve every id's site in two queries, then check access for each one. */
export async function resolveSitesForIds(
  member: Member,
  ids: string[],
): Promise<{ allowed: Map<string, string>; skipped: { id: string; reason: SkipReason }[] }> {
  const allowed = new Map<string, string>()
  const skipped: { id: string; reason: SkipReason }[] = []

  const quoteIds = ids.filter(isQuoteSessionId)
  const chatIds = ids.filter((id) => !isQuoteSessionId(id))
  const siteOf = new Map<string, string>()

  // `leads` rows, keyed back to their synthetic quote-<id> session id.
  for (const chunk of chunks(quoteIds.map((id) => id.slice('quote-'.length)).filter(Boolean), 200)) {
    const { data } = await supabase.from('leads').select('id, site_id').in('id', chunk)
    for (const r of data ?? []) if (r.site_id) siteOf.set(`quote-${r.id}`, r.site_id)
  }

  // Chat leads: any row for the session tells us its site.
  for (const chunk of chunks(chatIds, 200)) {
    const { data } = await supabase.from('chat_logs').select('session_id, site_id').in('session_id', chunk)
    for (const r of data ?? []) if (r.site_id && !siteOf.has(r.session_id)) siteOf.set(r.session_id, r.site_id)
  }

  for (const id of ids) {
    const site = siteOf.get(id)
    if (!site) { skipped.push({ id, reason: 'not-found' }); continue }
    // Per lead, not per batch.
    if (!canAccessSite(member, site)) { skipped.push({ id, reason: 'no-access' }); continue }
    allowed.set(id, site)
  }
  return { allowed, skipped }
}

/**
 * Run `write` for every entry, BULK_CONCURRENCY at a time. A rejection or a
 * returned error is recorded against that id only; the rest still run and their
 * writes stand.
 */
export async function runBulk<T>(
  entries: T[],
  idOf: (item: T) => string,
  write: (item: T) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ applied: string[]; failed: { id: string; error: string }[] }> {
  const applied: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const wave of chunks(entries, BULK_CONCURRENCY)) {
    const settled = await Promise.allSettled(wave.map((item) => write(item)))
    settled.forEach((s, i) => {
      const id = idOf(wave[i])
      if (s.status === 'rejected') {
        failed.push({ id, error: s.reason instanceof Error ? s.reason.message : 'Write failed' })
      } else if (!s.value.ok) {
        failed.push({ id, error: s.value.error ?? 'Write failed' })
      } else {
        applied.push(id)
      }
    })
  }
  return { applied, failed }
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Human sentence for what was left out and why — shown, never swallowed. */
export function describeSkipped(skipped: { id: string; reason: SkipReason }[]): string {
  if (skipped.length === 0) return ''
  const noAccess = skipped.filter((s) => s.reason === 'no-access').length
  const missing = skipped.filter((s) => s.reason === 'not-found').length
  const parts: string[] = []
  if (noAccess) parts.push(`${noAccess} on ${noAccess === 1 ? 'a site' : 'sites'} you cannot edit`)
  if (missing) parts.push(`${missing} no longer ${missing === 1 ? 'exists' : 'exist'}`)
  return `Skipped ${skipped.length}: ${parts.join(', ')}.`
}
