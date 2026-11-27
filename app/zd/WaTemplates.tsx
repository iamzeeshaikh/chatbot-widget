'use client'

// ZeeDesk: send a WhatsApp template when the 24-hour reply window is shut.
//
// WhatsApp refuses a free message more than a day after the customer last
// wrote, and before they have written at all. A template (a text WhatsApp has
// approved) is the one thing it will deliver then. The three texts live in
// lib/watemplates.ts and are registered on ZeeDesk's own WhatsApp account;
// only those WhatsApp reports as approved can be sent.

import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { BTN_PLAIN, BTN_PRIMARY, Chip, Notice, postJson } from './ui'

interface Tpl { name: string; label: string; status: 'approved' | 'pending' | 'rejected' | 'unknown'; preview: string }

export default function WaTemplates({ leadId, onSent }: { leadId: string; onSent: () => void }) {
  const [list, setList] = useState<Tpl[] | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null)
  const api = `/api/leads/${encodeURIComponent(leadId)}/whatsapp/template`

  useEffect(() => {
    let alive = true
    fetch(api).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setList(d?.templates ?? []) }).catch(() => { if (alive) setList([]) })
    return () => { alive = false }
  }, [api])

  if (list === null) return <p className="mb-2 text-[12px] text-[#68737d]">Checking the approved messages…</p>
  if (!list.length) return null
  const ready = list.filter((t) => t.status === 'approved')
  const waiting = list.filter((t) => t.status === 'pending' || t.status === 'unknown').length
  const chosen = ready.find((t) => t.name === pick) ?? null

  async function send() {
    if (!chosen || busy) return
    setBusy(true); setNote(null)
    try {
      const res = await fetch(api, postJson({ name: chosen.name }))
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setNote({ text: typeof d.error === 'string' ? d.error : 'WhatsApp did not take the message.', bad: true }); return }
      setPick(''); setNote({ text: 'Sent. When the customer replies you can write to them freely for 24 hours.', bad: false })
      onSent()
    } catch { setNote({ text: 'The message could not be sent. Check your connection and try again.', bad: true }) } finally { setBusy(false) }
  }

  return (
    <div className="mb-2 rounded-md border border-[#d8dcde] bg-white px-3 py-2.5">
      <p className="text-[12px] font-semibold text-[#2f3941]">Send an approved message instead</p>
      {ready.length === 0 ? (
        <p className="mt-1 text-[12px] text-[#68737d]">{waiting ? 'WhatsApp is still reviewing these messages. They can be sent as soon as it approves them, usually within a day.' : 'WhatsApp has not approved any message for this line.'}</p>
      ) : (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Approved messages">
            {ready.map((t) => (
              <button key={t.name} type="button" role="radio" aria-checked={pick === t.name} onClick={() => { setPick(t.name); setNote(null) }}
                className={`h-8 px-3 rounded-md border text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 ${pick === t.name ? 'border-[#1f73b7] bg-[#edf7ff] text-[#144a75] font-medium' : 'border-[#d8dcde] bg-white text-[#2f3941] hover:bg-[#f8f9f9]'}`}>
                {t.label}
              </button>
            ))}
            {waiting > 0 && <Chip tone="amber">{waiting} more in review</Chip>}
          </div>
          {chosen && (
            <div className="mt-2">
              <p className="rounded-md bg-[#f8f9f9] px-3 py-2 text-[13px] leading-5 text-[#2f3941]">{chosen.preview}</p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" onClick={() => void send()} disabled={busy} className={BTN_PRIMARY}><Send size={14} aria-hidden />{busy ? 'Sending…' : 'Send this message'}</button>
                <button type="button" onClick={() => setPick('')} disabled={busy} className={BTN_PLAIN}>Cancel</button>
                <span className="text-[11px] text-[#68737d]">The wording is fixed: WhatsApp only delivers it exactly as approved.</span>
              </div>
            </div>
          )}
        </>
      )}
      {note && <div className="mt-1.5"><Notice text={note.text} bad={note.bad} /></div>}
    </div>
  )
}
