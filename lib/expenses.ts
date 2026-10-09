// Expenses — salaries, office, vendors — stored exactly like sales/payouts:
// one `crm_expense` snapshot per save on the reserved zeeops-crm site,
// session `zeeops-expenses-<workspace>`, newest per id wins, delete = a
// snapshot with `deleted: true`. Registered in CRM_ROLES (lib/crm.ts).
import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { REMINDER_SITE } from './reminders'
import type { Workspace } from './workspaces'
import type { Expense } from './salescore'

export const CRM_EXPENSE_ROLE = 'crm_expense'
export const expensesSession = (ws: Workspace) => `zeeops-expenses-${ws}`
const MAX_ROWS = 20_000

export async function readExpenses(ws: Workspace): Promise<Expense[]> {
  const rows = await fetchAllPages<{ message: string; created_at: string }>(
    () => supabase.from('chat_logs')
      .select('message, created_at')
      .eq('site_id', REMINDER_SITE)
      .eq('session_id', expensesSession(ws))
      .eq('role', CRM_EXPENSE_ROLE)
      .order('created_at', { ascending: true }),
    MAX_ROWS,
  )
  warnIfCapped('expenses', rows.length, MAX_ROWS)
  const byId = new Map<string, Expense>()
  for (const r of rows) {
    try {
      const e = JSON.parse(r.message) as Expense
      if (e?.id && e.workspace === ws) byId.set(e.id, e)
    } catch { /* malformed row — skip */ }
  }
  return Array.from(byId.values())
    .filter((e) => !e.deleted)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt.localeCompare(a.createdAt))
}

export async function writeExpense(expense: Expense): Promise<string | null> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE,
    session_id: expensesSession(expense.workspace),
    role: CRM_EXPENSE_ROLE,
    message: JSON.stringify(expense),
  })
  return error?.message ?? null
}
