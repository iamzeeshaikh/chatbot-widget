// Reading and writing jobs (lib/jobs.ts). Server only.

import { supabase } from './supabase'
import type { Member } from './auth'
import { loadAgentSignatures } from './signature'
import { storedMemberNames } from './membername'
import { sendPushToMember } from './push'
import type { Workspace } from './workspaces'
import {
  CRM_JOB_ROLE, CRM_JOB_MSG_ROLE, JOB_SITE, jobSession, parseJob, parseJobMessage,
  type Job, type JobMessage,
} from './jobs'

const CAP = 20000

/** Every live job in the workspace, newest first. */
export async function listJobs(ws: Workspace): Promise<Job[]> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', jobSession(ws)).eq('role', CRM_JOB_ROLE)
    .order('created_at', { ascending: true }).limit(CAP)
  if ((data ?? []).length >= CAP) console.warn('[jobs] job snapshot query hit its cap')
  const byId = new Map<string, Job>()
  for (const r of data ?? []) { const j = parseJob(r.message); if (j) byId.set(j.id, j) }
  return [...byId.values()].filter((j) => !j.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Including deleted ones — for numbering, so a number is never reused. */
export async function jobCount(ws: Workspace): Promise<number> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', jobSession(ws)).eq('role', CRM_JOB_ROLE).limit(CAP)
  return new Set((data ?? []).map((r) => parseJob(r.message)?.id).filter(Boolean)).size
}

export async function writeJob(ws: Workspace, job: Job): Promise<string | null> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: JOB_SITE, session_id: jobSession(ws), role: CRM_JOB_ROLE, message: JSON.stringify(job),
  })
  return error?.message ?? null
}

export async function listMessages(ws: Workspace, jobId: string): Promise<JobMessage[]> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', jobSession(ws)).eq('role', CRM_JOB_MSG_ROLE)
    // `_` is ilike's one-character wildcard and matches a literal `_`, so it
    // stays: stripping it (job_…) made every message unfindable.
    .ilike('message', `%"jobId":"${jobId.replace(/[%"\\]/g, '')}"%`)
    .order('created_at', { ascending: true }).limit(2000)
  return (data ?? []).map((r) => parseJobMessage(r.message)).filter((m): m is JobMessage => !!m && m.jobId === jobId)
}

export async function writeMessage(ws: Workspace, msg: JobMessage): Promise<string | null> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: JOB_SITE, session_id: jobSession(ws), role: CRM_JOB_MSG_ROLE, message: JSON.stringify(msg),
  })
  return error?.message ?? null
}

/** Who a job can go to, with the names people know them by. */
export async function workspaceMembers(ws: Workspace): Promise<{ email: string; name: string }[]> {
  const [{ data }, sigs, chatNames] = await Promise.all([
    supabase.from('members').select('email').eq('workspace', ws),
    loadAgentSignatures(), storedMemberNames(),
  ])
  return (data ?? []).map((m) => {
    const email = String(m.email).toLowerCase()
    return { email, name: sigs.get(email)?.name || chatNames.get(email) || email.split('@')[0] }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** Fire-and-forget: a push to everyone on the job except whoever acted. */
export async function notifyJob(ws: Workspace, job: Job, actor: Member, title: string, body: string): Promise<void> {
  const to = new Set([job.assignee, job.createdBy].filter(Boolean).map((e) => e.toLowerCase()))
  to.delete(actor.email.toLowerCase())
  await Promise.all([...to].map((email) => sendPushToMember(email, ws, {
    title, body, url: `/jobs/${encodeURIComponent(job.id)}`, tag: `job-${job.id}`,
  }).catch(() => 0)))
}
