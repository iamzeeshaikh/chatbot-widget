// Quote intake, pulled by ZeeOps itself from the intake mailbox.
//
// Every packaging form notification is also delivered to dev@zeecustomboxes.com,
// which is Gmail-connected here with read access. On 15 Oct 2026 the Apps Script
// intake (scripts/quote-intake-apps-script.gs) stopped after its nightly run and
// six hours of leads never reached the dashboard. That script runs inside a
// Google account nobody here can see, has no logs we can read, and changes only
// when the owner pastes a new copy by hand. This pull runs on our own cron, with
// our own logs, and needs nothing pasted.
//
// It deliberately does NOT have its own parser. It loads the Apps Script file
// itself and calls the same codeFromMessageText_ / parseLeadBody_ /
// leadFromMessage_ functions, so the two intakes can never read a form
// differently. Both post into the same /api/quote-intake handler, whose dedupe
// (same body / same customer, same site, same day) makes the pair safe to run
// side by side: whichever sees a lead first files it, the other is a no-op.
//
// Packaging only. The sports forms arrive in a different mailbox.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { NextRequest } from 'next/server'
import { supabase } from './supabase'
import { REMINDER_SITE } from './reminders'
import { siteIdFromQuoteCode, isMachineMessage } from './quoteintake'
import { siteWorkspace } from './workspaces'
import { googleConfig, searchIntakeMessageIds, fetchThread, fetchAttachment, type InboundMessage } from './gmail'
import { POST as intakePost } from '@/app/api/quote-intake/route'

export const INTAKE_MAILBOX = 'dev@zeecustomboxes.com'
export const CRM_INTAKE_PULL_ROLE = 'crm_intake_pull'
const SESSION = 'zeeops-intake-pull'
/** How far back each run looks. Two days covers a weekend outage of the cron. */
const WINDOW = 'newer_than:2d'
/** Messages opened per run; the rest wait for the next run (5 minutes). */
const PER_RUN = 40
const FILE_BUDGET = 9 * 1024 * 1024
const FILE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'])

type GsContext = {
  codeFromMessageText_: (body: string, from: string, to: string) => string | null
  leadFromMessage_: (msg: unknown) => (Record<string, unknown> & { email?: string; phone?: string; unreadable?: boolean }) | null
}
let gs: GsContext | null = null
function script(): GsContext {
  if (gs) return gs
  const src = readFileSync(path.join(process.cwd(), 'scripts', 'quote-intake-apps-script.gs'), 'utf8')
  const ctx: Record<string, unknown> = {
    Session: { getActiveUser: () => ({ getEmail: () => INTAKE_MAILBOX }) },
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    Utilities: {},
  }
  vm.createContext(ctx)
  vm.runInContext(src, ctx)
  gs = ctx as unknown as GsContext
  return gs
}

export interface PullResult {
  ranAt: string
  dryRun: boolean
  found: number
  opened: number
  posted: { gmailId: string; site: string; name: string; email: string; result: string }[]
  skipped: number
  errors: string[]
}

async function processedIds(): Promise<Set<string>> {
  const since = new Date(Date.now() - 4 * 864e5).toISOString()
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', SESSION).eq('role', CRM_INTAKE_PULL_ROLE).gte('created_at', since).limit(5000)
  const out = new Set<string>()
  for (const r of data ?? []) { try { const o = JSON.parse(r.message); if (o?.gmailId) out.add(o.gmailId) } catch { /* skip */ } }
  return out
}

async function remember(gmailId: string, result: string, extra: Record<string, unknown> = {}): Promise<void> {
  await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE, session_id: SESSION, role: CRM_INTAKE_PULL_ROLE,
    message: JSON.stringify({ gmailId, result, at: new Date().toISOString(), ...extra }),
  })
}

