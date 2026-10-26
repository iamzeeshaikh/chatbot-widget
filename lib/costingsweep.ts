// The daily costing ask (lib/costing.ts says why). Once a day, for every paid
// packaging sale without a cost:
//   - one task on the sale's lead, assigned to the costing person, so it sits
//     in their Tasks list and the reminder sweep pushes it when due;
//   - one push that sums it up and opens /costing.
// When a sale gets its cost (or is refunded, cancelled or deleted) its task is
// closed — from here, and straight away when the cost is saved on the page.
//
// No DDL: which task belongs to which sale is a `crm_costing` row on the
// reserved site, newest per sale id wins (registered in CRM_ROLES).

import { supabase, fetchAllPages } from './supabase'
import { REMINDER_SITE } from './reminders'
import { readSales, suggestedRates, leadFactsFor } from './sales'
import { figures } from './salescore'
import { costingBucket, COSTING_MEMBERS } from './costing'
import { writeControlRow } from './leadrecord'
import { CRM_TASK_ROLE, newTaskId, type CrmTaskEntry } from './tasks'
import { sendPushToMember } from './push'

export const CRM_COSTING_ROLE = 'crm_costing'
const COSTING_SESSION = 'zeeops-costing'
const ACTOR = 'zeeops-bot'

interface CostingLedger {
  saleId: string
  leadId: string
  siteId: string
  task: CrmTaskEntry
  state: 'open' | 'closed'
  at: string
}

async function readLedger(): Promise<Map<string, CostingLedger>> {
  const rows = await fetchAllPages<{ message: string }>(
    () => supabase.from('chat_logs').select('message')
      .eq('site_id', REMINDER_SITE).eq('session_id', COSTING_SESSION).eq('role', CRM_COSTING_ROLE)
      .order('created_at', { ascending: true }),
    20_000,
  )
  const out = new Map<string, CostingLedger>()
  for (const r of rows) {
    try {
      const l = JSON.parse(r.message) as CostingLedger
      if (l?.saleId && l.task?.id) out.set(l.saleId, l)
    } catch { /* skip */ }
  }
  return out
}

async function writeLedger(l: CostingLedger): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE, session_id: COSTING_SESSION, role: CRM_COSTING_ROLE, message: JSON.stringify(l),
  })
}

/** Close the costing task of one sale, if it has an open one. */
export async function closeCostingTask(saleId: string, by: string, ledger?: Map<string, CostingLedger>): Promise<boolean> {
  const l = (ledger ?? await readLedger()).get(saleId)
  if (!l || l.state !== 'open') return false
  const now = new Date().toISOString()
  const task: CrmTaskEntry = { ...l.task, status: 'done', updated_by: by, updated_at: now, completed_by: by, completed_at: now }
  await writeControlRow({ sessionId: l.leadId, siteId: l.siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
  await writeLedger({ ...l, task, state: 'closed', at: now })
  return true
}

export interface CostingSweepResult {
  needs: number
  tasksCreated: number
  tasksClosed: number
  pushed: number
  dryRun: boolean
}

export async function runCostingSweep(opts: { dryRun?: boolean; push?: boolean } = {}): Promise<CostingSweepResult> {
  const dryRun = !!opts.dryRun
  const assignee = COSTING_MEMBERS[0]
  const [sales, rates, ledger] = await Promise.all([readSales('packaging'), suggestedRates(), readLedger()])
  const suggested = rates?.rates ?? null

  const needs = sales.filter((s) => costingBucket(s, figures(s, suggested)) === 'needs')
  const needIds = new Set(needs.map((s) => s.id))

  // Tasks whose sale no longer needs a cost: close them.
  let tasksClosed = 0
  for (const [saleId, l] of ledger) {
    if (l.state !== 'open' || needIds.has(saleId)) continue
    if (!dryRun && await closeCostingTask(saleId, ACTOR, ledger)) tasksClosed++
    else if (dryRun) tasksClosed++
  }

  // One task per sale that needs a cost and has a lead to hang it on.
  const fresh = needs.filter((s) => s.leadId && ledger.get(s.id)?.state !== 'open')
  const facts = await leadFactsFor(fresh.map((s) => s.leadId))
  let tasksCreated = 0
  const now = new Date()
  for (const s of fresh) {
    const siteId = facts.get(s.leadId as string)?.siteId
    if (!siteId) continue
    const task: CrmTaskEntry = {
      id: newTaskId(),
      title: `Enter the production cost for ${s.customer || 'this order'} — ${s.product || 'packaging'} (open Costing)`.slice(0, 200),
      type: 'other',
      due_at: new Date(now.getTime() + 2 * 3600 * 1000).toISOString(),
      assignee, status: 'open', created_by: ACTOR, created_at: now.toISOString(),
    }
    tasksCreated++
    if (dryRun) continue
    await writeControlRow({ sessionId: s.leadId as string, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    await writeLedger({ saleId: s.id, leadId: s.leadId as string, siteId, task, state: 'open', at: now.toISOString() })
  }

  let pushed = 0
  if (!dryRun && opts.push !== false && needs.length > 0) {
    pushed = await sendPushToMember(assignee, 'packaging', {
      title: `${needs.length} order${needs.length === 1 ? '' : 's'} need a production cost`,
      body: needs.slice(0, 3).map((s) => s.customer).filter(Boolean).join(', ') + (needs.length > 3 ? ` and ${needs.length - 3} more` : '') + '. Open Costing and enter them.',
      url: '/costing', tag: 'costing-daily',
    }).catch(() => 0)
  }

  return { needs: needs.length, tasksCreated, tasksClosed, pushed, dryRun }
}
