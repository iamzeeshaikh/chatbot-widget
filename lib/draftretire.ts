// A person wrote to the customer, so the bot's unsent first-reply draft is
// stale: sending it now would greet a customer we are already talking to.
// Laurie Chassé sat in "Bot draft ready" for five days after Samir had
// answered her (owner, 2026-10-28). Called after an agent's email goes out.
//
// Revisions, never deletes: the draft gets a 'discarded' row and its bot task a
// 'done' row, exactly as Discard and Complete would write them.

import { supabase } from './supabase'
import { writeControlRow } from './leadrecord'
import { CRM_BOT_DRAFT_ROLE, foldDrafts } from './botdraft'
import { CRM_TASK_ROLE, parseCrmTask } from './tasks'

const FIRST_REPLY_TASK = /^Review and send the first reply/

export async function retireFirstDrafts(sessionId: string, siteId: string, by: string): Promise<number> {
  const { data } = await supabase.from('chat_logs').select('role, message')
    .eq('session_id', sessionId).in('role', [CRM_BOT_DRAFT_ROLE, CRM_TASK_ROLE])
    .order('created_at', { ascending: true }).range(0, 4999)
  const rows = (data ?? []) as { role: string; message: string }[]
  const now = new Date().toISOString()
  const why = 'an agent already emailed this customer'
  let n = 0
  for (const d of foldDrafts(rows)) {
    if (d.status !== 'pending' || d.step !== 'first') continue
    await writeControlRow({ sessionId, siteId, role: CRM_BOT_DRAFT_ROLE, message: JSON.stringify({ ...d, status: 'discarded', by, decidedAt: now, why }) })
    n++
  }
  const tasks = new Map<string, ReturnType<typeof parseCrmTask>>()
  for (const r of rows) if (r.role === CRM_TASK_ROLE) { const t = parseCrmTask(r.message); if (t) tasks.set(t.id, t) }
  for (const t of tasks.values()) {
    if (!t || t.deleted || t.status !== 'open' || t.created_by !== 'zeeops-bot' || !FIRST_REPLY_TASK.test(t.title)) continue
    await writeControlRow({ sessionId, siteId, role: CRM_TASK_ROLE, message: JSON.stringify({ ...t, status: 'done', updated_by: by, updated_at: now, completed_by: by, completed_at: now }) })
  }
  return n
}
