// Assembles the full lead record shown at /leads/[id].
//
// Nothing here is new state: the record is MERGED from data the system already
// keeps — chat_logs messages, the lead_capture / contact / assignment /
// lead_status control rows, the leads table (quote + checkout emails), and the
// active_visitors row — plus the crm_* control rows this page writes.
//
// The record id IS the conversation id used everywhere else in the dashboard,
// so /leads/<session-id> works for links that already exist. Email-only leads
// (custom quote / checkout) have no chat session, so they use the same
// synthetic `quote-<leadId>` id the Billing tab already gives them.

import { supabase, fetchAllPages } from './supabase'
import { canAccessSite, memberSites, type Member } from './auth'
import { asUtcIso, CONTACT_ROLE, parseContact, TAGS_ROLE, parseTags } from './visitor'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'
import { LEAD_STATUS_ROLE, parseLeadStatus } from './leadstatus'
import { ASSIGNMENT_ROLE } from './assignment'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from './replyauthor'
import { parseAttachment, type AttachmentInfo } from './attachment'
import { isQuoteSessionId, quoteSessionId, stripQuoteTag, isQuoteLeadMessage, isCheckoutLeadMessage } from './quoteintake'
import { digitsOnly, samePhone } from './identity'
import { workspaceSites, hasFeature, type WorkspaceFeature } from './workspaces'
import {
  CRM_STAGE_ROLE, CRM_NOTE_ROLE, CRM_FIELD_ROLE, CRM_VALUE_ROLE,
  parseCrmStage, parseCrmNote, parseCrmField, parseCrmValue,
  stageFromLeadStatus, deriveFollowUps, DEFAULT_CURRENCY,
  type CrmStage, type CrmNoteEntry, type CrmCurrency, type FollowUpSummary,
} from './crm'
import {
  CRM_TASK_ROLE, parseCrmTask, byDueAsc, byCompletedDesc, type CrmTaskEntry,
} from './tasks'
import { CRM_EMAIL_ROLE, parseCrmEmail, type CrmEmailEntry } from './crmemail'
import { CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE } from './crm'
import { parseCall, callDurationLabel, type CallEntry } from './call'
import { parseWaMessage, waDeliveryLabel, waErrorHint, type WaMessage } from './whatsapp'
import {
  CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, parseCrmEmailIn, parseCrmEmailRead,
  type CrmEmailInEntry,
} from './emailreply'
import { signAttachments, type EmailAttachment } from './emailattach'
import { canSeeContacts, maskEmail, maskPhone, scrubText, HIDDEN_EMAIL, HIDDEN_PHONE } from './pii'

export type LeadKind = 'chat' | 'quote' | 'checkout'

export interface TimelineEvent {
  id: string
  at: string
  kind: 'created' | 'message' | 'note' | 'stage' | 'assign' | 'attachment' | 'field' | 'value' | 'task' | 'email' | 'email_in' | 'wa_out' | 'wa_in' | 'call'
  group: 'messages' | 'notes' | 'stage' | 'system' | 'tasks'
  actor: string
  title: string
  body?: string
  stage?: CrmStage
  attachment?: AttachmentInfo
  noteId?: string
  editedAt?: string
  /** Set on `task` events so the timeline can badge them by type. */
  taskType?: CrmTaskEntry['type']
  taskDone?: boolean
  /** Set on `email` events — the full sent message, expandable in the timeline. */
  email?: CrmEmailEntry
  /** Set on `email_in` events — the customer's reply. */
  inbound?: CrmEmailInEntry
  /** Set on `wa_out` / `wa_in` events — the WhatsApp message. */
  wa?: WaMessage
  /** Set on `call` events. */
  call?: CallEntry
  /** True while nobody has opened this reply. */
  unread?: boolean
  /** Signed, short-lived links for files on an email event. */
  files?: { name: string; mime: string; size: number; url: string | null }[]
}

export interface RelatedLead {
  id: string
  siteId: string
  siteName: string
  name: string | null
  email: string | null
  phone: string | null
  at: string
  kind: LeadKind
  matchedOn: 'email' | 'phone'
}

export interface LeadRecord {
  id: string
  siteId: string
  siteName: string
  kind: LeadKind
  sourceLabel: string
  hasConversation: boolean
  contact: { name: string; email: string; phone: string }
  captured: { name: string; email: string; phone: string }
  /** True when this viewer may not see the address or number (see lib/pii.ts).
   *  The values above are already masked; this only tells the UI to stop
   *  rendering them as mailto:/tel: links nobody can use. */
  contactsHidden?: boolean
  /** True when this viewer's email can only go to the lead itself — every
   *  non-admin. The server enforces it either way; this stops the composer
   *  offering a To box whose contents would be silently replaced. */
  recipientLocked?: boolean
  overriddenFields: string[]
  owner: string | null
  stage: CrmStage
  stageBy: string
  stageAt: string | null
  value: { estimated: number | null; won: number | null; currency: CrmCurrency }
  followUps: FollowUpSummary
  createdAt: string | null
  firstSeenAt: string | null
  lastActivityAt: string | null
  lastContactedAt: string | null
  /** When the customer last emailed back, if ever. */
  lastReplyAt: string | null
  /** Replies nobody has opened yet — what makes a lead "waiting on us". */
  unreadReplies: number
  country: string | null
  referrer: string | null
  tags: string[]
  quoteMessage: string | null
  notes: CrmNoteEntry[]
  /** Still open, soonest due first. */
  openTasks: CrmTaskEntry[]
  /** Most recently finished first, for the collapsed "done" list. */
  doneTasks: CrmTaskEntry[]
  attachments: (AttachmentInfo & { at: string; by: string })[]
  related: RelatedLead[]
  timeline: TimelineEvent[]
  assignableMembers: string[]
  messageCount: number
}

