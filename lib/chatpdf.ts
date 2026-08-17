// A conversation as a PDF — the format people actually forward to a client or
// keep on file. Mirrors the HTML download's layout: day dividers, left/right
// bubbles, lead-capture markers, images embedded inline.
//
// Same WinAnsi constraint as lib/leadspdf.ts: pdf-lib's StandardFonts cannot
// encode emoji or non-Latin scripts, so unencodable characters are stripped
// rather than risked mid-render. A message that is ENTIRELY unencodable (an
// Urdu sentence, a lone emoji) is shown as a placeholder pointing at the HTML
// download, which renders everything — never silently dropped.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib'

export type ChatItem =
  | { kind: 'day'; label: string }
  | { kind: 'marker'; text: string }
  | { kind: 'msg'; side: 'left' | 'right'; who: string; time: string; text: string }
  | { kind: 'file'; side: 'left' | 'right'; who: string; time: string; name: string; url: string; mime: string }

const PAGE = { w: 595.28, h: 841.89 } // portrait A4 — a transcript reads top-to-bottom
const MARGIN = 40
const FOOTER = 26 // reserved band under the content for the page label

const INK = rgb(0.10, 0.12, 0.16)
const MUTED = rgb(0.45, 0.50, 0.58)
const RULE = rgb(0.86, 0.88, 0.91)
const BAND = rgb(0.93, 0.94, 0.96)
const AGENT_BG = rgb(0.86, 0.92, 0.99)
const AGENT_BORDER = rgb(0.75, 0.86, 0.98)
const GREEN = rgb(0.02, 0.47, 0.34)
const ACCENT = rgb(0.15, 0.39, 0.92)

const BUBBLE_MAX = 350
const PAD = 8
const TEXT_SIZE = 9
const LINE_H = 12
const META_SIZE = 7

// Same cap as the HTML export: one huge upload must not balloon the file.
const MAX_EMBED_BYTES = 8 * 1024 * 1024
const IMG_MAX_W = 280
const IMG_MAX_H = 240

interface Ctx { doc: PDFDocument; font: PDFFont; bold: PDFFont; pages: PDFPage[]; page: PDFPage; y: number }

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE.w, PAGE.h])
  ctx.pages.push(ctx.page)
  ctx.y = PAGE.h - MARGIN
}

function winAnsi(s: string): string {
  return s.replace(/[^\x20-\x7E£€–—’‘“”]/g, '')
}

/** Word-wrap that also hard-breaks a single over-wide word (a long URL). */
function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const rawLine of s.split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).map(winAnsi).filter(Boolean)
    if (words.length === 0) continue
    let line = ''
    for (let w of words) {
      while (font.widthOfTextAtSize(w, size) > width) {
        if (line) { lines.push(line); line = '' }
        let cut = w.length - 1
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--
        lines.push(w.slice(0, cut))
        w = w.slice(cut)
      }
      const next = line ? `${line} ${w}` : w
      if (font.widthOfTextAtSize(next, size) > width && line) { lines.push(line); line = w }
      else line = next
    }
    if (line) lines.push(line)
  }
  return lines
}

function ensureRoom(ctx: Ctx, need: number) {
  if (ctx.y - need < MARGIN + FOOTER) newPage(ctx)
}

function widest(lines: string[], font: PDFFont, size: number): number {
  return lines.reduce((m, l) => Math.max(m, font.widthOfTextAtSize(l, size)), 0)
}

/**
 * One chunk of bubble: meta line + up to `lines` of body. Splitting a very
 * long message into several chunks is the caller's job (drawTextBubble).
 */
function drawBubbleChunk(ctx: Ctx, side: 'left' | 'right', meta: string, lines: string[], color = INK) {
  const metaW = ctx.bold.widthOfTextAtSize(meta, META_SIZE)
  const w = Math.min(BUBBLE_MAX, Math.max(metaW, widest(lines, ctx.font, TEXT_SIZE))) + PAD * 2
  const h = PAD + META_SIZE + lines.length * LINE_H + PAD
  const x = side === 'left' ? MARGIN : PAGE.w - MARGIN - w
  const yTop = ctx.y
  ctx.page.drawRectangle({
    x, y: yTop - h, width: w, height: h,
    color: side === 'left' ? rgb(1, 1, 1) : AGENT_BG,
    borderColor: side === 'left' ? RULE : AGENT_BORDER,
    borderWidth: 0.6,
  })
  ctx.page.drawText(meta, { x: x + PAD, y: yTop - PAD - META_SIZE, size: META_SIZE, font: ctx.bold, color: MUTED })
  let ty = yTop - PAD - META_SIZE - LINE_H + 2
  for (const line of lines) {
    ctx.page.drawText(line, { x: x + PAD, y: ty, size: TEXT_SIZE, font: ctx.font, color })
    ty -= LINE_H
  }
  ctx.y = yTop - h - 6
}

