'use client'

// /jobs/[id] — one job: where it stands, what it needs, the estimate sheet,
// and the conversation between the CSR and the designer.
//
// The status line across the top is the whole workflow; the button under it
// is always the one next step (Start work → Send for verification → Verified →
// Send to production → Mark shipped). Any status can still be picked from the
// dropdown, because real work goes backwards too ("verification failed, fix the
// bleed").

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Plus, Save, Send, Trash2 } from 'lucide-react'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import {
  JOB_STATUS_LABEL, JOB_STATUS_DOT, JOB_TYPES, JOB_TYPE_LABEL, JOB_TYPE_STYLE, NEXT_ACTION, JOB_DESIGNERS,
  JOB_TRACK_LABEL, statusesOf,
  blankEstimate, tierMath, type Estimate, type Job, type JobMessage, type JobStatus, type JobType,
} from '@/lib/jobs'

type Member = { email: string; name: string }
const input = 'w-full rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
const label = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'
const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function JobPage() {
  const { id } = useParams<{ id: string }>()
  const jobId = decodeURIComponent(id)
  const [job, setJob] = useState<Job | null>(null)
  const [draft, setDraft] = useState<Job | null>(null)
  const [messages, setMessages] = useState<JobMessage[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [me, setMe] = useState('')
  const [jobsOnly, setJobsOnly] = useState(false)
  const [brief, setBrief] = useState<{ site: string; text: string; customerSaid: string[]; files: { url: string; name: string; mime: string; size: number; at: string; from: string }[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement | null>(null)

  // Refresh the conversation only — never the form, so nobody's typing is lost.
  const load = useCallback(async () => {
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
    if (!r.ok) return
    const j = await r.json().catch(() => null)
    if (j) setMessages(j.messages)
  }, [jobId])
  useEffect(() => {
    let alive = true
    fetch(`/api/jobs/${encodeURIComponent(jobId)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!alive) return
      if (!r.ok) { setError(j.error ?? 'Could not load this job.'); return }
      setMessages(j.messages); setMembers(j.members); setMe(j.me); setJob(j.job); setDraft(j.job); setJobsOnly(!!j.jobsOnly); setBrief(j.brief ?? null)
    }).catch(() => { if (alive) setError('Could not load this job.') })
    return () => { alive = false }
  }, [jobId])
  // The conversation refreshes on its own; the form never does, so nobody's
  // typing is overwritten.
  useEffect(() => { const t = setInterval(() => { void load() }, 15000); return () => clearInterval(t) }, [load])
  // Scroll the message list, not the page: scrollIntoView moved the whole page
  // to the bottom every time a job was opened.
  useEffect(() => { const box = bottom.current?.parentElement; if (box) box.scrollTop = box.scrollHeight }, [messages.length])

  const nameOf = useCallback((email: string) => members.find((m) => m.email === email)?.name ?? (email ? email.split('@')[0] : 'Unassigned'), [members])
  const dirty = useMemo(() => JSON.stringify(job) !== JSON.stringify(draft), [job, draft])

  async function patch(body: Partial<Job>) {
    setBusy(true); setError('')
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { setError(j.error ?? 'That did not save.'); return }
    setJob(j.job); setDraft((d) => (d ? { ...d, ...body, status: j.job.status, statusAt: j.job.statusAt, updatedAt: j.job.updatedAt, updatedBy: j.job.updatedBy } : j.job))
  }

  async function saveEdits() {
    if (!draft) return
    const { title, type, requirements, assignee, dueAt, estimate } = draft
    await patch({ title, type, requirements, assignee, dueAt, estimate })
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body) return
    setText('')
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) })
    const j = await r.json().catch(() => ({}))
    if (r.ok) setMessages((m) => [...m, j.message]); else { setText(body); setError(j.error ?? 'Not sent.') }
  }

  async function toProduction() {
    setBusy(true); setError('')
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/production`, { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (j.job?.id) { window.location.href = `/jobs/${encodeURIComponent(j.job.id)}`; return }
    setError(j.error ?? 'Could not send it to production.')
  }

  async function remove() {
    if (!job || !window.confirm(`Remove job ${job.number}?`)) return
    const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' })
    if (r.ok) window.location.href = '/jobs'
  }

  if (!job || !draft) return <main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">{error || 'Loading…'}</main>

  const set = (p: Partial<Job>) => setDraft((d) => (d ? { ...d, ...p } : d))
  const est: Estimate | null = draft.estimate
  const setEst = (p: Partial<Estimate>) => set({ estimate: { ...(est ?? blankEstimate()), ...p } })
  const steps = statusesOf(job.track)
  const idx = steps.indexOf(job.status)
  const next = NEXT_ACTION[job.status]
  const canSendToProduction = job.track !== 'production' && job.status === 'approved' && !job.productionJobId

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="max-w-[1300px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-3 flex-wrap">
          <Link href={`/jobs?track=${job.track}`} aria-label="Back to jobs" className="shrink-0 p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100"><ArrowLeft size={16} aria-hidden /></Link>
          <span className="text-sm font-bold tabular-nums text-gray-500">{job.number}</span>
          <span className={`rounded-full border px-2 text-[11px] font-semibold ${JOB_TYPE_STYLE[job.type]}`}>{JOB_TYPE_LABEL[job.type]}</span>
          <h1 className="min-w-0 truncate text-base font-bold text-gray-900">{job.title}</h1>
          <span className="ml-auto flex items-center gap-2">
            {error && <span className="text-xs text-red-700">{error}</span>}
            <button type="button" onClick={remove} title="Remove this job" className="rounded-lg border border-gray-300 p-1.5 text-gray-500 hover:text-red-700"><Trash2 size={14} aria-hidden /></button>
            <button type="button" onClick={saveEdits} disabled={!dirty || busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-100 disabled:opacity-50">
              <Save size={14} aria-hidden /> {dirty ? 'Save changes' : 'Saved'}
            </button>
          </span>
        </div>
      </header>

      <div className="max-w-[1300px] mx-auto px-3 sm:px-5 py-4 space-y-4">
        {/* ── where it stands ─────────────────────────────────────────── */}
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{JOB_TRACK_LABEL[job.track]}</p>
          <ol className={`grid grid-cols-3 gap-2 ${steps.length > 4 ? 'sm:grid-cols-6' : 'sm:grid-cols-4'}`} aria-label="Job status">
            {steps.map((st, i) => (
              <li key={st} className="min-w-0">
                <div className="h-1.5 rounded-full" style={{ background: i <= idx ? JOB_STATUS_DOT[job.status] : '#e5e7eb' }} />
                <p className={`mt-1 truncate text-[11px] ${i === idx ? 'font-bold text-gray-900' : 'text-gray-500'}`}>{JOB_STATUS_LABEL[st]}</p>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {next && (
              <button type="button" disabled={busy} onClick={() => patch({ status: next.to })}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {next.label}
              </button>
            )}
            {job.status === 'verification' && (
              <button type="button" disabled={busy} onClick={() => patch({ status: 'in_process' })}
                className="rounded-lg border border-amber-300 bg-amber-100 px-3 py-1.5 text-sm font-semibold text-amber-700 hover:bg-amber-200">
                Needs changes — back to In Process
              </button>
            )}
            {canSendToProduction && (
              <button type="button" disabled={busy} onClick={toProduction}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
                Send to production
              </button>
            )}
            {job.productionJobId && (
              <a href={`/jobs/${encodeURIComponent(job.productionJobId)}`} className="text-xs font-semibold text-emerald-700 hover:underline">In production → open the production job</a>
            )}
            {job.sourceJobId && (
              <a href={`/jobs/${encodeURIComponent(job.sourceJobId)}`} className="text-xs font-semibold text-blue-700 hover:underline">← the approved design job</a>
            )}
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-gray-600">Status
              <select value={job.status} disabled={busy} onChange={(e) => patch({ status: e.target.value as JobStatus })}
                className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs">
                {steps.map((st) => <option key={st} value={st}>{JOB_STATUS_LABEL[st]}</option>)}
              </select>
            </label>
            <span className="text-[11px] text-gray-500">since {timeAgo(job.statusAt || job.updatedAt)} · by {nameOf(job.updatedBy)}</span>
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <div className="space-y-4 min-w-0">
            {/* ── what it needs ─────────────────────────────────────── */}
            <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
              <div>
                <label className={label} htmlFor="j-title">Title</label>
                <input id="j-title" className={input} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div>
                  <label className={label} htmlFor="j-type">Type</label>
                  <select id="j-type" className={input} value={draft.type} onChange={(e) => set({ type: e.target.value as JobType })}>
                    {JOB_TYPES.map((t) => <option key={t} value={t}>{JOB_TYPE_LABEL[t]}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="j-assignee">Assigned to</label>
                  <select id="j-assignee" className={input} value={draft.assignee} onChange={(e) => set({ assignee: e.target.value })}>
                    <option value="">Unassigned</option>
                    {members.map((m) => <option key={m.email} value={m.email}>{m.name}{Object.values(JOB_DESIGNERS).flat().includes(m.email) ? ' — designer / estimator' : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label className={label} htmlFor="j-due">Needed by</label>
                  <input id="j-due" type="date" className={input} value={draft.dueAt} onChange={(e) => set({ dueAt: e.target.value })} />
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Requested by {nameOf(job.createdBy)} · {formatDateTime(job.createdAt)}
                {job.leadId && (jobsOnly
                  ? <> · Customer: {job.leadName || '—'}</>
                  : <> · Lead: <a className="text-blue-700 hover:underline" href={`/leads/${encodeURIComponent(job.leadId)}`} target="_blank" rel="noopener">{job.leadName || job.leadId}</a></>)}
              </p>
              <div>
                <label className={label} htmlFor="j-req">Requirements</label>
                <textarea id="j-req" className={input} rows={7} value={draft.requirements} onChange={(e) => set({ requirements: e.target.value })} />
              </div>
            </section>

            {/* ── what the customer asked for (lib/jobbrief.ts) ─────── */}
            {brief && (brief.text || brief.customerSaid.length > 0 || brief.files.length > 0) && (
              <section className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-gray-800">Customer brief</h2>
                  <span className="text-[11px] text-gray-500">{brief.site} · what the customer sent us (contact details hidden)</span>
                </div>
                {brief.text && <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-gray-800 bg-white rounded-lg border border-indigo-100 p-3 max-h-72 overflow-y-auto">{brief.text}</pre>}
                {brief.customerSaid.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold text-gray-600 mb-1">Customer&apos;s messages</p>
                    <ul className="space-y-1 max-h-60 overflow-y-auto">
                      {brief.customerSaid.map((m, i) => <li key={i} className="text-[13px] text-gray-800 bg-white rounded-lg border border-indigo-100 px-3 py-1.5 whitespace-pre-wrap">{m}</li>)}
                    </ul>
                  </div>
                )}
                {brief.files.length > 0 && (
                  <div>
                    <p className="text-[11px] font-semibold text-gray-600 mb-1">Customer&apos;s files · {brief.files.length}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {brief.files.map((f, i) => (
                        <a key={i} href={f.url} target="_blank" rel="noopener" className="block rounded-lg border border-indigo-100 bg-white p-1.5 hover:border-indigo-400" title={f.name}>
                          {/^image\//.test(f.mime)
                            ? <img src={f.url} alt={f.name} className="h-24 w-full object-contain rounded" />
                            : <div className="h-24 flex items-center justify-center text-[11px] font-semibold text-indigo-700 bg-indigo-50 rounded">{(f.name.split('.').pop() || 'file').toUpperCase()}</div>}
                          <p className="mt-1 truncate text-[11px] text-gray-700">{f.name}</p>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* ── the estimate sheet ────────────────────────────────── */}
            <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
              <div className="flex items-center">
                <h2 className="text-sm font-bold text-gray-800">Estimate</h2>
                {!est && <button type="button" onClick={() => set({ estimate: blankEstimate() })} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Plus size={12} aria-hidden /> Add estimate</button>}
              </div>
              {!est ? (
                <p className="text-xs text-gray-500">No estimate on this job yet.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="col-span-2"><label className={label}>Box style</label><input className={input} value={est.style} placeholder="Tuck end auto bottom" onChange={(e) => setEst({ style: e.target.value })} /></div>
                    <div className="col-span-2">
                      <label className={label}>Size (L × W × H)</label>
                      <div className="flex gap-1.5">
                        {(['length', 'width', 'height'] as const).map((k) => <input key={k} aria-label={k} className={input} value={est[k]} placeholder={k[0].toUpperCase()} onChange={(e) => setEst({ [k]: e.target.value })} />)}
                        <select aria-label="Unit" className="rounded-lg border border-gray-300 bg-white px-1.5 text-sm" value={est.unit} onChange={(e) => setEst({ unit: e.target.value })}>
                          {['in', 'cm', 'mm'].map((u) => <option key={u}>{u}</option>)}
                        </select>
                      </div>
                    </div>
                    <div className="col-span-2"><label className={label}>Material / board</label><input className={input} value={est.material} placeholder="SBS, Kraft, corrugated E-flute, rigid" onChange={(e) => setEst({ material: e.target.value })} /></div>
                    <div><label className={label}>Thickness</label><input className={input} value={est.thickness} placeholder="18pt" onChange={(e) => setEst({ thickness: e.target.value })} /></div>
                    <div><label className={label}>Sides printed</label><input className={input} value={est.sides} placeholder="Outside only" onChange={(e) => setEst({ sides: e.target.value })} /></div>
                    <div className="col-span-2"><label className={label}>Printing</label><input className={input} value={est.printing} placeholder="CMYK / 2 PMS colors" onChange={(e) => setEst({ printing: e.target.value })} /></div>
                    <div className="col-span-2"><label className={label}>Finishing</label><input className={input} value={est.finishing} placeholder="Matte lamination, spot UV, foil" onChange={(e) => setEst({ finishing: e.target.value })} /></div>
                    <div className="col-span-2"><label className={label}>Add-ons</label><input className={input} value={est.addOns} placeholder="Window, insert, handle" onChange={(e) => setEst({ addOns: e.target.value })} /></div>
                    <div><label className={label}>Shipping</label><input className={input} value={est.shipping} placeholder="Included / $" onChange={(e) => setEst({ shipping: e.target.value })} /></div>
                    <div><label className={label}>Turnaround</label><input className={input} value={est.turnaround} placeholder="12-15 days" onChange={(e) => setEst({ turnaround: e.target.value })} /></div>
                    <div className="col-span-2"><label className={label}>Vendor</label><input className={input} value={est.vendor} onChange={(e) => setEst({ vendor: e.target.value })} /></div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead><tr className="text-left text-[11px] uppercase tracking-wide text-gray-500">
                        <th className="py-1.5 pr-2 font-semibold">Quantity</th><th className="py-1.5 pr-2 font-semibold">Unit cost</th><th className="py-1.5 pr-2 font-semibold">Unit price</th>
                        <th className="py-1.5 pr-2 text-right font-semibold">Total cost</th><th className="py-1.5 pr-2 text-right font-semibold">Total price</th><th className="py-1.5 text-right font-semibold">Margin</th><th />
                      </tr></thead>
                      <tbody>
                        {est.tiers.map((t, i) => {
                          const m = tierMath(t)
                          const setT = (p: Partial<typeof t>) => setEst({ tiers: est.tiers.map((x, n) => (n === i ? { ...x, ...p } : x)) })
                          return (
                            <tr key={i} className="border-t border-gray-100">
                              <td className="py-1.5 pr-2"><input aria-label="Quantity" className={input} value={t.quantity} placeholder="500" onChange={(e) => setT({ quantity: e.target.value })} /></td>
                              <td className="py-1.5 pr-2"><input aria-label="Unit cost" className={input} value={t.unitCost} placeholder="0.60" onChange={(e) => setT({ unitCost: e.target.value })} /></td>
                              <td className="py-1.5 pr-2"><input aria-label="Unit price" className={input} value={t.unitPrice} placeholder="0.92" onChange={(e) => setT({ unitPrice: e.target.value })} /></td>
                              <td className="py-1.5 pr-2 text-right tabular-nums text-gray-700">{usd(m.cost)}</td>
                              <td className="py-1.5 pr-2 text-right tabular-nums font-semibold text-gray-800">{usd(m.price)}</td>
                              <td className={`py-1.5 text-right tabular-nums font-semibold ${m.margin === null ? 'text-gray-400' : m.margin < 20 ? 'text-red-700' : 'text-emerald-700'}`}>{m.margin === null ? '—' : `${m.margin}%`}</td>
                              <td className="py-1.5 pl-1">{est.tiers.length > 1 && <button type="button" aria-label="Remove tier" onClick={() => setEst({ tiers: est.tiers.filter((_, n) => n !== i) })} className="text-gray-400 hover:text-red-700"><Trash2 size={13} aria-hidden /></button>}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button type="button" onClick={() => setEst({ tiers: [...est.tiers, { quantity: '', unitCost: '', unitPrice: '' }] })}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"><Plus size={12} aria-hidden /> Add quantity</button>
                </>
              )}
            </section>
          </div>

          {/* ── the conversation ──────────────────────────────────── */}
          <section className="flex max-h-[calc(100vh-180px)] min-h-[420px] flex-col rounded-xl border border-gray-200 bg-white lg:sticky lg:top-20">
            <h2 className="border-b border-gray-100 px-4 py-2.5 text-sm font-bold text-gray-800">Messages</h2>
            <div className="flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
              {messages.length === 0 && <p className="text-xs text-gray-500">No messages yet. Ask a question or share a file link here — everyone on the job sees it.</p>}
              {messages.map((m) => {
                const mineMsg = m.author === me
                return (
                  <div key={m.id} className={`flex flex-col ${mineMsg ? 'items-end' : 'items-start'}`}>
                    <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${mineMsg ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'}`}>{m.body}</div>
                    <span className="mt-0.5 text-[10px] text-gray-500">{nameOf(m.author)} · {timeAgo(m.at)}</span>
                  </div>
                )
              })}
              <div ref={bottom} />
            </div>
            <form onSubmit={send} className="flex items-end gap-2 border-t border-gray-100 p-3">
              <textarea aria-label="Message" rows={2} className={input} value={text} placeholder="Write a message…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(e) } }} />
              <button type="submit" aria-label="Send" className="shrink-0 rounded-lg bg-blue-600 p-2 text-white hover:bg-blue-700"><Send size={15} aria-hidden /></button>
            </form>
          </section>
        </div>
      </div>
    </main>
  )
}
