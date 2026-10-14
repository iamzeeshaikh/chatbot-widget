'use client'

// /jobs — every estimate, design and production job, by status.
//
// A board on wide screens (one column per status, left to right in the order
// work moves) and one list per status on a phone. "New job" opens the form in
// place; /jobs?new=1&lead=<id> opens it already tied to a lead, which is how
// the record page's "New job" button arrives here.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Plus, X } from 'lucide-react'
import GlobalSearch from '@/app/components/GlobalSearch'
import PushButton from './PushButton'
import { timeAgo } from '@/lib/datetime'
import {
  JOB_STATUS_LABEL, JOB_STATUS_DOT, JOB_TYPES, JOB_TYPE_LABEL, JOB_TYPE_STYLE, JOB_DESIGNERS,
  JOB_TRACKS, JOB_TRACK_LABEL, statusesOf, type JobTrack,
  type Job, type JobType,
} from '@/lib/jobs'

type Member = { email: string; name: string }
const input = 'w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
const label = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

// useSearchParams needs a Suspense boundary for the static build.
export default function JobsPageRoute() {
  return <Suspense fallback={<main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading…</main>}><JobsPage /></Suspense>
}

function JobsPage() {
  const search = useSearchParams()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(search.get('new') === '1')
  const [mine, setMine] = useState(false)
  const [me, setMe] = useState('')
  // The designer/estimator's account only has Jobs (lib/jobsonly.ts): no way
  // back to a dashboard it cannot open, and no lead search it cannot use.
  const [jobsOnly, setJobsOnly] = useState(false)

  const load = useCallback(() => {
    fetch('/api/jobs').then(async (r) => {
      const j = await r.json()
      if (!r.ok) { setError(r.status === 403 ? 'Jobs are not available for this workspace.' : (j.error ?? 'Could not load jobs.')); setJobs([]); return }
      setJobs(j.jobs); setMembers(j.members); setMe(j.me); setJobsOnly(!!j.jobsOnly)
    }).catch(() => { setError('Could not load jobs.'); setJobs([]) })
  }, [])
  useEffect(() => { load() }, [load])

  const nameOf = useCallback((email: string) => members.find((m) => m.email === email)?.name ?? (email ? email.split('@')[0] : 'Unassigned'), [members])
  // Two boards — design work and production work move through different steps.
  const [track, setTrack] = useState<JobTrack>(search.get('track') === 'production' ? 'production' : 'design')
  const shown = useMemo(() => (jobs ?? []).filter((j) => j.track === track && (!mine || j.assignee === me || j.createdBy === me)), [jobs, mine, me, track])
  const countOf = (t: JobTrack) => (jobs ?? []).filter((j) => j.track === t && j.status !== 'shipped' && j.status !== 'approved').length
  const columns = statusesOf(track)

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1500px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3 flex-wrap">
          {!jobsOnly && (
            <Link href="/" title="Back to the dashboard" aria-label="Back to the dashboard"
              className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100"><ArrowLeft size={16} aria-hidden /></Link>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-gray-900 leading-tight">Jobs</h1>
            <p className="text-[11px] text-gray-500 leading-tight">Estimates, designs and production — from request to shipped</p>
          </div>
          <span className="ml-auto flex items-center gap-2">
            {!jobsOnly && <GlobalSearch />}
            <PushButton />
            {jobsOnly && (
              <button type="button" className="text-xs text-gray-500 hover:text-gray-800"
                onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {}); window.location.href = '/login' }}>
                Sign out
              </button>
            )}
            <label className="inline-flex items-center gap-1.5 text-xs text-gray-600">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Mine only
            </label>
            <button type="button" onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">
              <Plus size={14} aria-hidden /> New job
            </button>
          </span>
        </div>
      </header>

      {error && <p className="max-w-[1500px] mx-auto px-5 pt-4 text-sm text-red-700">{error}</p>}

      <div className="max-w-[1500px] mx-auto px-3 sm:px-5 pt-3 flex items-center gap-1.5" role="tablist" aria-label="Board">
        {JOB_TRACKS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={track === t}
            onClick={() => { setTrack(t); const u = new URL(window.location.href); u.searchParams.set('track', t); window.history.replaceState(null, '', u) }}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold ${track === t ? 'bg-gray-900 text-white' : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-100'}`}>
            {JOB_TRACK_LABEL[t]}
            {jobs && <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${track === t ? 'bg-white/20' : 'bg-gray-200 text-gray-600'}`}>{countOf(t)}</span>}
          </button>
        ))}
      </div>

      <div className={`max-w-[1500px] mx-auto px-3 sm:px-5 py-4 grid gap-3 ${track === 'production' ? 'lg:grid-cols-6' : 'lg:grid-cols-4'}`}>
        {columns.map((st) => {
          const col = shown.filter((j) => j.status === st)
          return (
            <section key={st} className="rounded-xl border border-gray-200 bg-gray-100/60 min-w-0">
              <header className="flex items-center gap-2 px-3 py-2">
                <span className="h-2 w-2 rounded-full" style={{ background: JOB_STATUS_DOT[st] }} aria-hidden />
                <h2 className="text-xs font-bold text-gray-700">{JOB_STATUS_LABEL[st]}</h2>
                <span className="ml-auto text-[11px] font-semibold tabular-nums text-gray-500">{jobs ? col.length : ''}</span>
              </header>
              <div className="space-y-2 px-2 pb-2">
                {jobs === null && st === columns[0] && <p className="px-1 text-xs text-gray-400">Loading…</p>}
                {col.map((j) => (
                  <a key={j.id} href={`/jobs/${encodeURIComponent(j.id)}`}
                    className="block rounded-lg border border-gray-200 bg-white p-2.5 hover:border-gray-300 hover:shadow-sm">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold tabular-nums text-gray-500">{j.number}</span>
                      <span className={`rounded-full border px-1.5 text-[10px] font-semibold ${JOB_TYPE_STYLE[j.type]}`}>{JOB_TYPE_LABEL[j.type]}</span>
                    </div>
                    <p className="mt-1 text-sm font-semibold text-gray-900 line-clamp-2">{j.title}</p>
                    {j.leadName && <p className="mt-0.5 truncate text-[11px] text-gray-500">{j.leadName}</p>}
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                      <span className="truncate">{nameOf(j.assignee)}</span>
                      <span className="ml-auto shrink-0">{timeAgo(j.statusAt || j.updatedAt)}</span>
                    </div>
                  </a>
                ))}
                {jobs !== null && col.length === 0 && <p className="px-1 py-2 text-[11px] text-gray-400">Nothing here</p>}
              </div>
            </section>
          )
        })}
      </div>

      {/* Mounted once the member list is in, so the designer default lands. */}
      {open && jobs !== null && <NewJob members={members} track={track} leadId={search.get('lead') ?? ''} onClose={() => setOpen(false)}
        onCreated={(j) => { window.location.href = `/jobs/${encodeURIComponent(j.id)}` }} />}
    </main>
  )
}

function NewJob({ members, track, leadId, onClose, onCreated }: { members: Member[]; track: JobTrack; leadId: string; onClose: () => void; onCreated: (j: Job) => void }) {
  const [title, setTitle] = useState('')
  // A production order goes straight onto the Production board (a reorder of
  // an approved design); everything else starts as design work.
  const [type, setType] = useState<JobType>(track === 'production' ? 'production' : 'estimate')
  // The designer/estimator by default — that is who almost every job is for.
  const designers = Object.values(JOB_DESIGNERS).flat()
  const [assignee, setAssignee] = useState(() => members.find((m) => designers.includes(m.email))?.email ?? '')
  const [dueAt, setDueAt] = useState('')
  const [requirements, setRequirements] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr('')
    const r = await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, type, track: type === 'production' ? 'production' : 'design', assignee, dueAt, requirements, leadId }) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setErr(j.error ?? 'Could not create the job.'); return }
    onCreated(j.job)
  }

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-gray-900/40 p-3 sm:p-8" role="dialog" aria-modal="true" aria-label="New job">
      <form onSubmit={create} className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-5 shadow-xl space-y-3">
        <div className="flex items-center">
          <h2 className="text-base font-bold text-gray-900">New job</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded-lg p-1 text-gray-500 hover:bg-gray-100"><X size={16} aria-hidden /></button>
        </div>
        {leadId && <p className="rounded-lg bg-blue-100 px-2.5 py-1.5 text-xs text-blue-700">Tied to lead <a className="underline" href={`/leads/${encodeURIComponent(leadId)}`}>{leadId}</a></p>}
        <div>
          <label className={label} htmlFor="job-title">What is needed</label>
          <input id="job-title" required autoFocus className={input} value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Estimate for 500 lipstick boxes, tuck end" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="job-type">Type</label>
            <select id="job-type" className={input} value={type} onChange={(e) => setType(e.target.value as JobType)}>
              {JOB_TYPES.map((t) => <option key={t} value={t}>{JOB_TYPE_LABEL[t]}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="job-assignee">Assign to</label>
            <select id="job-assignee" className={input} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.email} value={m.email}>{m.name}{designers.includes(m.email) ? ' — designer / estimator' : ''}</option>)}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="job-due">Needed by</label>
            <input id="job-due" type="date" className={input} value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={label} htmlFor="job-req">Requirements</label>
          <textarea id="job-req" className={input} rows={6} value={requirements} onChange={(e) => setRequirements(e.target.value)}
            placeholder={'Size, style, material, printing, quantity, links to artwork…'} />
        </div>
        {err && <p className="text-xs text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">Cancel</button>
          <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">Create job</button>
        </div>
      </form>
    </div>
  )
}
