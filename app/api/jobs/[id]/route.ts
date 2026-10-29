import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { isJobsOnly } from '@/lib/jobsonly'
import { listJobs, writeJob, listMessages, workspaceMembers, notifyJob } from '@/lib/jobstore'
import { cleanJobInput, statusesOf, JOB_STATUS_LABEL, type Job } from '@/lib/jobs'
import { buildJobBrief } from '@/lib/jobbrief'
import { formFromInvoice, newestInvoiceDoc, withoutContacts } from '@/lib/productionform'

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
  const needsDraft = c.job.track === 'production' && !c.job.production
  const [messages, members, brief, invoice] = await Promise.all([
    listMessages(c.m.workspace, id), workspaceMembers(c.m.workspace),
    c.job.leadId ? buildJobBrief(c.job.leadId, c.m.workspace).catch(() => null) : Promise.resolve(null),
    needsDraft ? newestInvoiceDoc(c.job.leadId).catch(() => null) : Promise.resolve(null),
  ])
  const jobsOnly = isJobsOnly(c.m.email)
  // A production job with no form yet gets one filled from the lead's invoice.
  const csr = members.find((x) => x.email === c.job.createdBy)?.name ?? ''
  let productionDraft = needsDraft ? formFromInvoice(invoice, c.job, csr) : null
  let job = c.job
  if (jobsOnly) { productionDraft = withoutContacts(productionDraft); job = { ...job, production: withoutContacts(job.production) } }
  return NextResponse.json({ ok: true, me: c.m.email, jobsOnly, job, productionDraft, messages, members, brief })
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
  // The designer's account is sent the form without the client's contacts, so
  // what it posts back must not blank them.
  if (input.production && isJobsOnly(c.m.email)) {
    const members = await workspaceMembers(c.m.workspace)
    const kept = c.job.production?.client
      ?? formFromInvoice(await newestInvoiceDoc(c.job.leadId).catch(() => null), c.job, members.find((x) => x.email === c.job.createdBy)?.name ?? '').client
    input.production = { ...input.production, client: { ...kept, name: input.production.client.name || kept.name } }
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
  return NextResponse.json({ ok: true, job: isJobsOnly(c.m.email) ? { ...next, production: withoutContacts(next.production) } : next })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const c = await load(req, id)
  if ('error' in c) return c.error
  const err = await writeJob(c.m.workspace, { ...c.job, deleted: true, updatedBy: c.m.email, updatedAt: new Date().toISOString() })
  if (err) return NextResponse.json({ error: 'Could not remove it.' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
