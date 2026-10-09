// Payouts — withdrawals that landed in the bank — stored like sales.
//
//   crm_payout — one snapshot per save on the reserved zeeops-crm site,
//                session `zeeops-payouts-<workspace>`, newest per id wins,
//                delete = a snapshot with `deleted: true`.
//
// Registered in CRM_ROLES (lib/crm.ts) as the second line of defence; the
// reserved site is the first, so these rows can never reach a conversation.
// Recording a payout also LOCKS the rate onto the payments it covered — that
// write goes through writeSale like any other edit, so the sale's history
// shows exactly which payout fixed which rate (see /api/sales/payouts).
import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { REMINDER_SITE } from './reminders'
import type { Workspace } from './workspaces'
import type { Payout } from './salescore'

export const CRM_PAYOUT_ROLE = 'crm_payout'
export const payoutsSession = (ws: Workspace) => `zeeops-payouts-${ws}`
const MAX_ROWS = 20_000

export async function readPayouts(ws: Workspace): Promise<Payout[]> {
  const rows = await fetchAllPages<{ message: string; created_at: string }>(
    () => supabase.from('chat_logs')
      .select('message, created_at')
      .eq('site_id', REMINDER_SITE)
      .eq('session_id', payoutsSession(ws))
      .eq('role', CRM_PAYOUT_ROLE)
      .order('created_at', { ascending: true }),
    MAX_ROWS,
  )
  warnIfCapped('payouts', rows.length, MAX_ROWS)
  const byId = new Map<string, Payout>()
  for (const r of rows) {
    try {
      const p = JSON.parse(r.message) as Payout
      if (p?.id && p.workspace === ws) byId.set(p.id, p)
    } catch { /* malformed row — skip */ }
  }
  return Array.from(byId.values())
    .filter((p) => !p.deleted)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt.localeCompare(a.createdAt))
}

export async function writePayout(payout: Payout): Promise<string | null> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE,
    session_id: payoutsSession(payout.workspace),
    role: CRM_PAYOUT_ROLE,
    message: JSON.stringify(payout),
  })
  return error?.message ?? null
}
