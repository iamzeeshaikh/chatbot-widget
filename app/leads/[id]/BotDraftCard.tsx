'use client'
// The quote bot's email, waiting for a person (lib/botdraft.ts). Sits above
// the timeline so it is the first thing the agent sees on the record.
import { useEffect, useState } from 'react'
import { Bot, Send, Trash2 } from 'lucide-react'
import type { BotDraft } from '@/lib/botdraft'
import { formatShortDateTime } from '@/lib/datetime'

export default function BotDraftCard({ leadId, draft, onDone }: { leadId: string; draft: BotDraft; onDone: () => void }) {
  const [text, setText] = useState(draft.text)
  const [subject, setSubject] = useState(draft.subject)
  const [cc, setCc] = useState(draft.cc ?? '')
  const [busy, setBusy] = useState<'send' | 'discard' | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { setText(draft.text); setSubject(draft.subject); setCc(draft.cc ?? ''); setErr('') }, [draft.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function decide(action: 'send' | 'discard') {
    if (action === 'discard' && !window.confirm('Discard the bot\'s draft? The bot will not write to this customer again; you can still email them yourself.')) return
    setBusy(action); setErr('')
    const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/bot-draft`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draftId: draft.id, action, text, subject, cc }),
    })
    const j = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setErr(j.error || 'That did not work'); return }
    onDone()
  }

  return (
    <section className="mb-3 rounded-xl border border-amber-300 bg-amber-50 shadow-sm">
      <header className="px-4 py-2.5 border-b border-amber-200 flex items-center gap-2">
        <Bot size={16} strokeWidth={2} className="text-amber-700" aria-hidden />
        <h2 className="text-[13px] font-bold text-amber-900">
          {draft.step === 'first' ? 'Draft first reply' : 'Draft answer to the customer\'s reply'} — not sent yet
        </h2>
        <span className="ml-auto text-[11px] text-amber-800">drafted {formatShortDateTime(draft.at)} · from {draft.from}</span>
      </header>
      <div className="px-4 py-3 space-y-2">
        <p className="text-[12px] text-amber-900">
          The bot read the enquiry and wrote this for you. Check it, change anything you like, then send — it goes from {draft.agent.split('@')[0]}&apos;s mailbox as {draft.from}, with the usual signature.
          {draft.complete ? ' The customer gave every detail; your price quote comes next.' : draft.missing.length ? ` It asks for: ${draft.missing.join(', ')}.` : ''}
        </p>
        <label className="block text-[11px] font-semibold text-amber-900">Cc <span className="font-normal">(people the customer copied — remove anyone who should not get it)</span>
          <input value={cc} onChange={(e) => setCc(e.target.value)} placeholder="nobody"
            className="mt-0.5 w-full rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-400" />
        </label>
        <label className="block text-[11px] font-semibold text-amber-900">Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-0.5 w-full rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-400" />
        </label>
        <label className="block text-[11px] font-semibold text-amber-900">Message
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, Math.max(6, text.split('\n').length + 1))}
            className="mt-0.5 w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-[13px] leading-relaxed text-gray-900 focus:outline-none focus:ring-2 focus:ring-amber-400" />
        </label>
        {err && <p className="text-[12px] text-red-700" role="alert">{err}</p>}
        <div className="flex items-center gap-2 pt-1">
          <button type="button" disabled={!!busy || !text.trim()} onClick={() => void decide('send')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            <Send size={14} aria-hidden /> {busy === 'send' ? 'Sending…' : 'Send to customer'}
          </button>
          <button type="button" disabled={!!busy} onClick={() => void decide('discard')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50">
            <Trash2 size={14} aria-hidden /> Discard
          </button>
          <span className="text-[11px] text-amber-800">To: {draft.to}</span>
        </div>
      </div>
    </section>
  )
}
