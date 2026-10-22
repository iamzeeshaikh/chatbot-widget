// What the customer asked for, for whoever works the job — the designer and
// estimator included (owner, 2026-10-22: Jennifer should see the customer's
// files and specs on the job). Jennifer's account is jobs-only (lib/jobsonly.ts)
// and may not read leads, so the brief is built HERE, server-side, and stripped
// of every way to reach the customer: no email, phone, address or contact
// lines; files only (chat/form uploads, and attachments on the customer's
// emails as short-lived signed links).
import 'server-only'
import type { Member } from './auth'
import { loadLeadRecord } from './leadrecord'
import { scrubText } from './pii'
import { supabase } from './supabase'
import { CRM_EMAIL_IN_ROLE, parseCrmEmailIn } from './emailreply'
import { signAttachments, type EmailAttachment } from './emailattach'
import { isOurAddress } from './customercc'
import type { Workspace } from './workspaces'

export interface BriefFile { url: string; name: string; mime: string; size: number; at: string; from: 'chat' | 'form' | 'email' }
export interface JobBrief { site: string; text: string; customerSaid: string[]; files: BriefFile[] }

const CONTACT_LINE = /^\s*[*>-]?\s*(full\s+)?(name|e-?mail|business\s+email|email\s+address|phone|phone\s+number|phone\s*\/\s*whatsapp|whatsapp|mobile|tel|address|street|city|zip|postal|shipping\s+address|customer\s+name|from|to|cc|date|sent)\s*[:=]/i

function clean(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => !CONTACT_LINE.test(l))
  return (scrubText(lines.join('\n')) ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
}

export async function buildJobBrief(leadId: string, workspace: Workspace): Promise<JobBrief | null> {
  if (!leadId) return null
  // Read as the workspace admin: the person asking may be jobs-only.
  const reader: Member = { id: `builtin:${workspace}@zeeops.dev`, email: `${workspace}@zeeops.dev`, workspace, role: 'admin', assigned_sites: [] }
  const rec = await loadLeadRecord(reader, leadId)
  if (!rec) return null
  const said = rec.timeline
    .filter((e) => e.kind === 'message' && e.actor === 'Visitor' && e.body && !e.body.startsWith('{"__file"') && e.body !== '(session started)')
    .map((e) => clean(e.body ?? '')).filter(Boolean).slice(0, 40)
  const files: BriefFile[] = rec.attachments.map((a) => ({ url: a.url, name: a.name, mime: a.mime, size: a.size, at: a.at, from: rec.kind === 'chat' ? 'chat' : 'form' }))

  // Files on the customer's own emails (private bucket → signed for an hour).
  const { data } = await supabase.from('chat_logs').select('message').eq('session_id', leadId).eq('role', CRM_EMAIL_IN_ROLE).limit(200)
  const mail: { att: EmailAttachment; at: string }[] = []
  for (const r of data ?? []) {
    const e = parseCrmEmailIn(r.message)
    if (!e || isOurAddress(e.from)) continue
    for (const att of e.attachments ?? []) mail.push({ att, at: e.at })
  }
  const signed = await signAttachments(mail.map((m) => m.att))
  signed.forEach((s, i) => { if (s.url) files.push({ url: s.url, name: s.name, mime: s.mime, size: s.size, at: mail[i].at, from: 'email' }) })

  return { site: rec.siteName, text: clean(rec.quoteMessage ?? ''), customerSaid: said, files }
}
