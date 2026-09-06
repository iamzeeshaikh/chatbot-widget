import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { workspaceSites, type Workspace } from '@/lib/workspaces'
import { CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE } from '@/lib/crm'
import { makeSnippet, newEmailId } from '@/lib/crmemail'
import { splitQuoted, inboundSnippet, MAX_INBOUND_BODY } from '@/lib/emailreply'
import { QUOTE_TAG, quoteSessionId, isLikelySpamQuote } from '@/lib/quoteintake'
import { workspaceForImportAddress, siteForDomain } from '@/lib/gmailimport'
import { EMAIL_ATTACHMENT_BUCKET, MAX_INBOUND_ATTACHMENT_BYTES, attachmentPath, type EmailAttachment } from '@/lib/emailattach'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ONE-TIME import of an agent mailbox's OLD customer conversations into the CRM,
// so a lead's record shows the whole email history — the way Gmail shows it,
// not only what was sent from the dashboard.
//
// WHY A SEPARATE, SECRET ENDPOINT and not the Phase-6 sweep: the sweep is
// forbidden from ever listing a mailbox (CLAUDE.md §"poll threads we started,
// never the mailbox") — that boundary is the whole safety story of the Gmail
// integration and stays. Bulk history genuinely needs to read old threads, so
// it uses the OTHER trust model, the quote-intake one: an Apps Script running
// in the agent's OWN mailbox does the reading and POSTs the extracted messages
// here. This server never gains a way to list or search anyone's inbox.
//
// One mailbox serves the WHOLE portfolio through send-as aliases, so a thread's
// SITE is resolved per conversation:
//   1. the existing lead for that customer's email anywhere in the workspace
//      (leads already exist — this is the common case and the most reliable);
//   2. else the alias domain the mail used (info@peptidesboxes.com → that site);
//   3. else the site named in the subject ("… - The Paper Cups");
//   4. else skipped and reported — never filed on a guessed site.
//
// Rows are the EXACT shapes the record page and Inbox already render, deduped on
// Gmail's id, and inbound history arrives READ (a crm_email_read row) so a
// 2½-month backlog never rings a single bell.

interface ImportMessage {
  gmailId: string
  threadId: string
  messageId?: string
  inReplyTo?: string | null
  fromEmail: string
  fromName?: string
  to?: string
  subject?: string
  body: string
  at?: string
  outbound: boolean
  customerEmail: string
  ourAliasDomain?: string   // the our-side domain this mail used (site hint)
  /** Files the script has ALREADY PUT into the private email bucket through a
   *  signed upload URL (the `sign` action below) — references only. A serverless
   *  function's body is capped at 4.5MB, so the bytes never come through here;
   *  the composer's own uploads take the same road. Stored in the exact shape
   *  the sweep writes, so the Files panel, timeline and Inbox chips need no
   *  new code. */
  attachments?: { path: string; name: string; mime: string; size: number }[]
}

const MAX_IMPORT_FILES = 8
const IMPORT_PREFIX = 'gmail-import/'

function keepFiles(raw: ImportMessage['attachments']): EmailAttachment[] {
  const out: EmailAttachment[] = []
  for (const a of (raw ?? []).slice(0, MAX_IMPORT_FILES)) {
    const path = String(a?.path ?? '')
    const name = String(a?.name ?? '').slice(0, 200)
    const mime = String(a?.mime ?? '').split(';')[0].trim().toLowerCase()
    const size = Number(a?.size ?? 0)
    // Only paths THIS endpoint minted — a message cannot point at another lead's file.
    if (!path.startsWith(IMPORT_PREFIX) || path.includes('..') || !name || !mime || !(size > 0) || size > MAX_INBOUND_ATTACHMENT_BYTES) continue
    out.push({ path, name, mime, size })
  }
  return out
}

// `sign`: mint signed upload URLs so the script can PUT file bytes straight into
// the bucket. The path is chosen here (never by the caller) and carries the
// import prefix keepFiles() insists on.
async function signUploads(importAddress: string, files: unknown): Promise<{ name: string; path: string; uploadUrl: string; token: string }[]> {
  const out: { name: string; path: string; uploadUrl: string; token: string }[] = []
  const list = Array.isArray(files) ? files.slice(0, 20) : []
  const who = importAddress.replace(/[^a-z0-9]/gi, '').slice(0, 40) || 'mailbox'
  for (const f of list) {
    const name = String((f as { name?: unknown })?.name ?? '').slice(0, 200)
    if (!name) continue
    const path = `${IMPORT_PREFIX}${who}/${attachmentPath('import', 'gmail', 'in', name).split('/').pop()}`
    const { data, error } = await supabase.storage.from(EMAIL_ATTACHMENT_BUCKET).createSignedUploadUrl(path)
    if (error || !data) continue
    out.push({ name, path, uploadUrl: data.signedUrl, token: data.token })
  }
  return out
}