interface LogRow {
  id?: number | string
  session_id: string
  site_id: string
  role: string
  message: string
  created_at: string
}

interface LeadRow {
  id: string
  site_id: string
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  created_at: string
}

// ── Site resolution ──────────────────────────────────────────────────────────
// A record's site decides who may see it, so this must never guess. A chat
// record takes its site from its own chat_logs rows; an email-only record takes
// it from the leads row its synthetic id points at.
export async function resolveLeadSite(id: string): Promise<{ siteId: string; lead: LeadRow | null } | null> {
  if (isQuoteSessionId(id)) {
    const leadId = id.slice('quote-'.length)
    if (!leadId) return null
    const { data } = await supabase
      .from('leads')
      .select('id, site_id, name, email, phone, message, created_at')
      .eq('id', leadId)
      .maybeSingle()
    return data?.site_id ? { siteId: data.site_id, lead: data as LeadRow } : null
  }
  const { data } = await supabase
    .from('chat_logs')
    .select('site_id')
    .eq('session_id', id)
    .limit(1)
    .maybeSingle()
  return data?.site_id ? { siteId: data.site_id, lead: null } : null
}

const AGENT_LABEL = (email: string) => (email ? email.split('@')[0] : 'Agent')

// Every /api/leads route funnels through this: the record must exist AND belong
// to a site this member is allowed to see. Hiding the link is not enough —
// a standard member typing the id of another site's lead must be refused here.
export type LeadAccess =
  | { ok: true; member: Member; siteId: string }
  | { ok: false; status: 401 | 403 | 404 }

// `feature` is the workspace gate (lib/workspaces.ts). Passing it here rather
// than repeating the check in each handler is what keeps a multi-verb route
// (tasks has POST/PATCH/DELETE, email has its own set) from gating three of
// four by accident. Packaging carries every feature, so this is a no-op there.
export async function guardLeadAccess(
  member: Member | null, id: string, feature?: WorkspaceFeature,
): Promise<LeadAccess> {
  if (!member) return { ok: false, status: 401 }
  if (feature && !hasFeature(member.workspace, feature)) return { ok: false, status: 403 }
  if (!id) return { ok: false, status: 404 }
  const resolved = await resolveLeadSite(id)
  if (!resolved) return { ok: false, status: 404 }
  if (!canAccessSite(member, resolved.siteId)) return { ok: false, status: 403 }
  return { ok: true, member, siteId: resolved.siteId }
}

// Append a CRM control row. `at` may be shared by two rows on purpose (see the
// stage endpoint) — chat_logs.created_at is settable on insert.
export async function writeControlRow(
  opts: { sessionId: string; siteId: string; role: string; message: string; at?: string },
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('chat_logs').insert({
    site_id: opts.siteId,
    session_id: opts.sessionId,
    role: opts.role,
    message: opts.message,
    ...(opts.at ? { created_at: opts.at } : {}),
  })
  return { error: error?.message ?? null }
}

// ── The record ───────────────────────────────────────────────────────────────
/**
 * The lead's REAL email address, for the server to send to.
 *
 * Needed because an agent who may not see contacts is served a masked address,
 * so the recipient the browser posts back is "•••••• hidden" — the send has to
 * resolve the real one here rather than trust the request. That is the whole
 * point: the CRM can email someone the agent cannot read the address of.
 */
/**
 * Answering a reply is what "I have seen this" means.
 *
 * The unread badge says AWAITING YOUR REPLY, and it used to survive the reply —
 * it only cleared when somebody expanded the message on the timeline, so a lead
 * you had already answered went on nagging. Sending now marks the inbound
 * messages ON THAT THREAD read.
 *
 * Deliberately scoped to the thread, not the whole lead: a second conversation
 * with the same customer can be genuinely unanswered, and clearing it because
 * you replied to a different one would hide real work. Append-only like every
 * read marker, so the audit trail keeps who cleared it and when.
 */
/** The lead's REAL phone number, for the server to message. Same reasoning as
 *  leadRecipient: an agent who may not see it still has to be able to use it. */
export async function leadPhone(id: string): Promise<string | null> {
  const resolved = await resolveLeadSite(id)
  if (resolved?.lead?.phone) return resolved.lead.phone.trim() || null

  const { data } = await supabase.from('chat_logs')
    .select('role, message, created_at')
    .eq('session_id', id)
    .in('role', [CONTACT_ROLE, LEAD_CAPTURE_ROLE])
    .order('created_at', { ascending: true })
  let phone = ''
  for (const r of data ?? []) {
    if (r.role === CONTACT_ROLE) { const c = parseContact(r.message); if (c.phone) phone = c.phone }
    else { const c = parseLeadCapture(r.message); if (c?.phone) phone = c.phone }
  }
  return phone.trim() || null
}

