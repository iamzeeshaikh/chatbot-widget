// The Opportunities alert sweep — loads, decides (lib/oppalerts.ts), sends.
// PACKAGING ONLY: the data module it reads is gated to the packaging
// workspace and the recipients are packaging members, so nothing here can
// reach a sports device.
//
// Runs every 5 minutes from Vercel Cron (vercel.json). Each run:
//   1. reads the Opportunities data as the packaging admin sees it — the same
//      cached loader the page uses, so an agent's push says what the page says;
//   2. reads the packaging members and their display names;
//   3. reads the ledger of alerts already sent (keys, 45 days);
//   4. asks planAlerts() what is owed now;
//   5. for each plan: writes the ledger row FIRST, then pushes (claim-then-send
//      — a crash between the two loses one push rather than repeating it).
// `?dry=1` runs 1–4 and returns the plans without writing or pushing.

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { REMINDER_SITE } from './reminders'
import { HARDCODED_ACCOUNTS, type Member } from './auth'
import { storedMemberNames } from './membername'
import { agentDisplayName } from './agentname'
import { sendPushToMember } from './push'
import { loadOpportunities } from './opportunityload'
import { agentKey } from './opportunities'
import {
  CRM_OPP_ALERT_ROLE, OPP_ALERT_SESSION, planAlerts, uniqueByKey,
  type AgentInfo, type AgentCounts, type WaitingLead, type Plan, type Held,
} from './oppalerts'

const LEDGER_DAYS = 45
const LEDGER_CAP = 20_000

export interface OppAlertRun {
  ok: boolean
  dry: boolean
  now: string
  pktTime: string
  agents: { email: string; name: string; role: string; devices?: number }[]
  counts: Record<string, AgentCounts>
  sent: (Plan & { devices: number })[]
  would: Plan[]
  held: Held[]
  alreadySent: number
  errors: string[]
}

async function loadLedger(): Promise<Set<string>> {
  const since = new Date(Date.now() - LEDGER_DAYS * 86_400_000).toISOString()
  const rows = await fetchAllPages<{ message: string; created_at: string }>(
    () => supabase.from('chat_logs').select('message, created_at')
      .eq('site_id', REMINDER_SITE).eq('session_id', OPP_ALERT_SESSION).eq('role', CRM_OPP_ALERT_ROLE)
      .gte('created_at', since).order('created_at', { ascending: true }),
    LEDGER_CAP)
  warnIfCapped('opp alerts ledger', rows.length, LEDGER_CAP)
  const out = new Set<string>()
  for (const r of rows) { try { const o = JSON.parse(r.message); if (o?.k) out.add(String(o.k)) } catch { /* skip */ } }
  return out
}

async function claim(p: Plan, now: Date): Promise<string | null> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE, session_id: OPP_ALERT_SESSION, role: CRM_OPP_ALERT_ROLE,
    message: JSON.stringify({ k: p.key, kind: p.kind, to: p.to, title: p.title, body: p.body, url: p.url, at: now.toISOString() }),
  })
  return error?.message ?? null
}

async function packagingAgents(): Promise<AgentInfo[]> {
  const [{ data }, names] = await Promise.all([
    supabase.from('members').select('email, role, workspace'),
    storedMemberNames(),
  ])
  const out: AgentInfo[] = []
  for (const m of data ?? []) {
    if (m.workspace !== 'packaging' || !m.email) continue
    const email = String(m.email).toLowerCase()
    out.push({ email, key: agentKey(email), name: names.get(email) || agentDisplayName(email), role: m.role === 'admin' ? 'admin' : 'standard' })
  }
  // The built-in packaging admin account can hold a push subscription too.
  for (const a of HARDCODED_ACCOUNTS) {
    if (a.workspace !== 'packaging') continue
    out.push({ email: a.email.toLowerCase(), key: agentKey(a.email), name: names.get(a.email.toLowerCase()) || 'Admin', role: 'admin' })
  }
  return out
}

export async function runOppAlerts(opts: { dry?: boolean; now?: Date } = {}): Promise<OppAlertRun> {
  const now = opts.now ?? new Date()
  const dry = !!opts.dry
  const pkt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'medium', timeStyle: 'short' }).format(now)
  const result: OppAlertRun = { ok: true, dry, now: now.toISOString(), pktTime: pkt, agents: [], counts: {}, sent: [], would: [], held: [], alreadySent: 0, errors: [] }

  // The numbers come from the same loader the page uses, read as the
  // packaging admin so every site is in scope. Packaging only by construction.
  const admin: Member = { id: 'builtin:packaging@zeeops.dev', email: 'packaging@zeeops.dev', workspace: 'packaging', role: 'admin', assigned_sites: [] }
  const [data, agents, ledger] = await Promise.all([loadOpportunities(admin), packagingAgents(), loadLedger()])

  const counts = new Map<string, AgentCounts>()
  const bump = (key: string | null, f: keyof AgentCounts) => {
    const k = key ?? ''
    const c = counts.get(k) ?? { waiting: 0, hot: 0, invoices: 0 }
    c[f]++
    counts.set(k, c)
  }
  for (const i of data.waiting) bump(i.owner, 'waiting')
  for (const i of data.hot) bump(i.owner, 'hot')
  for (const i of data.invoices) bump(i.owner, 'invoices')
  const waiting: WaitingLead[] = data.waiting.map((i) => ({ id: i.id, name: i.name, owner: i.owner, hours: i.hours ?? 0, since: i.lastLineAt ?? i.createdAt }))

  const { plans, held } = planAlerts({
    now, agents, counts, waiting, sent: ledger,
    monthLabel: data.monthLabel,
    leaderboard: data.leaderboard.map((r) => ({ key: r.agent, name: r.name, wonCount: r.wonCount, wonUsd: r.wonUsd })),
  })
  const todo = uniqueByKey(plans)
  result.agents = agents.map((a) => ({ email: a.email, name: a.name, role: a.role }))
  result.counts = Object.fromEntries(counts)
  result.held = held
  result.alreadySent = plans.length - todo.length + [...ledger].filter((k) => k.startsWith('morning:') && k.endsWith(now.toISOString().slice(0, 10))).length

  if (dry) { result.would = todo; return result }

  for (const p of todo) {
    const err = await claim(p, now)
    if (err) { result.errors.push(`${p.key}: ${err}`); continue }
    try {
      const devices = await sendPushToMember(p.to, 'packaging', { title: p.title, body: p.body, url: p.url, tag: `opp-${p.kind}-${p.to}`, sticky: p.kind !== 'morning' })
      result.sent.push({ ...p, devices })
    } catch (e) {
      result.errors.push(`${p.key}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  result.ok = result.errors.length === 0
  return result
}