const MAX_MESSAGES = 120

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-import-secret')
  if (!secret || secret !== process.env.GMAIL_IMPORT_SECRET) return bad('Unauthorized', 401)

  const body = await req.json().catch(() => null)
  if (!body) return bad('Invalid JSON')

  const importAddress = String(body.importAddress ?? '').trim().toLowerCase()
  const workspace = workspaceForImportAddress(importAddress)
  if (!workspace) return bad(`This mailbox (${importAddress || 'unset'}) is not an allowed import address — add it to lib/gmailimport.ts.`)

  if (body.action === 'sign') {
    return NextResponse.json({ ok: true, uploads: await signUploads(importAddress, body.files) })
  }

  const messages: ImportMessage[] = Array.isArray(body.messages) ? body.messages.slice(0, MAX_MESSAGES) : []
  if (messages.length === 0) return NextResponse.json({ ok: true, imported: 0, skipped: 0, unresolved: 0 })

  // Site-name → site id, for the subject fallback ("… - The Paper Cups").
  const sites = workspaceSites(workspace)
  const { data: siteRows } = await supabase.from('sites').select('site_id, name').in('site_id', sites)
  const nameToSite = new Map<string, string>()
  for (const s of siteRows ?? []) {
    const n = String(s.name ?? '').trim().toLowerCase()
    if (n) nameToSite.set(n, s.site_id)
  }

  // ── group by customer ──────────────────────────────────────────────────────
  const byCustomer = new Map<string, ImportMessage[]>()
  for (const m of messages) {
    const key = String(m.customerEmail ?? '').trim().toLowerCase()
    if (!key || !key.includes('@')) continue
    if (!byCustomer.has(key)) byCustomer.set(key, [])
    byCustomer.get(key)!.push(m)
  }

  let imported = 0, skipped = 0, unresolved = 0
  const leadIds = new Set<string>()

  for (const [customerEmail, msgs] of byCustomer) {
    const resolved = await resolveLead(customerEmail, workspace, msgs, nameToSite)
    if (!resolved) { unresolved += msgs.length; continue }
    const { sessionId, siteId } = resolved
    leadIds.add(sessionId)

    // What this session already carries, so a re-run adds nothing twice.
    const { data: existing } = await supabase.from('chat_logs')
      .select('id, message').eq('session_id', sessionId)
      .in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE]).limit(1000)
    // gmailId → { rowId, entry } for rows this import wrote and can still enrich
    const have = new Map<string, { rowId: string; entry: Record<string, unknown>; imported: boolean }>()
    for (const r of existing ?? []) {
      try {
        const o = JSON.parse(r.message ?? '{}')
        if (o?.gmailId) have.set(String(o.gmailId), { rowId: String(r.id), entry: o, imported: o.imported === true })
      } catch { /* skip */ }
    }

    for (const m of msgs) {
      if (!m.gmailId) { skipped++; continue }
      const prior = have.get(m.gmailId)
      if (prior) {
        // Already here. A re-run that now carries files for an imported row
        // that has none fills them in — the one legitimate in-place edit,
        // because the first pass ran before attachments were sent at all.
        const hadFiles = Array.isArray(prior.entry.attachments) && (prior.entry.attachments as unknown[]).length > 0
        if (prior.imported && !hadFiles && m.attachments?.length) {
          const files = keepFiles(m.attachments)
          if (files.length) {
            await supabase.from('chat_logs').update({ message: JSON.stringify({ ...prior.entry, attachments: files }) }).eq('id', prior.rowId)
            imported++
            continue
          }
        }
        skipped++
        continue
      }
      const at = safeIso(m.at)
      if (m.outbound) {
        const entry = {
          id: newEmailId(), sentBy: importAddress, from: importAddress,
          to: m.to || customerEmail, subject: m.subject || '(no subject)',
          body: m.body.slice(0, MAX_INBOUND_BODY), snippet: makeSnippet(m.body), at,
          gmailId: m.gmailId, threadId: m.threadId, messageId: m.messageId || '',
          direction: 'outbound' as const, imported: true,
          attachments: keepFiles(m.attachments),
        }
        const { error } = await supabase.from('chat_logs').insert([{
          session_id: sessionId, site_id: siteId, role: CRM_EMAIL_ROLE,
          message: JSON.stringify(entry), created_at: at,
        }])
        if (error) { skipped++; continue }
      } else {
        const split = splitQuoted(m.body)
        const entry = {
          gmailId: m.gmailId, threadId: m.threadId, messageId: m.messageId || '',
          inReplyTo: m.inReplyTo ?? null,
          from: m.fromEmail || customerEmail, fromName: m.fromName ?? null,
          to: m.to || importAddress, subject: m.subject || '(no subject)',
          body: split.visible.slice(0, MAX_INBOUND_BODY),
          quoted: split.quoted ? split.quoted.slice(0, MAX_INBOUND_BODY) : null,
          snippet: inboundSnippet(split.visible), at,
          direction: 'inbound' as const, imported: true,
          attachments: keepFiles(m.attachments),
        }
        const { error } = await supabase.from('chat_logs').insert([{
          session_id: sessionId, site_id: siteId, role: CRM_EMAIL_IN_ROLE,
          message: JSON.stringify(entry), created_at: at,
        }])
        if (error) { skipped++; continue }
        // Already-handled history — mark read so it lights no unread badge.
        await supabase.from('chat_logs').insert([{
          session_id: sessionId, site_id: siteId, role: 'crm_email_read',
          message: JSON.stringify({ gmailId: m.gmailId, by: importAddress, at }),
        }])
      }
      imported++
    }
  }

  return NextResponse.json({ ok: true, imported, skipped, unresolved, leads: leadIds.size })
}

