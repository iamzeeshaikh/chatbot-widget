'use client'

// ZeeDesk's shared pieces: the colours, the small building blocks and the
// contract every screen in app/zd/screens is written against. Nothing here is
// used by the ZeeOps dashboard, and nothing from that dashboard is used here.

import { Bot, X } from 'lucide-react'

export interface Me { email: string; role: string; workspace: string; sites: string[] }

/** What the shell hands every screen. A screen never navigates by URL itself:
 *  it asks the shell, so the rail stays on screen the whole time. */
export interface ZdScreenProps {
  me: Me
  /** Open a lead's full record. `recordId` is the lead's session id, or `quote-<lead id>`. */
  openLead: (recordId: string) => void
  /** Open a live chat in the Chats section. */
  openChat: (sessionId: string) => void
}

// The palette. Use these, not Tailwind's gray/blue scale, so every screen
// reads as one product.
export const KALE = '#03363d'       // rail, strong headings on tinted ground
export const KALE_2 = '#17494d'     // rail hover / active
export const BLUE = '#1f73b7'       // primary action, links, selection
export const BLUE_DARK = '#144a75'  // primary hover
export const INK = '#2f3941'        // body text
export const INK_2 = '#49545c'      // secondary text
export const MUTED = '#68737d'      // labels, hints
export const FAINT = '#87929d'      // timestamps, placeholders
export const LINE = '#d8dcde'       // borders
export const LINE_2 = '#e9ebed'     // row dividers, quiet fills
export const GROUND = '#f8f9f9'     // panel background
export const TINT = '#edf7ff'       // selected row
export const RED = '#cc3340'
export const ORANGE = '#e34f32'
export const GREEN = '#038153'
export const AMBER = '#ad5918'

export const short = (email: string | null | undefined) => (email ? email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '')
export const initials = (s: string) => (s.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?').toUpperCase()
export const postJson = (body: unknown, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'POST'): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function Avatar({ label, tone = 'visitor', size = 32 }: { label: string; tone?: 'visitor' | 'agent' | 'bot'; size?: number }) {
  const bg = tone === 'agent' ? BLUE : tone === 'bot' ? MUTED : '#2f5f62'
  return (
    <span className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0 select-none"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: Math.round(size * 0.38) }} aria-hidden>
      {tone === 'bot' ? <Bot size={Math.round(size * 0.55)} /> : initials(label)}
    </span>
  )
}

/** The title strip at the top of a full-width screen. `actions` sit on the right. */
export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="px-6 pt-5 pb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold">{title}</h1>
        {sub && <p className="text-[13px] text-[#68737d]">{sub}</p>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Empty({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-[#d8dcde] bg-[#f8f9f9] px-5 py-8 text-center text-[13px] text-[#68737d]">{text}</p>
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#d8dcde] overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead><tr className="bg-[#f8f9f9] text-left text-[11px] uppercase tracking-wide text-[#68737d]">{head.map((h) => <th key={h} className="px-4 py-2.5 font-semibold whitespace-nowrap">{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Td({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <td className={`px-4 py-2.5 max-w-[260px] truncate ${strong ? 'font-medium text-[#2f3941]' : 'text-[#49545c]'}`}>{children}</td>
}

// Buttons: one primary per view, the rest plain.
export const BTN_PRIMARY = 'h-8 px-3 rounded-md bg-[#1f73b7] text-white text-[13px] font-medium inline-flex items-center gap-1.5 hover:bg-[#144a75] disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40'
export const BTN_PLAIN = 'h-8 px-3 rounded-md border border-[#d8dcde] bg-white text-[13px] text-[#2f3941] inline-flex items-center gap-1.5 hover:bg-[#f8f9f9] disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40'
export const BTN_DANGER = 'h-8 px-3 rounded-md border border-[#cc3340] bg-white text-[13px] text-[#cc3340] inline-flex items-center gap-1.5 hover:bg-[#fff0f1] disabled:opacity-40'
export const INPUT = 'h-9 w-full px-2.5 rounded-md bg-white border border-[#d8dcde] text-[13px] text-[#2f3941] outline-none focus:border-[#1f73b7] placeholder:text-[#87929d]'
export const TEXTAREA = 'w-full px-2.5 py-2 rounded-md bg-white border border-[#d8dcde] text-[13px] leading-5 text-[#2f3941] outline-none focus:border-[#1f73b7] placeholder:text-[#87929d]'
export const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-[#68737d] mb-1'
export const CARD = 'rounded-lg border border-[#d8dcde] bg-white'

/** A small coloured label. */
export function Chip({ children, tone = 'grey' }: { children: React.ReactNode; tone?: 'grey' | 'blue' | 'green' | 'red' | 'amber' }) {
  const cls = tone === 'blue' ? 'bg-[#dceefb] text-[#144a75]' : tone === 'green' ? 'bg-[#edf8f4] text-[#038153]' : tone === 'red' ? 'bg-[#fff0f1] text-[#cc3340]' : tone === 'amber' ? 'bg-[#fff3e4] text-[#ad5918]' : 'bg-[#e9ebed] text-[#49545c]'
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${cls}`}>{children}</span>
}

/** A panel that slides in from the right, for forms and details. Esc and the
 *  dimmed ground both close it. */
export function Drawer({ title, onClose, children, footer, width = 440 }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: number }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-[#2f3941]/30 cursor-default" onClick={onClose} />
      <div className="relative h-full bg-white border-l border-[#d8dcde] shadow-xl flex flex-col max-w-full" style={{ width }}>
        <div className="h-[56px] shrink-0 px-5 flex items-center border-b border-[#d8dcde]">
          <p className="font-semibold text-[15px] truncate">{title}</p>
          <button type="button" onClick={onClose} className="ml-auto w-8 h-8 rounded flex items-center justify-center hover:bg-[#e9ebed]" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]">{children}</div>
        {footer && <div className="shrink-0 px-5 py-3 border-t border-[#d8dcde] bg-[#f8f9f9] flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

/** A line of feedback under an action: red for a failure, grey otherwise. */
export function Notice({ text, bad }: { text: string; bad?: boolean }) {
  if (!text) return null
  return <p role={bad ? 'alert' : 'status'} className={`text-[12px] ${bad ? 'text-[#cc3340]' : 'text-[#68737d]'}`}>{text}</p>
}
