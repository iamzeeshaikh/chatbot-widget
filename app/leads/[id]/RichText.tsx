'use client'

// A small formatted-text box for the email composer.
//
// contenteditable, not a library. The formatting an agent actually needs in a
// sales reply is bold, italic, a list and a link — a full editor dependency
// would be several hundred kilobytes for that, and every one of them wants to
// own its own document model.
//
// THE CARET PROBLEM, and why this is not a controlled input: writing
// `innerHTML` on every keystroke resets the selection to the start of the
// element, so the cursor jumps to the top of the box on every character. The
// DOM is therefore left alone while the user types, and is only written when
// the value arrives from OUTSIDE — the signature being inserted, or a restored
// draft. `emitted` is how those two cases are told apart: anything we just
// reported upwards comes back to us unchanged and is ignored.

import { useEffect, useRef, useState } from 'react'
import { Bold, Italic, Underline, List, ListOrdered, Link2, Eraser } from 'lucide-react'

export default function RichText({ html, onChange, placeholder, onDropFiles, dragging, onDragStateChange }: {
  html: string
  onChange: (html: string, text: string) => void
  placeholder?: string
  onDropFiles?: (files: File[]) => void
  dragging?: boolean
  onDragStateChange?: (dragging: boolean) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const emitted = useRef('')
  const [linking, setLinking] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const savedRange = useRef<Range | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (html === emitted.current) return   // our own value coming back
    if (el.innerHTML === html) return
    el.innerHTML = html
  }, [html])

  function emit() {
    const el = ref.current
    if (!el) return
    const next = el.innerHTML
    emitted.current = next
    onChange(next, el.innerText)
  }

  // execCommand is deprecated and still the only thing every browser
  // implements for this. The alternative is owning selection handling by hand,
  // which is a great deal of code to get subtly wrong.
  function run(cmd: string, value?: string) {
    ref.current?.focus()
    document.execCommand(cmd, false, value)
    emit()
  }

  function openLink() {
    const sel = window.getSelection()
    // The selection is lost the moment focus moves to the URL box, so it is
    // remembered here and restored before the link is applied.
    savedRange.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null
    setLinkUrl('')
    setLinking(true)
  }

  function applyLink() {
    const url = linkUrl.trim()
    setLinking(false)
    if (!url) return
    const href = /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url}`
    const el = ref.current
    if (!el) return
    el.focus()
    if (savedRange.current) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(savedRange.current)
    }
    // With nothing selected there is nothing to turn into a link, so the URL
    // is inserted as its own text and linked — which is what people expect
    // when they click Link with the caret in empty space.
    if (savedRange.current?.collapsed) document.execCommand('insertText', false, url)
    const sel = window.getSelection()
    if (sel && sel.isCollapsed && savedRange.current?.collapsed) {
      // Select the text we just inserted so createLink has a target.
      const node = sel.focusNode
      if (node) {
        const r = document.createRange()
        r.setStart(node, Math.max(0, sel.focusOffset - url.length))
        r.setEnd(node, sel.focusOffset)
        sel.removeAllRanges()
        sel.addRange(r)
      }
    }
    document.execCommand('createLink', false, href)
    emit()
  }

  const btn = 'w-7 h-7 inline-flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-200 hover:text-gray-900 transition-colors'

  return (
    <div className={`border-t transition-colors ${dragging ? 'border-t-blue-400 bg-blue-50' : 'border-t-gray-200'}`}>
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-gray-200 bg-gray-100/70 flex-wrap">
        {/* onMouseDown + preventDefault, not onClick: a click moves focus out
            of the editable area first, which collapses the selection the
            command was meant to act on. */}
        <button type="button" className={btn} title="Bold (⌘B)" aria-label="Bold"
          onMouseDown={(e) => { e.preventDefault(); run('bold') }}><Bold size={14} strokeWidth={2.5} aria-hidden /></button>
        <button type="button" className={btn} title="Italic (⌘I)" aria-label="Italic"
          onMouseDown={(e) => { e.preventDefault(); run('italic') }}><Italic size={14} strokeWidth={2.5} aria-hidden /></button>
        <button type="button" className={btn} title="Underline (⌘U)" aria-label="Underline"
          onMouseDown={(e) => { e.preventDefault(); run('underline') }}><Underline size={14} strokeWidth={2.5} aria-hidden /></button>
        <span className="w-px h-4 bg-gray-300 mx-1" aria-hidden />
        <button type="button" className={btn} title="Bulleted list" aria-label="Bulleted list"
          onMouseDown={(e) => { e.preventDefault(); run('insertUnorderedList') }}><List size={14} strokeWidth={2.5} aria-hidden /></button>
        <button type="button" className={btn} title="Numbered list" aria-label="Numbered list"
          onMouseDown={(e) => { e.preventDefault(); run('insertOrderedList') }}><ListOrdered size={14} strokeWidth={2.5} aria-hidden /></button>
        <span className="w-px h-4 bg-gray-300 mx-1" aria-hidden />
        <button type="button" className={btn} title="Add a link" aria-label="Add a link"
          onMouseDown={(e) => { e.preventDefault(); openLink() }}><Link2 size={14} strokeWidth={2.5} aria-hidden /></button>
        <button type="button" className={btn} title="Clear formatting" aria-label="Clear formatting"
          onMouseDown={(e) => { e.preventDefault(); run('removeFormat') }}><Eraser size={14} strokeWidth={2.5} aria-hidden /></button>
      </div>

      {linking && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 bg-white">
          <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } if (e.key === 'Escape') setLinking(false) }}
            placeholder="https://example.com" aria-label="Link address"
            className="flex-1 bg-gray-100 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-blue-500" />
          <button type="button" onMouseDown={(e) => { e.preventDefault(); applyLink() }}
            className="px-2.5 py-1.5 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors">Add</button>
          <button type="button" onMouseDown={(e) => { e.preventDefault(); setLinking(false) }}
            className="px-2 py-1.5 text-[11px] text-gray-500 hover:text-gray-800">Cancel</button>
        </div>
      )}

      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        data-placeholder={placeholder ?? 'Write your message…'}
        onInput={emit}
        // Paste as PLAIN text. Copying from a website otherwise drags its
        // fonts, colours and background into the email, and the result looks
        // like a forwarded advert rather than a reply from a person.
        onPaste={(e) => {
          e.preventDefault()
          const t = e.clipboardData.getData('text/plain')
          document.execCommand('insertText', false, t)
          emit()
        }}
        onDragOver={(e) => { e.preventDefault(); onDragStateChange?.(true) }}
        onDragLeave={() => onDragStateChange?.(false)}
        onDrop={(e) => { e.preventDefault(); onDragStateChange?.(false); onDropFiles?.([...e.dataTransfer.files]) }}
        className="rt-body w-full min-h-[220px] max-h-[46vh] overflow-y-auto bg-transparent px-3 py-2.5 text-xs text-gray-900 focus:outline-none leading-relaxed"
      />
      <style>{`
        .rt-body:empty:before { content: attr(data-placeholder); color: #9ca3af; }
        .rt-body ul { list-style: disc; padding-left: 1.25rem; margin: 0.25rem 0; }
        .rt-body ol { list-style: decimal; padding-left: 1.25rem; margin: 0.25rem 0; }
        .rt-body a { color: #1d4ed8; text-decoration: underline; }
      `}</style>
    </div>
  )
}