export async function markThreadRepliesRead(
  id: string, siteId: string, threadId: string | null | undefined, by: string,
): Promise<number> {
  if (!threadId) return 0
  const { data } = await supabase.from('chat_logs')
    .select('role, message')
    .eq('session_id', id)
    .in('role', [CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE])
    .order('created_at', { ascending: true })

  const inbound = new Map<string, string>()   // gmailId -> threadId
  const read = new Set<string>()
  for (const r of data ?? []) {
    if (r.role === CRM_EMAIL_IN_ROLE) {
      const e = parseCrmEmailIn(r.message)
      if (e) inbound.set(e.gmailId, e.threadId)
    } else {
      const rd = parseCrmEmailRead(r.message)
      if (rd) read.add(rd.gmailId)
    }
  }

  const at = new Date().toISOString()
  let marked = 0
  for (const [gmailId, thread] of inbound) {
    if (thread !== threadId || read.has(gmailId)) continue
    await writeControlRow({
      sessionId: id, siteId, role: CRM_EMAIL_READ_ROLE, at,
      message: JSON.stringify({ gmailId, by, at }),
    })
    marked++
  }
  return marked
}

export async function leadRecipient(id: string): Promise<string | null> {
  const resolved = await resolveLeadSite(id)
  if (resolved?.lead?.email) return resolved.lead.email.trim() || null

  // A chat lead's address lives in its control rows; ascending, so the newest
  // wins — the same fold the record page uses.
  const { data } = await supabase.from('chat_logs')
    .select('role, message, created_at')
    .eq('session_id', id)
    .in('role', [CONTACT_ROLE, LEAD_CAPTURE_ROLE])
    .order('created_at', { ascending: true })
  let email = ''
  for (const r of data ?? []) {
    if (r.role === CONTACT_ROLE) { const c = parseContact(r.message); if (c.email) email = c.email }
    else { const c = parseLeadCapture(r.message); if (c?.email) email = c.email }
  }
  return email.trim() || null
}

