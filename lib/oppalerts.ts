// Opportunities alerts — the decisions, pure. PACKAGING ONLY.
//
// Three alerts, all pushed to each agent BY NAME and linking into
// /opportunities pre-filtered to that agent (owner's request, 2026-10-21):
//   morning   10:00 PKT daily — "Good morning Samir. 16 customers are waiting
//             for your reply, 1 quote can close this month." One per agent
//             with anything; unassigned waiting customers go to every agent
//             as their own line; admins get the totals.
//   waiting   a customer has had no reply for 2 h → the assigned agent, once;
//             still unanswered at 24 h → admins too, once.
//   monthend  last day of the month, 18:00 PKT — the leaderboard to everyone.
//
// Nothing is queued. Every sweep recomputes from the Opportunities data (the
// same module the page uses, so the numbers match it) and asks these functions
// what is owed; a `crm_opp_alert` ledger row per key, written BEFORE the push,
// is what makes each alert fire at most once — across runs, retries and
// redeploys. Quiet hours (23:00–08:00 PKT) hold, never drop: the state is
// still there at 08:00 and the next run sends it then.
//
// Everything here is pure so scripts/oppalerts.test.ts can drive it with a
// fake clock and a fake ledger. The loading and sending live in
// lib/oppalertsweep.ts.

import { pktDayKey, pktPartsOf } from './datetime'

export const CRM_OPP_ALERT_ROLE = 'crm_opp_alert'
export const OPP_ALERT_SESSION = 'zeeops-opp-alerts'

export const QUIET_START = 23
export const QUIET_END = 8
export const MORNING_HOUR = 10
export const MONTHEND_HOUR = 18
export const WAIT_FIRST_H = 2
export const WAIT_ESCALATE_H = 24
/** A wait older than this is backlog, not news: it is in the morning summary
 *  and on the page, and a nudge about a 13-day-old message helps nobody.
 *  Also what keeps the first live run from pushing the whole backlog. */
export const WAIT_STALE_H = 72
/** Nudges per recipient per run; the rest go out on the next run (5 min). */
export const WAIT_PER_RUN = 5

export type AlertKind = 'morning' | 'waiting' | 'waiting24' | 'monthend'

/** 08:00–22:59 PKT is open; 23:00–07:59 is quiet. */
export function inQuiet(now: Date): boolean {
  const h = pktHour(now)
  return h >= QUIET_START || h < QUIET_END
}

export function pktHour(now: Date): number {
  const p = pktPartsOf(now)
  return p ? Number(p.time.slice(0, 2)) : 0
}

/** True on the last Karachi day of the month. */
export function isLastDayOfMonth(now: Date): boolean {
  const today = pktDayKey(now)
  const tomorrow = pktDayKey(new Date(now.getTime() + 86_400_000))
  return today.slice(0, 7) !== tomorrow.slice(0, 7)
}

// ── Keys: one per thing that may fire, ever ─────────────────────────────────

export const morningKey = (email: string, now: Date) => `morning:${email.toLowerCase()}:${pktDayKey(now)}`
export const monthendKey = (email: string, now: Date) => `monthend:${email.toLowerCase()}:${pktDayKey(now).slice(0, 7)}`
/** One waiting episode = one customer message left unanswered (its instant). */
export const waitingKey = (leadId: string, since: string, stage: 'waiting' | 'waiting24') => `${stage}:${leadId}:${since}`

// ── Inputs ──────────────────────────────────────────────────────────────────

export interface AgentInfo {
  email: string
  /** Local part of the address — how Opportunities keys owners. */
  key: string
  /** "Samir Khan" → used for the greeting's first name. */
  name: string
  role: 'admin' | 'standard'
}

export interface WaitingLead {
  id: string
  name: string
  /** Agent key, null when unassigned. */
  owner: string | null
  hours: number
  /** The customer's message instant — the episode id. */
  since: string
}

export interface AgentCounts { waiting: number; hot: number; invoices: number }

export interface Plan {
  kind: AlertKind
  key: string
  to: string
  title: string
  body: string
  url: string
}

export interface Held { kind: AlertKind; to: string; why: string }

