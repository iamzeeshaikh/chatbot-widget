import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { listJobs, jobCount, writeJob, notifyJob } from '@/lib/jobstore'
import { newJobId, type Job } from '@/lib/jobs'

export const dynamic = 'force-dynamic'

// "Send to production": an approved design job opens its production job —
// same customer, same requirements and estimate — on the Production board at
// Stock. The two point at each other, so either page links to the other.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const m = await getMember(req)
  if (!m) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(m.workspace, 'jobs')) return NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 })
  const all = await listJobs(m.workspace)
  const design = all.find((j) => j.id === id)
  if (!design || (design.siteId && !canAccessSite(m, design.siteId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (design.track !== 'design') return NextResponse.json({ error: 'Only a design job can be sent to production.' }, { status: 400 })
  if (design.productionJobId && all.some((j) => j.id === design.productionJobId)) {
    return NextResponse.json({ error: 'This job is already in production.', job: all.find((j) => j.id === design.productionJobId) }, { status: 409 })
  }
  const now = new Date().toISOString()
  const prod: Job = {
    id: newJobId(),
    number: `J-${String((await jobCount(m.workspace)) + 1).padStart(4, '0')}`,
    title: design.title.replace(/^(estimate|design)\s*:\s*/i, ''),
    track: 'production', type: 'production', status: 'stock',
    requirements: design.requirements, assignee: design.assignee,
    leadId: design.leadId, leadName: design.leadName, siteId: design.siteId, dueAt: design.dueAt,
    estimate: design.estimate, sourceJobId: design.id,
    createdBy: m.email, createdAt: now, updatedBy: m.email, updatedAt: now, statusAt: now,
  }
  const err = await writeJob(m.workspace, prod)
  if (err) return NextResponse.json({ error: 'The production job did not save.' }, { status: 500 })
  await writeJob(m.workspace, { ...design, productionJobId: prod.id, updatedBy: m.email, updatedAt: now })
  await notifyJob(m.workspace, prod, m, `${prod.number} sent to production`, prod.title)
  return NextResponse.json({ ok: true, job: prod })
}
