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
import { workspaceSites } from './workspaces'
import {
  CRM_STAGE_ROLE, CRM_NOTE_ROLE, CRM_FIELD_ROLE, CRM_VALUE_ROLE,
  parseCrmStage, parseCrmNote, parseCrmField, parseCrmValue,
  stageFromLeadStatus, deriveFollowUps, DEFAULT_CURRENCY,
  type CrmStage, type CrmNoteEntry, type CrmCurrency, type FollowUpSummary,
} from './crm'

export type LeadKind = 'chat' | 'quote' | 'checkout'

export interface TimelineEvent {
  id: string
  at: string
  kind: 'created' | 'message' | 'note' | 'stage' | 'assign' | 'attachment' | 'field' | 'value'
  group: 'messages' | 'notes' | 'stage' | 'system'
  actor: string
  title: string
  body?: string
  stage?: CrmStage
  attachment?: AttachmentInfo
  noteId?: string
  editedAt?: string
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
  country: string | null
  referrer: string | null
  tags: string[]
  quoteMessage: string | null
  notes: CrmNoteEntry[]
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

export async function guardLeadAccess(member: Member | null, id: string): Promise<LeadAccess> {
  if (!member) return { ok: false, status: 401 }
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
    }
  }

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

  const createdAt = asUtcIso(capturedAt ?? lead?.created_at ?? logs[0]?.created_at ?? null)
  const firstSeenAt = asUtcIso(visRes.data?.created_at ?? logs[0]?.created_at ?? lead?.created_at ?? null)
  const lastLog = logs[logs.length - 1]
  const lastActivityAt = asUtcIso(lastLog?.created_at ?? lead?.created_at ?? null)

  // ── Timeline ──────────────────────────────────────────────────────────────
  const timeline: TimelineEvent[] = []
  const push = (e: TimelineEvent) => timeline.push(e)

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

  return {
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
    country: visRes.data?.country ?? null,
    referrer: referrerOf(visRes.data?.page_url ?? null),
    tags,
    quoteMessage: lead?.message ? stripQuoteTag(lead.message) : null,
    notes,
    attachments: attachments.reverse(),
    related,
    timeline,
    assignableMembers: Array.from(assignable).sort(),
    messageCount: realMessages.length,
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

const digitsOnly = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '')

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
    const rowPhone = digitsOnly(c?.phone)
    const matchedOn = rowEmail && rowEmail === email ? 'email' : rowPhone && rowPhone === phone ? 'phone' : null
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
    const rowPhone = digitsOnly(l.phone)
    const matchedOn = rowEmail && rowEmail === email ? 'email' : rowPhone && rowPhone === phone ? 'phone' : null
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
