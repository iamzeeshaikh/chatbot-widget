import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { isJobsOnly } from '@/lib/jobsonly'
import { listJobs, writeJob, listMessages, workspaceMembers, notifyJob } from '@/lib/jobstore'
import { cleanJobInput, statusesOf, JOB_STATUS_LABEL, type Job } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

async function load(req: NextRequest, id: string) {
  const m = await getMember(req)
  if (!m) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!hasFeature(m.workspace, 'jobs')) return { error: NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 }) }
  const job = (await listJobs(m.workspace)).find((j) => j.id === id)
  if (!job || (job.siteId && !canAccessSite(m, job.siteId))) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { m, job }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await load(req, id)
  if ('error' in c) return c.error
  const [messages, members] = await Promise.all([listMessages(c.m.workspace, id), workspaceMembers(c.m.workspace)])
  return NextResponse.json({ ok: true, me: c.m.email, jobsOnly: isJobsOnly(c.m.email), job: c.job, messages, members })
}

// Every change is a new snapshot, so the trail of who moved what stays.
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await load(req, id)
  if ('error' in c) return c.error
  const input = cleanJobInput(await req.json().catch(() => ({})))
  delete input.leadId // a job's lead is set when it is created
  delete input.track  // and its track: production opens as a job of its own
  if (input.status && !statusesOf(c.job.track).includes(input.status)) {
    return NextResponse.json({ error: 'That stage belongs to the other board.' }, { status: 400 })
  }
  const now = new Date().toISOString()
  const next: Job = { ...c.job, ...input, updatedBy: c.m.email, updatedAt: now }
  if (input.status && input.status !== c.job.status) next.statusAt = now
  if (!next.title) return NextResponse.json({ error: 'A job needs a title.' }, { status: 400 })
  const err = await writeJob(c.m.workspace, next)
  if (err) return NextResponse.json({ error: 'That did not save.' }, { status: 500 })

  if (input.status && input.status !== c.job.status) {
    await notifyJob(c.m.workspace, next, c.m, `${next.number} is now ${JOB_STATUS_LABEL[next.status]}`, next.title)
  } else if (input.assignee && input.assignee !== c.job.assignee) {
    await notifyJob(c.m.workspace, next, c.m, `Job ${next.number} assigned to you`, next.title)
  }
  return NextResponse.json({ ok: true, job: next })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await load(req, id)
  if ('error' in c) return c.error
  const err = await writeJob(c.m.workspace, { ...c.job, deleted: true, updatedBy: c.m.email, updatedAt: new Date().toISOString() })
  if (err) return NextResponse.json({ error: 'Could not remove it.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