export async function loadLeadRecord(member: Member, id: string): Promise<LeadRecord | null> {
  const resolved = await resolveLeadSite(id)
  if (!resolved) return null
  const { siteId } = resolved
  if (!canAccessSite(member, siteId)) return null

  const [logs, siteRes, visRes, membersRes] = await Promise.all([
    // A single conversation is small; paging keeps a pathological one (a bot
    // loop, a months-long thread) from being silently truncated at 1000 rows.
    fetchAllPages<LogRow>(
      () => supabase
        .from('chat_logs')
        .select('id, session_id, site_id, role, message, created_at')
        .eq('session_id', id)
        .order('created_at', { ascending: true }),
      5000),
    supabase.from('sites').select('site_id, name').eq('site_id', siteId).maybeSingle(),
    supabase.from('active_visitors').select('created_at, country, page_url').eq('session_id', id).maybeSingle(),
    supabase.from('members').select('email, role, assigned_sites').eq('workspace', member.workspace),
  ])

  const siteName = siteRes.data?.name ?? siteId

  // ── Control-row state (newest row of each role wins) ───────────────────────
  let capture = { name: '', email: '', phone: '' }
  let capturedAt: string | null = null
  let capturedManual = false
  let contact = { name: '', email: '', phone: '' }
  let owner: string | null = null
  let tags: string[] = []
  let stage: CrmStage | null = null
  let stageBy = ''
  let stageAt: string | null = null
  let value = { estimated: null as number | null, won: null as number | null, currency: DEFAULT_CURRENCY as CrmCurrency }
  const overrides = new Map<string, string>()
  const notesById = new Map<string, CrmNoteEntry>()
  const tasksById = new Map<string, CrmTaskEntry>()
  const emailsSent: CrmEmailEntry[] = []
  const emailsIn = new Map<string, CrmEmailInEntry>()   // gmailId -> reply
  const readIds = new Set<string>()
  const authorByAt = new Map<string, string>()
  // Setting a stage from this page writes a crm_stage row AND a legacy
  // lead_status row sharing one created_at, so Billing stays in sync. Collect
  // those timestamps first: the paired legacy row is then skipped everywhere,
  // both as current state (it maps back to a coarser stage) and in the
  // timeline (it's the same event, not a second one).
  const stageRowAt = new Set<string>()
  for (const row of logs) if (row.role === CRM_STAGE_ROLE) stageRowAt.add(row.created_at)

  for (const row of logs) {
    switch (row.role) {
      case LEAD_CAPTURE_ROLE: {
        const c = parseLeadCapture(row.message)
        if (c) {
          capture = { name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '' }
          capturedAt = c.at || row.created_at
          capturedManual = c.manual === true
        }
        break
      }
      case CONTACT_ROLE: {
        const c = parseContact(row.message)
        contact = { name: c.name, email: c.email, phone: c.phone }
        break
      }
      case TAGS_ROLE:
        tags = parseTags(row.message)
        break
      case ASSIGNMENT_ROLE:
        owner = (row.message ?? '').trim() || null
        break
      case REPLY_AUTHOR_ROLE: {
        const a = parseReplyAuthor(row.message)
        if (a?.email) authorByAt.set(row.created_at, a.email)
        break
      }
      case LEAD_STATUS_ROLE: {
        // Rows are ascending, so the newest stage-bearing row of either role
        // wins — a status set later from Billing correctly moves the stage.
        if (stageRowAt.has(row.created_at)) break
        const s = parseLeadStatus(row.message)
        const mapped = stageFromLeadStatus(s?.status)
        if (mapped) { stage = mapped; stageBy = s?.by ?? ''; stageAt = row.created_at }
        break
      }
      case CRM_STAGE_ROLE: {
        const s = parseCrmStage(row.message)
        if (s) { stage = s.stage; stageBy = s.changed_by; stageAt = row.created_at }
        break
      }
      case CRM_FIELD_ROLE: {
        const f = parseCrmField(row.message)
        if (f) overrides.set(f.field, f.value)
        break
      }
      case CRM_VALUE_ROLE: {
        const v = parseCrmValue(row.message)
        if (v) value = { estimated: v.estimated, won: v.won, currency: v.currency }
        break
      }
      case CRM_NOTE_ROLE: {
        const n = parseCrmNote(row.message)
        if (n) notesById.set(n.id, n) // ascending → newest revision of each note wins
        break
      }
      case CRM_TASK_ROLE: {
        const t = parseCrmTask(row.message)
        if (t) tasksById.set(t.id, t) // same rule: newest revision of each task wins
        break
      }
      case CRM_EMAIL_ROLE: {
        // An email we sent is a contact, so it counts as an outbound touch just
        // like an agent reply — it moves "last contacted" and feeds follow-ups.
        const e = parseCrmEmail(row.message)
        if (e) emailsSent.push(e)
        break
      }
      case CRM_EMAIL_IN_ROLE: {
        // Deduped on Gmail's message id, so a re-captured reply cannot appear
        // twice even if the sweep wrote it more than once.
        const e = parseCrmEmailIn(row.message)
        if (e) emailsIn.set(e.gmailId, e)
        break
      }
      case CRM_EMAIL_READ_ROLE: {
        const r = parseCrmEmailRead(row.message)
        if (r) readIds.add(r.gmailId)
        break
      }
    }
  }

  const calls = new Map<string, CallEntry>()
  const waMessages = new Map<string, { w: WaMessage; at: string }>()
  const lead = resolved.lead
  const kind: LeadKind = !lead ? 'chat' : isCheckoutLeadMessage(lead.message) ? 'checkout' : isQuoteLeadMessage(lead.message) ? 'quote' : 'chat'

  // Effective contact: a manual override beats the agent-entered contact row,
  // which beats what was captured automatically, which beats the leads row.
  const pick = (field: 'name' | 'email' | 'phone') =>
    overrides.get(field) ?? (contact[field] || capture[field] || (lead?.[field] ?? '') || '')
  const effective = { name: pick('name'), email: pick('email'), phone: pick('phone') }

  // ── Messages ──────────────────────────────────────────────────────────────
  const messages = logs.filter((r) => r.role === 'user' || r.role === 'admin' || r.role === 'assistant' || r.role === 'visitor')
  const realMessages = messages.filter((m) => m.message !== '(session started)')
  const attachments: (AttachmentInfo & { at: string; by: string })[] = []
  const outboundAt: string[] = []
  let lastContactedAt: string | null = null

  for (const m of realMessages) {
    const att = parseAttachment(m.message)
    if (att) {
      attachments.push({
        ...att,
        at: asUtcIso(m.created_at) as string,
        by: m.role === 'admin' ? AGENT_LABEL(authorByAt.get(m.created_at) ?? '') : 'Visitor',
      })
    }
    if (m.role === 'admin') {
      outboundAt.push(asUtcIso(m.created_at) as string)
      lastContactedAt = asUtcIso(m.created_at)
    }
  }

  // An email we sent is an outbound touch too: it moves "last contacted" and
  // counts toward the follow-up tally, exactly like an agent reply in chat.
  for (const e of emailsSent) {
    const at = asUtcIso(e.at)
    if (!at) continue
    outboundAt.push(at)
    if (!lastContactedAt || at > lastContactedAt) lastContactedAt = at
  }

  // A WhatsApp message we sent is an outbound touch for the same reason an
  // email is — it is us reaching the customer.
  for (const row of logs) {
    if (row.role !== CRM_WA_OUT_ROLE) continue
    const at = asUtcIso(row.created_at)
    if (!at) continue
    outboundAt.push(at)
    if (!lastContactedAt || at > lastContactedAt) lastContactedAt = at
  }

  // A customer reply is deliberately NOT an outbound touch: `lastContactedAt`
  // measures OUR outreach and feeds the follow-up cadence, so folding an
  // inbound message into it would make a lead we have ignored look freshly
  // worked. The reply gets its own timestamp instead, and the unread count is
  // what says the ball is in our court.
  let lastReplyAt: string | null = null
  for (const e of emailsIn.values()) {
    const at = asUtcIso(e.at)
    if (at && (!lastReplyAt || at > lastReplyAt)) lastReplyAt = at
  }
  const unreadReplies = [...emailsIn.values()].filter((e) => !readIds.has(e.gmailId)).length

  const createdAt = asUtcIso(capturedAt ?? lead?.created_at ?? logs[0]?.created_at ?? null)
  const firstSeenAt = asUtcIso(visRes.data?.created_at ?? logs[0]?.created_at ?? lead?.created_at ?? null)
  const lastLog = logs[logs.length - 1]
  const lastActivityAt = asUtcIso(lastLog?.created_at ?? lead?.created_at ?? null)

  // ── Timeline ──────────────────────────────────────────────────────────────
  const timeline: TimelineEvent[] = []
  const push = (e: TimelineEvent) => timeline.push(e)
  // Previous revision of each task id, rebuilt as the loop walks forward.
  const seenTask = new Map<string, CrmTaskEntry>()

  push({
    id: 'created',
    at: createdAt ?? new Date().toISOString(),
    kind: 'created',
    group: 'system',
    actor: kind === 'chat' ? 'Visitor' : 'Inbox',
    title: kind === 'checkout' ? 'Checkout order received'
      : kind === 'quote' ? 'Quote request received'
      : capturedManual ? 'Marked as a lead by an agent'
      : capturedAt ? 'Lead captured — visitor shared contact details'
      : 'Conversation started',
    body: effective.email || undefined,
  })

  for (const row of logs) {
    const at = asUtcIso(row.created_at) as string
    if (row.role === 'user' || row.role === 'visitor' || row.role === 'admin' || row.role === 'assistant') {
      if (row.message === '(session started)') continue
      const att = parseAttachment(row.message)
      const actor = row.role === 'admin'
        ? AGENT_LABEL(authorByAt.get(row.created_at) ?? '')
        : row.role === 'assistant' ? 'Bot' : 'Visitor'
      if (att) {
        push({ id: `att-${row.id ?? at}`, at, kind: 'attachment', group: 'messages', actor, title: `Shared a file — ${att.name}`, attachment: att })
      } else {
        push({ id: `msg-${row.id ?? at}`, at, kind: 'message', group: 'messages', actor, title: row.role === 'admin' ? 'Agent replied' : row.role === 'assistant' ? 'Bot replied' : 'Visitor message', body: row.message })
      }
      continue
    }
    if (row.role === CRM_STAGE_ROLE) {
      const s = parseCrmStage(row.message)
      if (s) push({ id: `stage-${row.id ?? at}`, at, kind: 'stage', group: 'stage', actor: AGENT_LABEL(s.changed_by), title: 'Stage changed', stage: s.stage, body: s.previous ?? undefined })
      continue
    }
    if (row.role === LEAD_STATUS_ROLE) {
      // A stage set from this page writes both rows with an identical
      // created_at (same trick reply_author uses), so the legacy row is the
      // same event — only surface it when it came from somewhere else, i.e.
      // the Billing tab's status dropdown.
      if (stageRowAt.has(row.created_at)) continue
      const s = parseLeadStatus(row.message)
      const mapped = stageFromLeadStatus(s?.status)
      if (mapped) push({ id: `status-${row.id ?? at}`, at, kind: 'stage', group: 'stage', actor: AGENT_LABEL(s?.by ?? ''), title: 'Status set from Billing', stage: mapped })
      continue
    }
    if (row.role === ASSIGNMENT_ROLE) {
      const email = (row.message ?? '').trim()
      push({ id: `assign-${row.id ?? at}`, at, kind: 'assign', group: 'system', actor: email ? AGENT_LABEL(email) : 'System', title: email ? `Assigned to ${AGENT_LABEL(email)}` : 'Released — back to the unassigned pool' })
      continue
    }
    if (row.role === CRM_FIELD_ROLE) {
      const f = parseCrmField(row.message)
      if (f) push({ id: `field-${row.id ?? at}`, at, kind: 'field', group: 'system', actor: AGENT_LABEL(f.updated_by), title: `${f.field[0].toUpperCase()}${f.field.slice(1)} updated`, body: f.value || '(cleared)' })
      continue
    }
    if (row.role === CRM_VALUE_ROLE) {
      const v = parseCrmValue(row.message)
      if (v) push({ id: `value-${row.id ?? at}`, at, kind: 'value', group: 'system', actor: AGENT_LABEL(v.updated_by), title: 'Deal value updated', body: JSON.stringify({ estimated: v.estimated, won: v.won, currency: v.currency }) })
      continue
    }
    if (row.role === CRM_NOTE_ROLE) {
      const n = parseCrmNote(row.message)
      if (!n) continue
      push({
        id: `note-${row.id ?? at}`, at, kind: 'note', group: 'notes', actor: AGENT_LABEL(n.author),
        title: n.deleted ? 'Note deleted' : n.edited_at ? 'Note edited' : 'Note added',
        body: n.deleted ? undefined : n.body, noteId: n.id, editedAt: n.edited_at,
      })
      continue
    }
    if (row.role === CRM_EMAIL_ROLE) {
      const e = parseCrmEmail(row.message)
      if (e) {
        push({
          id: `email-${row.id ?? at}`, at, kind: 'email', group: 'messages',
          actor: AGENT_LABEL(e.sentBy), title: `Emailed ${e.to}`,
          body: e.subject, email: e,
        })
      }
      continue
    }
    if (row.role === CRM_EMAIL_IN_ROLE) {
      // Emitted after the loop from the deduped map — see below. Skipping here
      // keeps one event per reply even if the sweep wrote the row twice.
      continue
    }
    if (row.role === CRM_CALL_ROLE) {
      // Two rows share a SID — one when it was dialled, one when it ended — so
      // they are folded after the loop into a single event rather than showing
      // the same call twice.
      const c = parseCall(row.message)
      if (c) calls.set(c.sid, c)
      continue
    }
    if (row.role === CRM_WA_OUT_ROLE || row.role === CRM_WA_IN_ROLE) {
      // An outbound message can have SEVERAL rows: one when it was accepted,
      // then one per delivery update. They are folded by SID after the loop —
      // newest wins — so the timeline shows one message whose title reflects
      // what finally happened, rather than the same line three times.
      const w = parseWaMessage(row.message)
      if (w) waMessages.set(w.sid || `row-${row.id ?? at}`, { w, at })
      continue
    }
    if (row.role === CRM_TASK_ROLE) {
      const t = parseCrmTask(row.message)
      if (!t) continue
      // Each row is one revision, so what CHANGED is only knowable by diffing
      // against the revision before it. seenTask holds the previous state of
      // every task id as we walk forward in time.
      const prev = seenTask.get(t.id)
      seenTask.set(t.id, t)
      const actor = AGENT_LABEL(t.updated_by || t.completed_by || t.created_by)
      let title: string
      if (!prev) title = 'Task created'
      else if (t.deleted && !prev.deleted) title = 'Task deleted'
      else if (t.status === 'done' && prev.status !== 'done') title = 'Task completed'
      else if (t.status === 'open' && prev.status === 'done') title = 'Task reopened'
      else if (t.assignee !== prev.assignee) {
        title = t.assignee ? `Task reassigned to ${AGENT_LABEL(t.assignee)}` : 'Task unassigned'
      } else if (t.due_at !== prev.due_at) title = 'Task rescheduled'
      else title = 'Task updated'

      push({
        id: `task-${row.id ?? at}`, at, kind: 'task', group: 'tasks', actor, title,
        body: t.title, taskType: t.type, taskDone: t.status === 'done',
      })
      continue
    }
  }

  // Inbound replies, one event per Gmail message id.
  //
  // Emitted from the deduped map rather than inline in the row loop above: the
  // loop parses each row afresh, so the previous identity check
  // (`emailsIn.get(id) === parsed`) compared two different objects and was
  // never true — the header counted three replies while the timeline showed
  // none. Iterating the map cannot drift from the count for the same reason it
  // produces it.
  for (const e of emailsIn.values()) {
    const at = asUtcIso(e.at)
    if (!at) continue
    push({
      id: `email-in-${e.gmailId}`, at, kind: 'email_in', group: 'messages',
      actor: e.fromName || e.from, title: 'Replied by email',
      body: e.subject, inbound: e, unread: !readIds.has(e.gmailId),
    })
  }

  // ── email attachments ─────────────────────────────────────────────────────
  // Stored as bucket PATHS, never URLs, so a link cannot outlive the session it
  // was shown in. Every path on the record is signed in one batched call here,
  // and the resulting hour-long URLs are what the timeline and the Attachments
  // panel render. They also join the panel that already lists chat files, so an
  // agent has one place to look for "what has been exchanged".
  const emailFiles: { att: EmailAttachment; at: string; by: string }[] = []
  for (const e of emailsSent) {
    for (const a of e.attachments ?? []) emailFiles.push({ att: a, at: asUtcIso(e.at) ?? '', by: AGENT_LABEL(e.sentBy) })
  }
  for (const e of emailsIn.values()) {
    for (const a of e.attachments ?? []) emailFiles.push({ att: a, at: asUtcIso(e.at) ?? '', by: e.fromName || e.from })
  }
  const signed = await signAttachments(emailFiles.map((f) => f.att))
  const signedByPath = new Map(signed.map((s) => [s.path, s.url]))
  emailFiles.forEach((f, i) => {
    const url = signed[i]?.url
    if (!url) return
    attachments.push({ url, name: f.att.name, mime: f.att.mime, size: f.att.size, at: f.at, by: f.by })
  })
  // Hand the signed URLs to the timeline entries too, so a file can be opened
  // straight from the message it arrived with.
  for (const ev of timeline) {
    const list = ev.kind === 'email' ? ev.email?.attachments : ev.kind === 'email_in' ? ev.inbound?.attachments : null
    if (!list?.length) continue
    ev.files = list.map((a) => ({ name: a.name, mime: a.mime, size: a.size, url: signedByPath.get(a.path) ?? null }))
  }

  // One event per WhatsApp message, from the folded map. `at` is the FIRST
  // row's timestamp — when it was sent — not the delivery report's, or a
  // message would jump down the timeline minutes after it was written.
  for (const { w, at } of waMessages.values()) {
    const outbound = w.direction === 'outbound'
    const label = waDeliveryLabel(w)
    push({
      id: `wa-${w.sid || at}`, at, kind: outbound ? 'wa_out' : 'wa_in', group: 'messages',
      actor: outbound ? AGENT_LABEL(w.sentBy ?? '') : 'Customer',
      // The number is NOT in the title: a masked record would otherwise leak it
      // in the one line that is always visible.
      title: label.title,
      body: label.failed ? [w.body, waErrorHint(w.errorCode)].filter(Boolean).join('\n\n') : w.body,
      wa: w,
    })
  }

  // One event per call, from the folded map. A call that is still ringing says
  // so; a finished one carries how long it lasted, which is the number anybody
  // reading the record actually wants.
  for (const c of calls.values()) {
    const at = asUtcIso(c.at)
    if (!at) continue
    const len = callDurationLabel(c.duration)
    const answered = (c.duration ?? 0) > 0
    push({
      id: `call-${c.sid}`, at, kind: 'call', group: 'messages',
      // 'voicemail' and 'inbound' are the customer reaching US; everything
      // else is a call an agent placed.
      actor: c.status === 'voicemail' || c.status === 'inbound' ? 'Customer' : AGENT_LABEL(c.by),
      title: c.status === 'voicemail' ? `Voicemail${len ? ` — ${len}` : ''}`
        : c.status === 'inbound' ? `Incoming call${len ? ` — ${len}` : ''}`
        : c.status === 'ringing' ? 'Calling…'
        : answered ? `Called — ${len}`
        : `Call not answered (${c.status})`,
      call: c,
    })
    // A call we placed is an outbound touch, like an email or a WhatsApp
    // message — it is us reaching the customer.
    // A voicemail is the customer reaching US, so it is deliberately not an
    // outbound touch — the same rule an inbound email follows.
    if (answered && c.status !== 'voicemail' && c.status !== 'inbound') {
      outboundAt.push(at)
      if (!lastContactedAt || at > lastContactedAt) lastContactedAt = at
    }
  }

  timeline.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  // ── Related leads (same person, any site the member can see) ───────────────
  const related = await findRelatedLeads(member, { id, email: effective.email, phone: effective.phone })

  // ── Assignable owners ─────────────────────────────────────────────────────
  const wsSites = new Set(workspaceSites(member.workspace))
  const assignable = new Set<string>()
  for (const m of membersRes.data ?? []) {
    if (m.role === 'admin' || (m.assigned_sites ?? []).includes(siteId)) assignable.add(m.email)
  }
  if (wsSites.has(siteId)) assignable.add(member.email) // built-in workspace admins have no members row
  if (owner) assignable.add(owner)

  const notes = Array.from(notesById.values())
    .filter((n) => !n.deleted)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())

  const liveTasks = Array.from(tasksById.values()).filter((t) => !t.deleted)
  const openTasks = liveTasks.filter((t) => t.status === 'open').sort(byDueAsc)
  const doneTasks = liveTasks.filter((t) => t.status === 'done').sort(byCompletedDesc)

  const record: LeadRecord = {
    recipientLocked: member.role !== 'admin',
    id,
    siteId,
    siteName,
    kind,
    sourceLabel: kind === 'checkout' ? 'Checkout order (email)' : kind === 'quote' ? 'Custom quote (email)' : 'Chat widget',
    hasConversation: realMessages.length > 0,
    contact: effective,
    captured: {
      name: capture.name || contact.name || lead?.name || '',
      email: capture.email || contact.email || lead?.email || '',
      phone: capture.phone || contact.phone || lead?.phone || '',
    },
    overriddenFields: Array.from(overrides.keys()),
    owner,
    stage: stage ?? 'new',
    stageBy,
    stageAt: asUtcIso(stageAt),
    value,
    followUps: deriveFollowUps(outboundAt),
    createdAt,
    firstSeenAt,
    lastActivityAt,
    lastContactedAt,
    lastReplyAt,
    unreadReplies,
    country: visRes.data?.country ?? null,
    referrer: referrerOf(visRes.data?.page_url ?? null),
    tags,
    quoteMessage: lead?.message ? stripQuoteTag(lead.message) : null,
    notes,
    openTasks,
    doneTasks,
    attachments: attachments.reverse(),
    related,
    timeline,
    assignableMembers: Array.from(assignable).sort(),
    messageCount: realMessages.length,
  }

  return canSeeContacts(member) ? record : hideContacts(record)
}

