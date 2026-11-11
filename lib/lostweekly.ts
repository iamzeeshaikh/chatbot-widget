// The weekly Lost report (packaging only, owner 2026-11-11) — the PURE half:
// who gets what. I/O lives in lib/lostweeklysweep.ts; `npm run test:lostweekly`.
//
// Per agent, from the Lost page's own rows (loadLost, so the report says what
// /lost says): how many leads they moved to Lost in the last 7 days, split by
// reason (and "no reason"), plus how many Lost leads they OWN that still have
// no reason. Only agents with something in either number get a message; the
// admins get one combined summary. A row is one customer (the page's site +
// email merge), so the counts are customers, the same as the page.

import { LOST_REASONS, lostReasonLabel, type LostReason } from './lostreasons'

export interface LostWeeklyRow {
  id: string
  siteId: string
  owner: string | null
  lostAt: string | null
  lostBy: string | null
  reason: LostReason | null
}

export interface LostWeeklyAgent { email: string; name: string; role: 'admin' | 'standard' }

export interface AgentLostSummary {
  email: string
  name: string
  /** moved to Lost by them in the window, keyed by reason ('none' = no reason) */
  week: Record<string, number>
  weekTotal: number
  /** Lost leads they own with no reason, all of the page's window */
  ownedNoReason: number
  /** the newest of those — the lead the review task hangs on */
  taskLead: { id: string; siteId: string } | null
}

export interface LostWeeklyMessage { kind: 'agent' | 'admin'; key: string; to: string; title: string; body: string; url: string }

export const LOST_WEEK_DAYS = 7
export const LOST_URL = '/lost'

const first = (name: string, email: string) => (name || email.split('@')[0]).split(/\s+/)[0]

export function splitLine(week: Record<string, number>): string {
  const parts = LOST_REASONS.filter((r) => week[r.key]).map((r) => `${lostReasonLabel(r.key)} ${week[r.key]}`)
  if (week.none) parts.push(`no reason ${week.none}`)
  return parts.join(', ')
}

export function summarizeLost(rows: LostWeeklyRow[], agents: LostWeeklyAgent[], now: Date): {
  perAgent: AgentLostSummary[]
  /** moved to Lost in the window by someone who is not a member (a bot, an old account) */
  others: Record<string, Record<string, number>>
  totals: { week: Record<string, number>; weekTotal: number; noReason: number; unassignedNoReason: number }
} {
  const since = now.getTime() - LOST_WEEK_DAYS * 86_400_000
  const known = new Map(agents.map((a) => [a.email.toLowerCase(), a]))
  const by = new Map<string, AgentLostSummary>()
  const get = (email: string) => {
    let s = by.get(email)
    if (!s) { s = { email, name: known.get(email)?.name ?? email, week: {}, weekTotal: 0, ownedNoReason: 0, taskLead: null }; by.set(email, s) }
    return s
  }
  const others: Record<string, Record<string, number>> = {}
  const totals = { week: {} as Record<string, number>, weekTotal: 0, noReason: 0, unassignedNoReason: 0 }
  // Newest lost first, so the first reason-less row seen per owner is the newest.
  const sorted = [...rows].sort((a, b) => (b.lostAt ?? '').localeCompare(a.lostAt ?? ''))

  for (const r of sorted) {
    const k = r.reason ?? 'none'
    const at = r.lostAt ? Date.parse(r.lostAt) : NaN
    if (!isNaN(at) && at >= since && at <= now.getTime()) {
      totals.week[k] = (totals.week[k] ?? 0) + 1
      totals.weekTotal++
      const who = (r.lostBy ?? '').trim().toLowerCase()
      if (who && known.has(who)) {
        const s = get(who)
        s.week[k] = (s.week[k] ?? 0) + 1
        s.weekTotal++
      } else {
        const o = (others[who || 'unknown'] ??= {})
        o[k] = (o[k] ?? 0) + 1
      }
    }
    if (!r.reason) {
      totals.noReason++
      const owner = (r.owner ?? '').trim().toLowerCase()
      if (owner && known.has(owner)) {
        const s = get(owner)
        s.ownedNoReason++
        if (!s.taskLead) s.taskLead = { id: r.id, siteId: r.siteId }
      } else totals.unassignedNoReason++
    }
  }
  const perAgent = [...by.values()].filter((s) => s.weekTotal > 0 || s.ownedNoReason > 0)
    .sort((a, b) => (b.weekTotal + b.ownedNoReason) - (a.weekTotal + a.ownedNoReason) || a.email.localeCompare(b.email))
  return { perAgent, others, totals }
}

export function planLostWeekly(
  sum: ReturnType<typeof summarizeLost>, agents: LostWeeklyAgent[], weekKey: string, base: string,
): LostWeeklyMessage[] {
  const link = `${base}${LOST_URL}`
  const out: LostWeeklyMessage[] = []
  for (const s of sum.perAgent) {
    const lines: string[] = []
    lines.push(s.weekTotal
      ? `You moved ${s.weekTotal} lead${s.weekTotal === 1 ? '' : 's'} to Lost in the last 7 days: ${splitLine(s.week)}.`
      : 'You moved no leads to Lost in the last 7 days.')
    if (s.ownedNoReason) lines.push(`${s.ownedNoReason} of your Lost leads still have no reason — please pick one for each.`)
    out.push({
      kind: 'agent', key: `lostweekly:${weekKey}:${s.email}`, to: s.email,
      title: `${first(s.name, s.email)}, your Lost leads this week`,
      body: `${lines.join(' ')} ${link}`, url: LOST_URL,
    })
  }
  const admins = agents.filter((a) => a.role === 'admin')
  if (admins.length && (sum.totals.weekTotal || sum.totals.noReason)) {
    const per = sum.perAgent.map((s) => `${first(s.name, s.email)}: ${s.weekTotal} lost${s.weekTotal ? ` (${splitLine(s.week)})` : ''}, ${s.ownedNoReason} without a reason`)
    const other = Object.entries(sum.others).map(([who, w]) => `${who === 'unknown' ? 'unknown' : who.split('@')[0]}: ${Object.values(w).reduce((a, b) => a + b, 0)} lost (${splitLine(w)})`)
    const body = [
      `Last 7 days: ${sum.totals.weekTotal} lead${sum.totals.weekTotal === 1 ? '' : 's'} moved to Lost${sum.totals.weekTotal ? ` — ${splitLine(sum.totals.week)}` : ''}.`,
      `${sum.totals.noReason} Lost leads have no reason (${sum.totals.unassignedNoReason} unassigned).`,
      ...per, ...other, link,
    ].join('\n')
    for (const a of admins) {
      out.push({ kind: 'admin', key: `lostweekly:${weekKey}:admin:${a.email}`, to: a.email, title: 'Weekly Lost report', body, url: LOST_URL })
    }
  }
  return out
}
