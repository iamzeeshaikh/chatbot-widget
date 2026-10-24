'use client'
// What the quote bot has learned from the team (lib/botlearn.ts). Learned
// nightly from drafts agents edited or discarded and emails they wrote
// themselves; the owner can add a lesson of their own or remove a wrong one.
import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, RefreshCw, Trash2 } from 'lucide-react'

interface Lesson { id: string; text: string; from: 'edited' | 'discarded' | 'human' | 'owner'; at: string; evidence?: string }
interface Lessons { lessons: Lesson[]; at: string; by: string; learnedFrom?: { edited: number; discarded: number; human: number } }

const FROM: Record<Lesson['from'], string> = { edited: 'from an edited draft', discarded: 'from a discarded draft', human: "from the team's own emails", owner: 'added by you' }
const FROM_STYLE: Record<Lesson['from'], string> = {
  edited: 'bg-amber-100 text-amber-700 border-amber-300', discarded: 'bg-red-100 text-red-700 border-red-300',
  human: 'bg-blue-100 text-blue-700 border-blue-300', owner: 'bg-green-100 text-green-700 border-green-300',
}

export default function BotLessonsPage() {
  const [data, setData] = useState<Lessons | null>(null)
  const [err, setErr] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')

  const load = () => fetch('/api/crm/bot-learn?list=1').then(async (r) => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error || 'Admins only'); return }
    setData(j)
  })
  useEffect(() => {
    try { document.documentElement.classList.toggle('dark', localStorage.getItem('zee-dash-theme') === 'dark') } catch { /* ignore */ }
    void load()
  }, [])

  async function post(body: unknown) {
    const r = await fetch('/api/crm/bot-learn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { setErr(j.error || 'Could not save'); return false }
    setData(j); setErr(''); return true
  }
  async function learnNow() {
    setBusy('learn'); setErr('')
    const r = await fetch('/api/crm/bot-learn?hours=72')
    const j = await r.json().catch(() => ({}))
    setBusy('')
    if (!r.ok || j.ok === false) { setErr(j.why || j.error || 'Learning failed'); return }
    await load()
  }

  return (
    <main className="min-h-screen bg-gray-100">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <a href="/opportunities" aria-label="Back" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"><ArrowLeft size={16} aria-hidden /></a>
          <div>
            <h1 className="text-base font-bold text-gray-900">What the bot has learned</h1>
            <p className="text-xs text-gray-500">Every night at 2 AM the bot reads the drafts you edited or threw away and the emails you wrote yourselves, and turns them into lessons for its next drafts. The hard rules (no prices, no promises) always win.</p>
          </div>
          <button type="button" onClick={() => void learnNow()} disabled={busy === 'learn'}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw size={14} aria-hidden className={busy === 'learn' ? 'animate-spin' : ''} /> {busy === 'learn' ? 'Learning…' : 'Learn now (last 3 days)'}
          </button>
        </div>
      </header>
      <div className="max-w-4xl mx-auto p-4 space-y-3">
        {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
        <form className="rounded-xl border border-gray-200 bg-white p-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await post({ action: 'add', text })) setText('') }}>
          <input value={text} onChange={(e) => setText(e.target.value)} className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
            placeholder="Teach it yourself, e.g. For candle shipping boxes, always ask how many candles go in one box." />
          <button type="submit" className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"><Plus size={14} aria-hidden /> Add</button>
        </form>
        {data && (
          <p className="text-xs text-gray-500">
            {data.lessons.length} lesson{data.lessons.length === 1 ? '' : 's'}
            {data.learnedFrom ? ` · last learned from ${data.learnedFrom.edited} edited drafts, ${data.learnedFrom.discarded} discarded drafts and ${data.learnedFrom.human} team emails` : ''}
          </p>
        )}
        <ul className="space-y-2">
          {(data?.lessons ?? []).map((l) => (
            <li key={l.id} className="rounded-xl border border-gray-200 bg-white p-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-900">{l.text}</p>
                <p className="mt-1 text-[11px] text-gray-500">
                  <span className={`inline-block rounded-full border px-2 py-0.5 font-semibold ${FROM_STYLE[l.from]}`}>{FROM[l.from]}</span>
                  {l.evidence ? <span className="ml-2">{l.evidence}</span> : null}
                </p>
              </div>
              <button type="button" aria-label="Remove this lesson" onClick={() => void post({ action: 'remove', id: l.id })}
                className="p-1.5 rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-700"><Trash2 size={15} aria-hidden /></button>
            </li>
          ))}
        </ul>
        {data && data.lessons.length === 0 && <p className="text-sm text-gray-500">Nothing learned yet. Press “Learn now”.</p>}
      </div>
    </main>
  )
}
