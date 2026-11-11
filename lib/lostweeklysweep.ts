// The weekly Lost report — the I/O half (decisions in lib/lostweekly.ts).
// /api/crm/lost-weekly, Vercel Cron Mondays 05:00 UTC = 10:00 PKT.
//
// Numbers come from loadLost (the Lost page's own loader), read as the
// packaging admin so every site is in scope. Delivery is the opp-alerts way —
// there is no system mail sender in this app: a push to the agent, or, with no
// push device, an email to their own inbox from their own connected Gmail
// (emailFallback). An agent who owns reason-less Lost leads also gets a task
// "Review your Lost leads" (due 18:00 PKT that day) on the newest of them, so
// it sits on /tasks until done. Admins get one combined summary push.
//
// At-most-once per week: a ledger row per message key (crm_opp_alert role, own
// session on the reserved zeeops-crm site) is written BEFORE the push.
// `dry` returns the plan and writes / sends nothing.

import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'
import type { Member } from './auth'
import { loadLost } from './lost'
import { packagingAgents, emailFallback } from './oppalertsweep'
import { CRM_OPP_ALERT_ROLE } from './oppalerts'
import { sendPushToMember } from './push'
import { writeControlRow } from './leadrecord'
import { CRM_TASK_ROLE, newTaskId, type CrmTaskEntry } from './tasks'
import { pktDayKey, pktDateTimeToUtc } from './datetime'
import { BOT_ACTOR } from './quotebotcore'
import { summarizeLost, planLostWeekly, type LostWeeklyMessage, type AgentLostSummary } from './lostweekly'

export const LOST_WEEKLY_SESSION = 'zeeops-lost-weekly'
const PUBLIC_BASE = (process.env.NEXT_PUBLIC_BASE_URL || 'https://chat.zeeops.dev').replace(/\/$/, '')

export interface LostWeeklyRun {
  ok: boolean
  dry: boolean
  now: string
  weekKey: string
  totals: ReturnType<typeof summarizeLost>['totals']
  perAgent: AgentLostSummary[]
  others: Record<string, Record<string, number>>
  would: (LostWeeklyMessage & { task?: string })[]
  sent: (LostWeeklyMessage & { devices: number; email?: boolean; unreachable?: string; task?: string })[]
  alreadySent: string[]
  errors: string[]
}

async function sentKeys(weekKey: string): Promise<Set<string>> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('site_id', REMINDER_SITE).eq('session_id', LOST_WEEKLY_SESSION).eq('role', CRM_OPP_ALERT_ROLE)
    .gte('created_at', new Date(Date.now() - 10 * 86_400_000).toISOString()).limit(1000)
  const out = new Set<string>()
  for (const r of data ?? []) { try { const k = JSON.parse(r.message)?.k; if (typeof k === 'string' && k.includes(`:${weekKey}:`)) out.add(k) } catch { /* skip */ } }
  return out
}

export async function runLostWeekly(opts: { dry?: boolean; now?: Date } = {}): Promise<LostWeeklyRun> {
  const now = opts.now ?? new Date()
  const dry = !!opts.dry
  const weekKey = pktDayKey(now)
  const admin: Member = { id: 'builtin:packaging@zeeops.dev', email: 'packaging@zeeops.dev', workspace: 'packaging', role: 'admin', assigned_sites: [] }
  const [lost, agents, already] = await Promise.all([loadLost(admin, {}), packagingAgents(), sentKeys(weekKey)])

  const sum = summarizeLost(lost.rows, agents, now)
  const plan = planLostWeekly(sum, agents, weekKey, PUBLIC_BASE)
  const taskFor = new Map(sum.perAgent.filter((s) => s.ownedNoReason > 0 && s.taskLead).map((s) => [s.email, s]))
  const taskTitle = (s: AgentLostSummary) => `Review your Lost leads — ${s.ownedNoReason} have no reason yet (open the Lost page)`
  const result: LostWeeklyRun = {
    ok: true, dry, now: now.toISOString(), weekKey, totals: sum.totals, perAgent: sum.perAgent, others: sum.others,
    would: [], sent: [], alreadySent: [], errors: [],
  }
  if (lost.truncated) result.errors.push('loadLost reached a row cap — counts may be short')

  for (const m of plan) {
    const s = m.kind === 'agent' ? taskFor.get(m.to) : undefined
    const task = s ? taskTitle(s) : undefined
    if (already.has(m.key)) { result.alreadySent.push(m.key); continue }
    if (dry) { result.would.push({ ...m, ...(task ? { task } : {}) }); continue }

    const { error } = await supabase.from('chat_logs').insert({
      site_id: REMINDER_SITE, session_id: LOST_WEEKLY_SESSION, role: CRM_OPP_ALERT_ROLE,
      message: JSON.stringify({ k: m.key, kind: `lostweekly-${m.kind}`, to: m.to, title: m.title, body: m.body, url: m.url, at: now.toISOString() }),
    })
    if (error) { result.errors.push(`${m.key}: ${error.message}`); continue }
    try {
      if (s?.taskLead) {
        const t: CrmTaskEntry = {
          id: newTaskId(), title: taskTitle(s).slice(0, 200), type: 'follow_up',
          due_at: pktDateTimeToUtc(weekKey, '18:00') ?? new Date(now.getTime() + 8 * 3_600_000).toISOString(),
          assignee: m.to, status: 'open', created_by: BOT_ACTOR, created_at: now.toISOString(),
        }
        const w = await writeControlRow({ sessionId: s.taskLead.id, siteId: s.taskLead.siteId, role: CRM_TASK_ROLE, message: JSON.stringify(t) })
        if (w.error) result.errors.push(`${m.key} task: ${w.error}`)
      }
      const devices = await sendPushToMember(m.to, 'packaging', { title: m.title, body: m.body, url: m.url, tag: `lostweekly-${m.to}`, sticky: true })
      if (devices > 0) { result.sent.push({ ...m, devices, ...(task ? { task } : {}) }); continue }
      const fb = await emailFallback(m)
      result.sent.push({ ...m, devices: 0, ...fb, ...(task ? { task } : {}) })
    } catch (e) {
      result.errors.push(`${m.key}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  result.ok = result.errors.length === 0
  return result
}