/**
 * The record as an agent who may not see contacts gets it.
 *
 * Every field that can carry an address or a number, not just the two obvious
 * ones. The list was built by reading the payload rather than by guessing, and
 * these are the ones that actually carry it:
 *   • contact / captured — the columns themselves, and the NAME, which falls
 *     back to the email whenever a lead arrived without one
 *   • quoteMessage — the entire original form email, "Email: … Phone: …" and all
 *   • notes — free text somebody may well have pasted an address into
 *   • timeline messages — a chat transcript is whatever the visitor typed
 *   • sent email — `to`, `cc`, subject and body (the body carries the quoted
 *     chain); `from` is OUR OWN alias and stays, since the agent picks it
 *   • inbound replies — `from` is the customer, and the body is theirs
 *   • related leads — the same person's other leads, matched on the contact
 *
 * The stored data is untouched. This is a read edge: an admin still sees all of
 * it, and nothing here is destructive.
 */
function hideContacts(rec: LeadRecord): LeadRecord {
  const softName = (n: string) => (/@/.test(n) || /\d{7,}/.test(n) ? (scrubText(n) ?? '') : n)
  // A file the CUSTOMER sent is the one thing text-scrubbing cannot reach: a
  // purchase order, a letterhead or a business card carries the address as
  // pixels. So an agent gets the fact that a file exists — not the file, and
  // not its name, which is itself often "john_+15125550142.pdf".
  const hideFile = (f: { name: string; mime: string; size: number; url: string | null }) =>
    ({ ...f, name: 'Attachment (hidden)', url: null })

  return {
    ...rec,
    contactsHidden: true,
    // Widget uploads are the visitor's own files, so they go the same way.
    attachments: [],
    contact: { name: softName(rec.contact.name), email: rec.contact.email ? HIDDEN_EMAIL : '', phone: rec.contact.phone ? HIDDEN_PHONE : '' },
    captured: { name: softName(rec.captured.name), email: rec.captured.email ? HIDDEN_EMAIL : '', phone: rec.captured.phone ? HIDDEN_PHONE : '' },
    quoteMessage: scrubText(rec.quoteMessage),
    notes: rec.notes.map((n) => ({ ...n, body: scrubText(n.body) ?? '' })),
    related: rec.related.map((r) => ({
      ...r, name: r.name ? softName(r.name) : r.name, email: maskEmail(r.email), phone: maskPhone(r.phone),
    })),
    timeline: rec.timeline.map((e) => ({
      ...e,
      title: scrubText(e.title) ?? '',
      body: e.body === undefined ? undefined : (scrubText(e.body) ?? ''),
      email: e.email && {
        ...e.email,
        to: HIDDEN_EMAIL,
        cc: e.email.cc ? HIDDEN_EMAIL : e.email.cc,
        subject: scrubText(e.email.subject) ?? '',
        body: scrubText(e.email.body) ?? '',
        snippet: scrubText(e.email.snippet) ?? '',
      },
      files: e.kind === 'email_in' && e.files ? e.files.map(hideFile) : e.files,
      wa: e.wa && { ...e.wa, from: HIDDEN_PHONE, to: HIDDEN_PHONE, body: scrubText(e.wa.body) ?? '' },
      inbound: e.inbound && {
        ...e.inbound,
        from: HIDDEN_EMAIL,
        to: HIDDEN_EMAIL,
        subject: scrubText(e.inbound.subject) ?? '',
        body: scrubText(e.inbound.body) ?? '',
        // The quoted chain and the signature the reply was trimmed of — which
        // is exactly where a customer's own phone number and address live.
        quoted: scrubText(e.inbound.quoted),
        snippet: scrubText(e.inbound.snippet) ?? '',
        // Names too: a file arrives called "quote_john_+15125550142.pdf" often
        // enough that leaving the name while hiding the file would be theatre.
        attachments: e.inbound.attachments?.map((a) => ({ ...a, name: 'Attachment (hidden)' })),
        skippedAttachments: e.inbound.skippedAttachments?.map((a) => ({ ...a, name: 'Attachment (hidden)' })),
      },
    })),
  }
}

