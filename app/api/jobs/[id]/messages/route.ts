import { NextRequest, NextResponse } from 'next/server'
import { getMember, canAccessSite } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { listJobs, writeMessage, notifyJob } from '@/lib/jobstore'

export const dynamic = 'force-dynamic'

// A message inside a job — the CSR and the designer talking about the work.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const m = await getMember(req)
  if (!m) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!hasFeature(m.workspace, 'jobs')) return NextResponse.json({ error: 'Not available for this workspace' }, { status: 403 })
  const job = (await listJobs(m.workspace)).find((j) => j.id === id)
  if (!job || (job.siteId && !canAccessSite(m, job.siteId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { body } = await req.json().catch(() => ({}))
  const text = String(body ?? '').trim().slice(0, 4000)
  if (!text) return NextResponse.json({ error: 'The message is empty.' }, { status: 400 })
  const msg = { id: `jm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, jobId: id, author: m.email, body: text, at: new Date().toISOString() }
  const err = await writeMessage(m.workspace, msg)
  if (err) return NextResponse.json({ error: 'Not sent.' }, { status: 500 })
  await notifyJob(m.workspace, job, m, `${job.number}: new message`, text.slice(0, 140))
  return NextResponse.json({ ok: true, message: msg })
}