export interface AlertInput {
  now: Date
  agents: AgentInfo[]
  /** Per agent key ('' = unassigned). */
  counts: Map<string, AgentCounts>
  waiting: WaitingLead[]
  /** Month name + per-agent won figures for the month-end line. */
  monthLabel: string
  leaderboard: { key: string; name: string; wonCount: number; wonUsd: number }[]
  /** Keys already in the ledger. */
  sent: Set<string>
}

const firstName = (name: string) => (name.trim().split(/\s+/)[0] || 'there')
// A display name that is a company label ("Shop Cardboard Boxes" on the
// dev@ admin) is not a person to greet; address those without a name.
const greet = (name: string) => (name.trim().split(/\s+/).length > 2 ? '' : `${firstName(name)}, `)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hoursLabel = (h: number) => (h < 48 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} days`)

// ── Copy ────────────────────────────────────────────────────────────────────

export function morningCopy(name: string, c: AgentCounts): string | null {
  const parts: string[] = []
  if (c.waiting) parts.push(`${plural(c.waiting, 'customer')} ${c.waiting === 1 ? 'is' : 'are'} waiting for your reply`)
  if (c.hot) parts.push(`${plural(c.hot, 'quote')} can close this month`)
  if (c.invoices) parts.push(`${plural(c.invoices, 'invoice')} ${c.invoices === 1 ? 'is' : 'are'} due`)
  if (parts.length === 0) return null
  return `Good morning ${firstName(name)}. ${parts.join(', ')}.`
}

export function adminMorningCopy(name: string, total: AgentCounts, unassigned: number): string | null {
  const parts: string[] = []
  if (total.waiting) parts.push(`${plural(total.waiting, 'customer')} waiting for a reply${unassigned ? ` (${unassigned} unassigned)` : ''}`)
  if (total.hot) parts.push(`${plural(total.hot, 'quote')} that can close this month`)
  if (total.invoices) parts.push(`${plural(total.invoices, 'invoice')} due`)
  if (parts.length === 0) return null
  const g = greet(name)
  return `Good morning${g ? ` ${g.slice(0, -2)}` : ''}. Across the team: ${parts.join(', ')}.`
}

export function unassignedCopy(n: number): string {
  return `${plural(n, 'unassigned customer')} ${n === 1 ? 'is' : 'are'} waiting for a reply — accept one.`
}

export function waitingCopy(name: string, lead: WaitingLead): string {
  return `${firstName(name)}, ${lead.name} has been waiting ${hoursLabel(lead.hours)} for a reply.`
}

export function waiting24Copy(name: string, lead: WaitingLead, ownerName: string | null): string {
  return `${greet(name)}${lead.name} has had no reply for ${hoursLabel(lead.hours)}${ownerName ? ` (${ownerName}'s lead)` : ' and nobody has taken the lead'}.`
}

export function monthendCopy(monthLabel: string, rows: AlertInput['leaderboard']): string {
  const active = rows.filter((r) => r.wonCount > 0).sort((a, b) => b.wonUsd - a.wonUsd || b.wonCount - a.wonCount)
  if (active.length === 0) return `${monthLabel}: no sales were booked this month.`
  return `${monthLabel}: ${active.map((r) => `${firstName(r.name)} ${r.wonCount} won ($${Math.round(r.wonUsd).toLocaleString('en-US')})`).join(' · ')}`
}

export const agentUrl = (key: string, list: 'waiting' | 'hot' | 'pipeline' | 'won') => `/opportunities?agent=${encodeURIComponent(key)}&list=${list}`

// ── The decision ────────────────────────────────────────────────────────────

/**
 * Everything owed right now that has not been sent. Pure: the same input at
 * the same clock always yields the same plan, which is what the test relies on.
 */
export function planAlerts(input: AlertInput): { plans: Plan[]; held: Held[] } {
  const { now, agents, counts, waiting, sent } = input
  const plans: Plan[] = []
  const held: Held[] = []
  const quiet = inQuiet(now)
  const hour = pktHour(now)
  const standard = agents.filter((a) => a.role === 'standard')
  const admins = agents.filter((a) => a.role === 'admin')
  const nameOf = (key: string | null) => agents.find((a) => a.key === key)?.name ?? null
  const want = (p: Plan) => { if (!sent.has(p.key)) plans.push(p) }
  const unassigned = counts.get('')?.waiting ?? 0

  // ── morning summary: from 10:00, once a day, held through quiet hours ──
  // (10:00 is never quiet, but the guard is what the test pins down.)
  if (hour >= MORNING_HOUR) {
    for (const a of standard) {
      const key = morningKey(a.email, now)
      if (sent.has(key)) continue
      if (quiet) { held.push({ kind: 'morning', to: a.email, why: 'quiet hours' }); continue }
      const c = counts.get(a.key) ?? { waiting: 0, hot: 0, invoices: 0 }
      const own = morningCopy(a.name, c)
      const lines = [own, unassigned ? unassignedCopy(unassigned) : null].filter((x): x is string => !!x)
      if (lines.length === 0) continue
      want({ kind: 'morning', key, to: a.email, title: 'Your opportunities today', body: lines.join(' '), url: own ? agentUrl(a.key, c.waiting ? 'waiting' : c.hot ? 'hot' : 'pipeline') : agentUrl('', 'waiting') })
    }
    const total: AgentCounts = { waiting: 0, hot: 0, invoices: 0 }
    for (const c of counts.values()) { total.waiting += c.waiting; total.hot += c.hot; total.invoices += c.invoices }
    for (const a of admins) {
      const key = morningKey(a.email, now)
      if (sent.has(key)) continue
      if (quiet) { held.push({ kind: 'morning', to: a.email, why: 'quiet hours' }); continue }
      const body = adminMorningCopy(a.name, total, unassigned)
      if (!body) continue
      want({ kind: 'morning', key, to: a.email, title: 'Opportunities today — team totals', body, url: '/opportunities' })
    }
  }

  // ── a customer left waiting ──
  // Freshest first, so a per-run cap always spends itself on the newest.
  const perRecipient = new Map<string, number>()
  const room = (to: string) => (perRecipient.get(to) ?? 0) < WAIT_PER_RUN
  const take = (p: Plan) => { if (sent.has(p.key)) return; perRecipient.set(p.to, (perRecipient.get(p.to) ?? 0) + 1); plans.push(p) }
  const fresh = waiting.filter((w) => w.hours < WAIT_STALE_H).sort((a, b) => a.hours - b.hours)
  for (const w of fresh) {
    if (w.hours >= WAIT_FIRST_H && w.owner) {
      const key = waitingKey(w.id, w.since, 'waiting')
      const owner = agents.find((a) => a.key === w.owner)
      if (owner && !sent.has(key)) {
        if (quiet) held.push({ kind: 'waiting', to: owner.email, why: 'quiet hours' })
        else if (room(owner.email)) take({ kind: 'waiting', key, to: owner.email, title: 'A customer is waiting for you', body: waitingCopy(owner.name, w), url: `/leads/${encodeURIComponent(w.id)}` })
        else held.push({ kind: 'waiting', to: owner.email, why: 'next run (per-run cap)' })
      }
    }
    if (w.hours >= WAIT_ESCALATE_H) {
      const ownerName = nameOf(w.owner)
      for (const a of admins) {
        const key = `${waitingKey(w.id, w.since, 'waiting24')}:${a.email.toLowerCase()}`
        if (sent.has(key)) continue
        if (quiet) { held.push({ kind: 'waiting24', to: a.email, why: 'quiet hours' }); continue }
        if (!room(a.email)) { held.push({ kind: 'waiting24', to: a.email, why: 'next run (per-run cap)' }); continue }
        take({ kind: 'waiting24', key, to: a.email, title: 'A customer has waited a day', body: waiting24Copy(a.name, w, ownerName), url: `/leads/${encodeURIComponent(w.id)}` })
      }
    }
  }

  // ── month-end leaderboard: last day, from 18:00, once ──
  if (isLastDayOfMonth(now) && hour >= MONTHEND_HOUR) {
    const body = monthendCopy(input.monthLabel, input.leaderboard)
    for (const a of agents) {
      const key = monthendKey(a.email, now)
      if (sent.has(key)) continue
      if (quiet) { held.push({ kind: 'monthend', to: a.email, why: 'quiet hours' }); continue }
      want({ kind: 'monthend', key, to: a.email, title: `${input.monthLabel} — leaderboard`, body, url: '/opportunities' })
    }
  }

  return { plans, held }
}

/** Dedupe within one run: a plan's key is sent at most once. */
export function uniqueByKey(plans: Plan[]): Plan[] {
  const seen = new Set<string>()
  return plans.filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)))
}