// active_visitors packs the original referrer into its page_url JSON blob (see
// lib/visitor.ts). Only the referrer is needed here, so it's read directly
// rather than pulling in the full unpack.
function referrerOf(packed: string | null): string | null {
  if (!packed) return null
  try {
    const o = JSON.parse(packed)
    return typeof o?.r === 'string' && o.r ? o.r : null
  } catch {
    return null
  }
}

// The same-party rule lives in lib/identity.ts so search groups results by
// exactly the rule Related Leads matches on.

// Other leads from the same person — matched on email or phone, across every
// site the member is allowed to see (never beyond: a shared email must not
// reveal that a site they have no access to exists).
export async function findRelatedLeads(
  member: Member,
  self: { id: string; email: string; phone: string },
): Promise<RelatedLead[]> {
  const email = self.email.trim().toLowerCase()
  const phone = digitsOnly(self.phone)
  if (!email && phone.length < 7) return []

  const allowed = memberSites(member)
  if (allowed.length === 0) return []

  const [leadsRes, captureRes, sitesRes] = await Promise.all([
    email
      ? supabase.from('leads').select('id, site_id, name, email, phone, message, created_at')
          .ilike('email', email).in('site_id', allowed).limit(200)
      : Promise.resolve({ data: [] as LeadRow[] }),
    // lead_capture rows keep the email inside their JSON, so this is a LIKE
    // scan — bounded by site scope and a hard limit, and only ever run on a
    // record page load (never on a poll).
    email
      ? supabase.from('chat_logs').select('session_id, site_id, message, created_at')
          .eq('role', LEAD_CAPTURE_ROLE).in('site_id', allowed)
          .ilike('message', `%${email}%`).limit(200)
      : Promise.resolve({ data: [] as { session_id: string; site_id: string; message: string; created_at: string }[] }),
    supabase.from('sites').select('site_id, name'),
  ])

  const siteName: Record<string, string> = {}
  for (const s of sitesRes.data ?? []) siteName[s.site_id] = s.name

  const out = new Map<string, RelatedLead>()

  for (const r of (captureRes.data ?? []) as { session_id: string; site_id: string; message: string; created_at: string }[]) {
    if (r.session_id === self.id) continue
    const c = parseLeadCapture(r.message)
    const rowEmail = (c?.email ?? '').toLowerCase()
    const matchedOn = rowEmail && rowEmail === email ? 'email' : samePhone(c?.phone, self.phone) ? 'phone' : null
    if (!matchedOn) continue
    out.set(r.session_id, {
      id: r.session_id, siteId: r.site_id, siteName: siteName[r.site_id] ?? r.site_id,
      name: c?.name ?? null, email: c?.email ?? null, phone: c?.phone ?? null,
      at: asUtcIso(c?.at || r.created_at) as string, kind: 'chat', matchedOn,
    })
  }

  for (const l of (leadsRes.data ?? []) as LeadRow[]) {
    const recordId = quoteSessionId(l.id)
    if (recordId === self.id) continue
    const rowEmail = (l.email ?? '').toLowerCase()
    const matchedOn = rowEmail && rowEmail === email ? 'email' : samePhone(l.phone, self.phone) ? 'phone' : null
    if (!matchedOn) continue
    // A chat lead already surfaced above via its lead_capture row is the same
    // person on the same site — don't list it twice under two ids.
    const dupe = Array.from(out.values()).some(
      (r) => r.siteId === l.site_id && (r.email ?? '').toLowerCase() === rowEmail && r.kind === 'chat' &&
        !isCheckoutLeadMessage(l.message) && !isQuoteLeadMessage(l.message))
    if (dupe) continue
    out.set(recordId, {
      id: recordId, siteId: l.site_id, siteName: siteName[l.site_id] ?? l.site_id,
      name: l.name, email: l.email, phone: l.phone,
      at: asUtcIso(l.created_at) as string,
      kind: isCheckoutLeadMessage(l.message) ? 'checkout' : isQuoteLeadMessage(l.message) ? 'quote' : 'chat',
      matchedOn,
    })
  }

  return Array.from(out.values()).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 25)
}
