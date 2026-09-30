import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { googleConfig, connectedAddresses, accessTokenFor } from '@/lib/gmail'
import { phoneFromText } from '@/lib/identity'

export const dynamic = 'force-dynamic'

// "Why did THIS email never become a lead?" — admin only, read-only.
//
// The Apps Script has diagnoseThread, which answers the same question, but it
// answers it inside Gmail: somebody has to open the editor, edit a variable,
// run a function and read a log. That is a long way round for a question that
// comes up most weeks, usually about mail sitting under the ZeeOps/Unmatched
// label — which means exactly one thing: the site was known but the parser
// found NO email and NO phone in the body, so there was nobody to file.
//
// This says the same four facts over HTTP, for any Gmail query:
//
//   GET /api/admin/mail-check?q=label:zeeops-unmatched
//   GET /api/admin/mail-check?q=subject:"Instant Quote" newer_than:14d
//
// It never writes, never ingests, and never returns a token. The body excerpt
// is capped: this is for finding the shape of a template, not for reading
// customers' mail from a browser tab.
const MAX_MESSAGES = 15
const EXCERPT = 700

// Deliberately the same shape the Apps Script's parseLeadBody_ looks for, so
// that "the server can see an address here" means the script could too.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// Our own addresses are not the customer's: a form notification is FROM the
// site and the reply-to line names the site again, and counting either as "an
// address was found" is how a lead with nobody in it gets created.
const OURS = /@(zeeops\.dev|zeecustomboxes\.com|shopcardboardboxes\.com|peptidesboxes\.com|thepapercups\.com|thecandlepackaging\.com|thebaseballjerseys\.com|californiasoccerjerseys\.com|noreply|no-reply)/i

interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string }
  parts?: GmailPart[]
  headers?: { name: string; value: string }[]
}

function plainText(part: GmailPart | undefined, out: string[] = [], files: string[] = []): { text: string; files: string[] } {
  if (!part) return { text: out.join('\n'), files }
  if (part.filename) files.push(`${part.filename} (${part.mimeType ?? 'unknown'})`)
  if (part.mimeType === 'text/plain' && part.body?.data) {
    out.push(Buffer.from(part.body.data, 'base64url').toString('utf8'))
  }
  // An HTML-only notification has no text/plain part at all, which is itself a
  // reason a parser finds nothing — so the tags are stripped rather than the
  // part ignored, and the caller can see what the text would have been.
  if (part.mimeType === 'text/html' && part.body?.data && out.length === 0) {
    const html = Buffer.from(part.body.data, 'base64url').toString('utf8')
    out.push(html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' '))
  }
  for (const p of part.parts ?? []) plainText(p, out, files)
  return { text: out.join('\n'), files }
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const q = (req.nextUrl.searchParams.get('q') ?? 'label:zeeops-unmatched').slice(0, 200)
  const cfg = googleConfig(req.nextUrl.origin)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured on this server.' }, { status: 503 })

  const mailboxes = await connectedAddresses()
  const out: unknown[] = []
  for (const address of mailboxes) {
    let token: string
    try { token = await accessTokenFor(address, cfg) } catch (e) {
      out.push({ mailbox: address, error: e instanceof Error ? e.message : 'no token' })
      continue
    }
    const h = { Authorization: `Bearer ${token}` }
    const list = await (await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${MAX_MESSAGES}`,
      { headers: h },
    )).json().catch(() => ({}))

    const messages = []
    for (const m of (list?.messages ?? []).slice(0, MAX_MESSAGES)) {
      const full = await (await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: h },
      )).json().catch(() => null)
      if (!full) continue
      const header = (n: string) =>
        (full.payload?.headers ?? []).find((x: { name: string }) => x.name.toLowerCase() === n)?.value ?? ''
      const { text, files } = plainText(full.payload)
      const found = [...new Set(text.match(EMAIL_RE) ?? [])]
      const theirs = found.filter((e) => !OURS.test(e))
      messages.push({
        date: header('date'),
        from: header('from'),
        subject: header('subject'),
        labels: full.labelIds ?? [],
        // The four facts, in the order they decide the outcome.
        addressesInBody: found,
        customerAddress: theirs[0] ?? null,
        phoneInBody: phoneFromText(text),
        hasPlainTextPart: /text\/plain/.test(JSON.stringify(full.payload?.mimeType ?? '') + JSON.stringify((full.payload?.parts ?? []).map((p: GmailPart) => p.mimeType))),
        attachments: files,
        excerpt: text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).join('\n').slice(0, EXCERPT),
      })
    }
    out.push({ mailbox: address, matched: list?.resultSizeEstimate ?? 0, messages })
  }
  return NextResponse.json({ query: q, mailboxes: out })
}