// The lead this customer's history belongs to. Existing lead first (any site in
// the workspace — leads are already loaded), then a new email-only lead on the
// site the conversation itself names.
async function resolveLead(
  customerEmail: string,
  workspace: Workspace,
  msgs: ImportMessage[],
  nameToSite: Map<string, string>,
): Promise<{ sessionId: string; siteId: string } | null> {
  const sites = workspaceSites(workspace)

  // 1. an existing lead for this address, anywhere in the workspace.
  const { data: found } = await supabase.from('leads')
    .select('id, site_id').ilike('email', customerEmail).in('site_id', sites)
    .order('created_at', { ascending: true }).limit(1)
  if (found && found[0]) return { sessionId: quoteSessionId(found[0].id), siteId: found[0].site_id }

  // 2. the site the conversation names — an alias domain, then the subject.
  let siteId: string | null = null
  for (const m of msgs) {
    if (m.ourAliasDomain) { siteId = siteForDomain(m.ourAliasDomain, workspace); if (siteId) break }
  }
  if (!siteId) {
    for (const m of msgs) {
      const subj = String(m.subject ?? '').toLowerCase()
      for (const [name, id] of nameToSite) {
        if (name.length >= 4 && subj.includes(name)) { siteId = id; break }
      }
      if (siteId) break
    }
  }
  if (!siteId) return null   // unresolved — reported, never guessed onto a site

  const first = msgs.slice().sort((a, b) => safeIso(a.at).localeCompare(safeIso(b.at)))[0]
  // A thread that would CREATE a lead gets the quote-intake spam test on the
  // customer's own first words: a supplier pitch ("Premium Sportswear &
  // Teamwear Sourcing") became a sports lead on the first sports import.
  // Threads that match an EXISTING lead are never judged here.
  const firstInbound = msgs.filter((m) => !m.outbound).sort((a, b) => safeIso(a.at).localeCompare(safeIso(b.at)))[0]
  if (firstInbound && isLikelySpamQuote(`${firstInbound.subject ?? ''}\n${firstInbound.body}`)) return null
  const name = (!first.outbound && first.fromName) ? first.fromName : ''
  const { data: created } = await supabase.from('leads').insert([{
    site_id: siteId, name: name || null, email: customerEmail,
    message: `${QUOTE_TAG}Imported email conversation\n\nFirst subject: ${first.subject || '(no subject)'}\nImported from Gmail history on ${new Date().toISOString().slice(0, 10)}.`,
    created_at: safeIso(first.at),
  }]).select('id').maybeSingle()
  return created?.id ? { sessionId: quoteSessionId(created.id), siteId } : null
}

function safeIso(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  const t = s && !isNaN(new Date(s).getTime()) ? s : new Date().toISOString()
  return new Date(t).toISOString()
}
