'use client'

// ZeeDesk's formatted-text box, shared by the Inbox composer and the lead
// record's email tab so the two cannot drift.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bold, Eraser, Italic, Link2, List, ListOrdered, Underline } from 'lucide-react'
import { BTN_PLAIN, BTN_PRIMARY } from './ui'

// ── The message box: bold, italic, lists and links, nothing more ────────────
//
// It is not a controlled input. Writing innerHTML on every keystroke would
// throw the caret back to the start, so the box is only written to when the
// value arrives from outside (a restored draft). `emitted` tells the two
// apart: whatever was just reported upwards comes back unchanged and is ignored.

export default function RichEditor({ html, onChange, onDropFiles, onDragStateChange, placeholder = 'Write your message' }: {
  html: string
  onChange: (html: string, text: string) => void
  onDropFiles: (files: File[]) => void
  onDragStateChange: (dragging: boolean) => void
  placeholder?: string
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const emitted = useRef('')
  const savedRange = useRef<Range | null>(null)
  const [linking, setLinking] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  useEffect(() => {
    const el = box.current
    if (!el || html === emitted.current || el.innerHTML === html) return
    el.innerHTML = html
  }, [html])

  function emit() {
    const el = box.current
    if (!el) return
    emitted.current = el.innerHTML
    onChange(el.innerHTML, el.innerText)
  }
  function run(cmd: string, value?: string) {
    box.current?.focus()
    document.execCommand(cmd, false, value)
    emit()
  }
  function openLink() {
    // The selection is lost the moment focus moves to the address box, so it is kept here.
    const sel = window.getSelection()
    savedRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    setLinkUrl(''); setLinking(true)
  }
  function applyLink() {
    const url = linkUrl.trim()
    setLinking(false)
    const el = box.current
    if (!url || !el) return
    const href = /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url}`
    el.focus()
    const range = savedRange.current
    const sel = window.getSelection()
    if (range && sel) { sel.removeAllRanges(); sel.addRange(range) }
    // With nothing selected the address itself is typed in and then linked.
    if (!range || range.collapsed) {
      document.execCommand('insertText', false, url)
      const after = window.getSelection()
      const node = after?.focusNode
      if (after && node) {
        const r = document.createRange()
        r.setStart(node, Math.max(0, after.focusOffset - url.length))
        r.setEnd(node, after.focusOffset)
        after.removeAllRanges(); after.addRange(r)
      }
    }
    document.execCommand('createLink', false, href)
    emit()
  }

  return (
    <div>
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-[#e9ebed] bg-[#f8f9f9]" role="toolbar" aria-label="Formatting">
        <ToolButton label="Bold" onAct={() => run('bold')}><Bold size={14} aria-hidden /></ToolButton>
        <ToolButton label="Italic" onAct={() => run('italic')}><Italic size={14} aria-hidden /></ToolButton>
        <ToolButton label="Underline" onAct={() => run('underline')}><Underline size={14} aria-hidden /></ToolButton>
        <span className="w-px h-4 bg-[#d8dcde] mx-1" aria-hidden />
        <ToolButton label="Bulleted list" onAct={() => run('insertUnorderedList')}><List size={14} aria-hidden /></ToolButton>
        <ToolButton label="Numbered list" onAct={() => run('insertOrderedList')}><ListOrdered size={14} aria-hidden /></ToolButton>
        <span className="w-px h-4 bg-[#d8dcde] mx-1" aria-hidden />
        <ToolButton label="Add a link" onAct={openLink}><Link2 size={14} aria-hidden /></ToolButton>
        <ToolButton label="Clear formatting" onAct={() => run('removeFormat')}><Eraser size={14} aria-hidden /></ToolButton>
      </div>
      {linking && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[#e9ebed]">
          <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://example.com" aria-label="Link address"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); applyLink() } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLinking(false) } }}
            className="flex-1 min-w-0 h-8 px-2.5 rounded-md border border-[#d8dcde] text-[13px] outline-none focus:border-[#1f73b7] placeholder:text-[#87929d]" />
          <button type="button" onClick={applyLink} className={BTN_PRIMARY}>Add link</button>
          <button type="button" onClick={() => setLinking(false)} className={BTN_PLAIN}>Cancel</button>
        </div>
      )}
      <div ref={box} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message"
        data-placeholder={placeholder}
        onInput={emit}
        // Pasted as plain text: copying from a website would otherwise drag its fonts and colors into the email.
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); emit() }}
        onDragOver={(e) => { e.preventDefault(); onDragStateChange(true) }}
        onDragLeave={() => onDragStateChange(false)}
        onDrop={(e) => { e.preventDefault(); onDragStateChange(false); onDropFiles([...e.dataTransfer.files]) }}
        className="min-h-[110px] max-h-[32vh] overflow-y-auto px-3 py-2.5 text-[14px] leading-[1.55] text-[#2f3941] outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-[#87929d] [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-[#1f73b7] [&_a]:underline [scrollbar-width:thin]" />
    </div>
  )
}

// onMouseDown with preventDefault, not onClick: a click would move focus out
// of the message first and lose the selection the command acts on.
function ToolButton({ label, onAct, children }: { label: string; onAct: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label}
      onMouseDown={(e) => { e.preventDefault(); onAct() }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAct() } }}
      className="w-7 h-7 inline-flex items-center justify-center rounded text-[#49545c] hover:bg-[#e9ebed] outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40">{children}</button>
  )
}
