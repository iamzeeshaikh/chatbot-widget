import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { isJobsOnly } from '@/lib/jobsonly'
import { resolveLeadSite } from '@/lib/leadrecord'
import { listJobs, jobCount, writeJob, workspaceMembers, notifyJob } from '@/lib/jobstore'
import { cleanJobInput, newJobId, statusesOf, JOB_TYPE_LABEL, type Job } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

// Jobs for the member's workspace (lib/jobs.ts). Gated on the 'jobs' feature
// in the route itself, not just the nav (CLAUDE.md §3).
async function member(req: NextRequest) {
  const m = await getMember(req)
  if (!m) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!hasFeature(m.workspace, 'jobs')) return { error: NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 }) }
  return { m }
}

export async function GET(req: NextRequest) {
  const c = await member(req)
  if ('error' in c) return c.error
  const lead = req.nextUrl.searchParams.get('lead')
  const [jobs, members] = await Promise.all([listJobs(c.m.workspace), workspaceMembers(c.m.workspace)])
  // A job tied to a lead on a site this member cannot see stays out of view.
  const visible = jobs.filter((j) => !j.siteId || canAccessSite(c.m, j.siteId))
  return NextResponse.json({ ok: true, me: c.m.email, jobsOnly: isJobsOnly(c.m.email), jobs: lead ? visible.filter((j) => j.leadId === lead) : visible, members })
}

export async function POST(req: NextRequest) {
  const c = await member(req)
  if ('error' in c) return c.error
  const input = cleanJobInput(await req.json().catch(() => ({})))
  if (!input.title) return NextResponse.json({ error: 'Give the job a title.' }, { status: 400 })

  let leadName = ''
  let siteId = ''
  if (input.leadId) {
    const r = await resolveLeadSite(input.leadId)
    if (!r || !canAccessSite(c.m, r.siteId)) return NextResponse.json({ error: 'That lead is not one you can open.' }, { status: 403 })
    siteId = r.siteId
    leadName = r.lead?.name || r.lead?.email || ''
  }
  const now = new Date().toISOString()
  const job: Job = {
    id: newJobId(),
    number: `J-${String((await jobCount(c.m.workspace)) + 1).padStart(4, '0')}`,
    title: input.title,
    track: input.track ?? (input.type === 'production' ? 'production' : 'design'),
    type: input.type ?? (input.track === 'production' ? 'production' : 'other'),
    status: statusesOf(input.track ?? (input.type === 'production' ? 'production' : 'design'))[0],
    requirements: input.requirements ?? '', assignee: input.assignee ?? '',
    leadId: input.leadId ?? '', leadName, siteId, dueAt: input.dueAt ?? '',
    estimate: input.estimate ?? null,
    createdBy: c.m.email, createdAt: now, updatedBy: c.m.email, updatedAt: now, statusAt: now,
  }
  const err = await writeJob(c.m.workspace, job)
  if (err) return NextResponse.json({ error: 'The job did not save.' }, { status: 500 })
  await notifyJob(c.m.workspace, job, c.m, `New job ${job.number}: ${JOB_TYPE_LABEL[job.type]}`, job.title)
  return NextResponse.json({ ok: true, job })
}