function drawTextBubble(ctx: Ctx, side: 'left' | 'right', meta: string, text: string) {
  let lines = wrap(text, ctx.font, TEXT_SIZE, BUBBLE_MAX)
  let color = INK
  if (lines.length === 0 && text.trim()) {
    // The whole message was outside WinAnsi (emoji / non-Latin script).
    lines = ['(message not shown — characters this PDF cannot render; use the HTML download)']
    color = MUTED
  }
  // A message longer than a page flows across pages in continuation bubbles.
  const perPage = Math.max(1, Math.floor((PAGE.h - MARGIN * 2 - FOOTER - PAD * 2 - META_SIZE) / LINE_H))
  let first = true
  while (lines.length > 0) {
    const room = Math.max(0, Math.floor((ctx.y - MARGIN - FOOTER - PAD * 2 - META_SIZE) / LINE_H))
    let take = Math.min(lines.length, room > 0 ? room : 0)
    if (take < 1) { newPage(ctx); take = Math.min(lines.length, perPage) }
    drawBubbleChunk(ctx, side, first ? meta : `${meta} (continued)`, lines.slice(0, take), color)
    lines = lines.slice(take)
    first = false
  }
}

async function embedImage(doc: PDFDocument, url: string, mime: string): Promise<PDFImage | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_EMBED_BYTES) return null
    if (/jpe?g/i.test(mime)) return await doc.embedJpg(buf)
    if (/png/i.test(mime)) return await doc.embedPng(buf)
    // Unknown image mime (webp arrives as octet-stream sometimes) — sniff both.
    try { return await doc.embedPng(buf) } catch { return await doc.embedJpg(buf) }
  } catch {
    return null
  }
}

function drawFileBubble(ctx: Ctx, side: 'left' | 'right', meta: string, name: string, url: string, image: PDFImage | null) {
  if (image) {
    const scale = Math.min(IMG_MAX_W / image.width, IMG_MAX_H / image.height, 1)
    const iw = image.width * scale
    const ih = image.height * scale
    const w = Math.max(iw, ctx.bold.widthOfTextAtSize(meta, META_SIZE)) + PAD * 2
    const h = PAD + META_SIZE + 5 + ih + PAD
    ensureRoom(ctx, h)
    const x = side === 'left' ? MARGIN : PAGE.w - MARGIN - w
    const yTop = ctx.y
    ctx.page.drawRectangle({
      x, y: yTop - h, width: w, height: h,
      color: side === 'left' ? rgb(1, 1, 1) : AGENT_BG,
      borderColor: side === 'left' ? RULE : AGENT_BORDER,
      borderWidth: 0.6,
    })
    ctx.page.drawText(meta, { x: x + PAD, y: yTop - PAD - META_SIZE, size: META_SIZE, font: ctx.bold, color: MUTED })
    ctx.page.drawImage(image, { x: x + PAD, y: yTop - PAD - META_SIZE - 5 - ih, width: iw, height: ih })
    ctx.y = yTop - h - 6
    return
  }
  // Not embeddable (a PDF attachment, an oversized or unsupported image):
  // name plus the bucket URL, which stays valid — same policy as the HTML file.
  const safeName = winAnsi(name) || 'attachment'
  const nameLine = `Attachment: ${safeName}`
  const urlLines = wrap(url, ctx.font, META_SIZE, BUBBLE_MAX)
  const metaW = ctx.bold.widthOfTextAtSize(meta, META_SIZE)
  const w = Math.min(BUBBLE_MAX, Math.max(metaW, ctx.font.widthOfTextAtSize(nameLine, TEXT_SIZE), widest(urlLines, ctx.font, META_SIZE))) + PAD * 2
  const h = PAD + META_SIZE + LINE_H + urlLines.length * (META_SIZE + 3) + PAD
  ensureRoom(ctx, h)
  const x = side === 'left' ? MARGIN : PAGE.w - MARGIN - w
  const yTop = ctx.y
  ctx.page.drawRectangle({
    x, y: yTop - h, width: w, height: h,
    color: side === 'left' ? rgb(1, 1, 1) : AGENT_BG,
    borderColor: side === 'left' ? RULE : AGENT_BORDER,
    borderWidth: 0.6,
  })
  ctx.page.drawText(meta, { x: x + PAD, y: yTop - PAD - META_SIZE, size: META_SIZE, font: ctx.bold, color: MUTED })
  ctx.page.drawText(winAnsi(nameLine), { x: x + PAD, y: yTop - PAD - META_SIZE - LINE_H + 2, size: TEXT_SIZE, font: ctx.font, color: INK })
  let ty = yTop - PAD - META_SIZE - LINE_H - (META_SIZE + 3) + 2
  for (const line of urlLines) {
    ctx.page.drawText(line, { x: x + PAD, y: ty, size: META_SIZE, font: ctx.font, color: ACCENT })
    ty -= META_SIZE + 3
  }
  ctx.y = yTop - h - 6
}

