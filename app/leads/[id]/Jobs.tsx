'use client'

// The record page's jobs card: what has been asked of the estimator/designer
// for this customer, where each one stands, and a button to ask for more.
// Opens in a new tab, like Create invoice, so the record stays behind it.

import { useEffect, useState } from 'react'
import { Hammer, Plus } from 'lucide-react'
import { Card } from './ui'
import { JOB_STATUS_DOT, JOB_STATUS_LABEL, JOB_TYPE_LABEL, type Job } from '@/lib/jobs'

export default function Jobs({ leadId }: { leadId: string }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [off, setOff] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(`/api/jobs?lead=${encodeURIComponent(leadId)}`).then(async (r) => {
      if (!alive) return
      if (r.status === 403) { setOff(true); return }
      const j = await r.json().catch(() => ({}))
      setJobs(j.jobs ?? [])
    }).catch(() => { if (alive) setJobs([]) })
    return () => { alive = false }
  }, [leadId])
  if (off) return null

  return (
    <Card title="Jobs" icon={Hammer}
      action={
        <a href={`/jobs?new=1&lead=${encodeURIComponent(leadId)}`} target="_blank" rel="noopener"
          className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg border border-blue-300 bg-blue-100 text-blue-700 hover:bg-blue-200">
          <Plus size={12} strokeWidth={2.5} aria-hidden /> New job
        </a>
      }>
      <div className="px-3 py-2">
        {jobs === null ? <p className="text-xs text-gray-400">Loading…</p>
          : jobs.length === 0 ? <p className="text-xs text-gray-500">No estimate or design requested yet.</p>
          : (
            <ul className="divide-y divide-gray-100">
              {jobs.map((j) => (
                <li key={j.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: JOB_STATUS_DOT[j.status] }} aria-hidden />
                  <a href={`/jobs/${encodeURIComponent(j.id)}`} target="_blank" rel="noopener" className="min-w-0 truncate font-semibold text-blue-700 hover:underline">{j.number} · {j.title}</a>
                  <span className="ml-auto shrink-0 text-gray-500">{JOB_TYPE_LABEL[j.type]} · {JOB_STATUS_LABEL[j.status]}</span>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Card>
  )
}