export async function runIntakePull(origin: string, opts: { dryRun?: boolean } = {}): Promise<PullResult> {
  const dryRun = !!opts.dryRun
  const out: PullResult = { ranAt: new Date().toISOString(), dryRun, found: 0, opened: 0, posted: [], skipped: 0, errors: [] }
  const cfg = googleConfig(origin)
  if (!cfg) { out.errors.push('Google OAuth is not configured'); return out }
  const secret = process.env.QUOTE_INTAKE_SECRET
  if (!secret) { out.errors.push('QUOTE_INTAKE_SECRET is not set'); return out }

  const ids = await searchIntakeMessageIds(INTAKE_MAILBOX, cfg, `${WINDOW} -in:sent -in:chats`, 300)
  out.found = ids.length
  const done = await processedIds()
  const todo = ids.filter((m) => !done.has(m.id)).slice(0, PER_RUN)
  const threads = new Map<string, InboundMessage[]>()
  const g = script()

  for (const ref of todo) {
    try {
      if (!threads.has(ref.threadId)) threads.set(ref.threadId, await fetchThread(INTAKE_MAILBOX, cfg, ref.threadId))
      const m = threads.get(ref.threadId)!.find((x) => x.gmailId === ref.id)
      out.opened++
      if (!m) { if (!dryRun) await remember(ref.id, 'gone'); out.skipped++; continue }
      // DMARC reports and bounces name our domains and so look like ours;
      // they are nobody's enquiry. Dropped here, before a parse or a post.
      const machine = isMachineMessage(m.from, m.subject, m.bodyText)
      if (machine) { if (!dryRun) await remember(ref.id, 'machine', { detail: machine }); out.skipped++; continue }
      const code = g.codeFromMessageText_(m.bodyText, m.from, m.to)
      const siteId = code ? siteIdFromQuoteCode(code) : null
      if (!code || !siteId || siteWorkspace(siteId) !== 'packaging') {
        if (!dryRun) await remember(ref.id, 'not-a-form')
        out.skipped++
        continue
      }
      // The same shim the Apps Script hands leadFromMessage_: a Gmail message.
      const parsed = g.leadFromMessage_({
        getPlainBody: () => m.bodyText, getSubject: () => m.subject,
        getFrom: () => m.from, getReplyTo: () => '',
      })
      if (!parsed) { if (!dryRun) await remember(ref.id, 'own-reply'); out.skipped++; continue }

      // Files: posted straight into the handler, so Vercel's 4.5MB request cap
      // does not apply here; the store's own per-file limit still does.
      const files: { name: string; mime: string; data: string }[] = []
      const left: string[] = []
      let total = 0
      for (const a of m.attachments ?? []) {
        const mime = a.mime.toLowerCase().split(';')[0]
        if (!FILE_MIMES.has(mime)) continue
        if (files.length >= 5 || total + a.size > FILE_BUDGET) { left.push(a.name); continue }
        const bytes = dryRun ? null : await fetchAttachment(INTAKE_MAILBOX, cfg, m.gmailId, a.attachmentId)
        if (!dryRun && !bytes) { left.push(a.name); continue }
        total += a.size
        if (bytes) files.push({ name: a.name, mime, data: Buffer.from(bytes).toString('base64') })
      }
      const note = left.length ? `\n\nAttachments too large to bring in (open the original email in Gmail): ${left.join(', ')}` : ''
      const payload = {
        siteCode: code, name: parsed.name, email: parsed.email, phone: parsed.phone, product: parsed.product,
        message: String(parsed.message ?? '') + note, receivedAt: m.at,
        unreadable: parsed.unreadable === true, attachments: files,
      }
      if (dryRun) {
        out.posted.push({ gmailId: m.gmailId, site: siteId, name: String(parsed.name ?? ''), email: String(parsed.email ?? ''), result: 'would-post' })
        continue
      }
      const res = await intakePost(new NextRequest(`${origin}/api/quote-intake`, {
        method: 'POST', headers: { 'x-quote-secret': secret, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }))
      const body = await res.json().catch(() => ({})) as Record<string, unknown>
      const result = res.status !== 200 ? `error ${res.status}` : body.deduped ? 'duplicate' : body.spam ? 'spam' : 'new lead'
      // A failed post is NOT remembered, so the next run tries it again.
      if (res.status === 200) await remember(m.gmailId, result, { siteId })
      else out.errors.push(`${m.gmailId}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
      out.posted.push({ gmailId: m.gmailId, site: siteId, name: String(parsed.name ?? ''), email: String(parsed.email ?? ''), result })
    } catch (e) {
      out.errors.push(`${ref.id}: ${e instanceof Error ? e.message : 'failed'}`)
    }
  }
  return out
}
