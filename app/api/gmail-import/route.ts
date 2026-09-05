import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { siteWorkspace, isLeadTracked, type Workspace } from '@/lib/workspaces'
import { CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE } from '@/lib/crm'
import { makeSnippet, newEmailId } from '@/lib/crmemail'
import { splitQuoted, inboundSnippet, MAX_INBOUND_BODY } from '@/lib/emailreply'
import { QUOTE_TAG, quoteSessionId } from '@/lib/quoteintake'
import { siteIdForImportAddress } from '@/lib/gmailimport'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ONE-TIME import of a mailbox's OLD customer conversations into the CRM.
//
// WHY THIS IS A SEPARATE, SECRET ENDPOINT and not part of the Phase-6 sweep:
// the sweep is forbidden from ever seeing the wider inbox — it only reads
// threads WE started (CLAUDE.md §"poll threads we started, never the mailbox").
// That restriction is the whole safety story of the Gmail integration and must
// not be weakened. Bulk history import genuinely needs to read arbitrary old
// threads, so it lives OUTSIDE that guarantee: an Apps Script running in the
// agent's OWN mailbox (where the access already belongs to them, not to us)
// does the reading and POSTs the extracted messages here. This server never
// gains a way to list or search anyone's inbox — it only ingests what the
// script hands it, exactly like /api/quote-intake.
//
// Protected by GMAIL_IMPORT_SECRET, and every message is deduped on Gmail's
// immutable id, so the import is safe to run twice or resume after a stop.
//
// A THREAD becomes a lead, matched to an existing one by the customer's email
// (any site the address already has a lead on), else a new email-only lead on
// the site the importing address serves. Nothing here backdates a customer
// reply's unread state — these are historical, already-handled, so they are
// imported as READ (a crm_email_read row per inbound id) and never ring a bell.

interface ImportMessage {
  gmailId: string
  threadId: string
  messageId?: string
  inReplyTo?: string | null
  from: string          // "Name <addr>" or just addr
  fromEmail: string     // bare address, lower-cased by the script
  fromName?: string
  to?: string
  subject?: string
  body: string
  at?: string           // ISO
  outbound: boolean     // true = the agent/company sent it
  customerEmail: string // the OTHER party's address — the lead's identity
}

const MAX_MESSAGES = 200

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status })
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-import-secret')
  if (!secret || secret !== process.env.GMAIL_IMPORT_SECRET) {
    return bad('Unauthorized', 401)
  }

  const body = await req.json().catch(() => null)
  if (!body) return bad('Invalid JSON')

  // Which mailbox is importing — decides the fallback site and the workspace a
  // matched lead is allowed to live in.
  const importAddress = String(body.importAddress ?? '').trim().toLowerCase()
  const fallbackSite = siteIdForImportAddress(importAddress)
  if (!fallbackSite || !isLeadTracked(fallbackSite)) {
    return bad(`This mailbox (${importAddress || 'unset'}) is not mapped to a site — add it to lib/gmailimport.ts first.`)
  }
  const workspace = siteWorkspace(fallbackSite)
  if (!workspace) return bad(`No workspace for ${fallbackSite}`)

  const messages: ImportMessage[] = Array.isArray(body.messages) ? body.messages.slice(0, MAX_MESSAGES) : []
  if (messages.length === 0) return NextResponse.json({ ok: true, imported: 0, skipped: 0 })

  // ── group by customer, resolve each to a lead ONCE ─────────────────────────
  const byCustomer = new Map<string, ImportMessage[]>()
  for (const m of messages) {
    const key = String(m.customerEmail ?? '').trim().toLowerCase()
    if (!key || !key.includes('@')) continue
    if (!byCustomer.has(key)) byCustomer.set(key, [])
    byCustomer.get(key)!.push(m)
  }

  let imported = 0
  let skipped = 0
  const leads: string[] = []

  for (const [customerEmail, msgs] of byCustomer) {
    const sessionId = await resolveLeadSession(customerEmail, fallbackSite, workspace, msgs[0])
    if (!sessionId) { skipped += msgs.length; continue }

    // What is already on this session, so a re-run adds nothing twice.
    const { data: existing } = await supabase.from('chat_logs')
      .select('message').eq('session_id', sessionId)
      .in('role', [CRM_EMAIL_ROLE, CRM_EMAIL_IN_ROLE]).limit(1000)
    const have = new Set<string>()
    for (const r of existing ?? []) {
      try { const g = JSON.parse(r.message ?? '{}').gmailId; if (g) have.add(String(g)) } catch { /* skip */ }
    }

    const siteId = sessionId.startsWith('quote-') ? fallbackSite : fallbackSite
    for (const m of msgs) {
      if (!m.gmailId || have.has(m.gmailId)) { skipped++; continue }
      const at = safeIso(m.at)
      if (m.outbound) {
        const entry = {
          id: newEmailId(), sentBy: importAddress, from: importAddress,
          to: m.to || customerEmail, subject: m.subject || '(no subject)',
          body: m.body.slice(0, MAX_INBOUND_BODY),
          snippet: makeSnippet(m.body), at,
          gmailId: m.gmailId, threadId: m.threadId, messageId: m.messageId || '',
          direction: 'outbound' as const, imported: true,
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
        }
        const { error } = await supabase.from('chat_logs').insert([{
          session_id: sessionId, site_id: siteId, role: CRM_EMAIL_IN_ROLE,
          message: JSON.stringify(entry), created_at: at,
        }])
        if (error) { skipped++; continue }
        // Imported history is already handled — mark it read so it never lights
        // the unread badge or rings a bell.
        await supabase.from('chat_logs').insert([{
          session_id: sessionId, site_id: siteId, role: 'crm_email_read',
          message: JSON.stringify({ gmailId: m.gmailId, by: importAddress, at }),
        }])
      }
      imported++
    }
    if (!leads.includes(sessionId)) leads.push(sessionId)
  }

  return NextResponse.json({ ok: true, imported, skipped, leads: leads.length })
}

// The lead a customer's history belongs to: their existing lead on the
// importing mailbox's site if one exists (matched on email), otherwise a new
// email-only lead — the same `quote-<id>` shape the quote intake and Billing
// already use, so /leads/<id> and the Inbox render it with no special case.
async function resolveLeadSession(
  customerEmail: string,
  fallbackSite: string,
  workspace: Workspace,
  first: ImportMessage,
): Promise<string | null> {
  const { data: found } = await supabase.from('leads')
    .select('id, site_id').eq('site_id', fallbackSite).ilike('email', customerEmail)
    .order('created_at', { ascending: true }).limit(1)
  if (found && found[0]) return quoteSessionId(found[0].id)

  // No lead yet — create an email-only one, tagged like a quote so it counts
  // and dedupes the same way, its message naming the source.
  const name = (first.fromName && !first.outbound) ? first.fromName : ''
  const { data: created } = await supabase.from('leads').insert([{
    site_id: fallbackSite,
    name: name || null,
    email: customerEmail,
    message: `${QUOTE_TAG}Imported email conversation\n\nFirst subject: ${first.subject || '(no subject)'}\nImported from Gmail history on ${new Date().toISOString().slice(0, 10)}.`,
    created_at: safeIso(first.at),
  }]).select('id').maybeSingle()
  return created?.id ? quoteSessionId(created.id) : null
}

function safeIso(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  const t = s && !isNaN(new Date(s).getTime()) ? s : new Date().toISOString()
  return new Date(t).toISOString()
}