function drawCentered(ctx: Ctx, s: string, size: number, font: PDFFont, color: ReturnType<typeof rgb>, band: boolean) {
  const t = winAnsi(s)
  const w = font.widthOfTextAtSize(t, size)
  ensureRoom(ctx, size + 14)
  const x = (PAGE.w - w) / 2
  if (band) {
    ctx.page.drawRectangle({
      x: x - 10, y: ctx.y - size - 5, width: w + 20, height: size + 9,
      color: BAND, borderColor: RULE, borderWidth: 0.4,
    })
  }
  ctx.page.drawText(t, { x, y: ctx.y - size - 1, size, font, color })
  ctx.y -= size + 18
}

export async function buildChatPdf(input: {
  siteName: string
  sessionId: string
  exportedAt: string
  items: ChatItem[]
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`${input.siteName} — chat ${input.sessionId.slice(0, 8)}`)
  doc.setSubject(`Chat transcript, session ${input.sessionId}`)
  doc.setCreator('ZeeOps')

  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const ctx: Ctx = { doc, font, bold, pages: [], page: null as unknown as PDFPage, y: 0 }
  newPage(ctx)

  // ── header ─────────────────────────────────────────────────────────────────
  ctx.page.drawRectangle({ x: 0, y: PAGE.h - 74, width: PAGE.w, height: 74, color: rgb(0.99, 0.99, 1) })
  ctx.page.drawRectangle({ x: 0, y: PAGE.h - 77, width: PAGE.w, height: 3, color: ACCENT })
  const title = winAnsi(input.siteName) || 'Chat'
  ctx.page.drawText(title, { x: (PAGE.w - bold.widthOfTextAtSize(title, 16)) / 2, y: PAGE.h - 34, size: 16, font: bold, color: INK })
  const sub = `Session ${input.sessionId}`
  ctx.page.drawText(sub, { x: (PAGE.w - font.widthOfTextAtSize(sub, 8)) / 2, y: PAGE.h - 49, size: 8, font, color: MUTED })
  const stamp = `Exported ${input.exportedAt} · times in Pakistan time`
  ctx.page.drawText(stamp, { x: (PAGE.w - font.widthOfTextAtSize(stamp, 8)) / 2, y: PAGE.h - 61, size: 8, font, color: MUTED })
  ctx.y = PAGE.h - 96

  // ── the conversation ───────────────────────────────────────────────────────
  for (const item of input.items) {
    if (item.kind === 'day') {
      drawCentered(ctx, item.label, 8, font, MUTED, true)
    } else if (item.kind === 'marker') {
      drawCentered(ctx, item.text, 8.5, bold, GREEN, false)
    } else if (item.kind === 'msg') {
      drawTextBubble(ctx, item.side, `${item.who} · ${item.time}`, item.text)
    } else {
      const image = await embedImage(doc, item.url, item.mime)
      drawFileBubble(ctx, item.side, `${item.who} · ${item.time}`, item.name, item.url, image)
    }
  }

  if (input.items.length === 0) {
    ctx.page.drawText('No messages in this conversation.', { x: MARGIN, y: ctx.y - 10, size: 9, font, color: MUTED })
  }

  // ── footer ─────────────────────────────────────────────────────────────────
  ctx.pages.forEach((p, i) => {
    const label = `Page ${i + 1} of ${ctx.pages.length}`
    p.drawText(label, { x: PAGE.w - MARGIN - font.widthOfTextAtSize(label, 7.5), y: MARGIN - 16, size: 7.5, font, color: MUTED })
    p.drawText(`${title} · chat transcript`, { x: MARGIN, y: MARGIN - 16, size: 7.5, font, color: MUTED })
  })

  return doc.save()
}
