// CRM record state — persisted WITHOUT any schema change (no DDL), as chat_logs
// control rows, exactly like mode / contact / tags / lead_capture / lead_status.
//
//   crm_stage — { stage, previous, changed_by, at }   deal pipeline stage
//   crm_note  — { id, body, author, at, edited_at? }  internal note (append-only)
//   crm_field — { field, value, updated_by, at }      contact field override
//   crm_value — { estimated, won?, currency, updated_by, at }
//
// The CURRENT value of anything is the newest row of that role for the session.
// Older rows are never deleted — they are the audit trail the activity timeline
// is built from. Every role here MUST also be listed in lib/controlroles.ts or
// its raw JSON leaks into the chat views.
//
// Client-safe module (no supabase import) so the record page can share the
// stage list, colors and parsers with the API routes.

import type { LeadStatus } from './leadstatus'
import { CRM_TASK_ROLE } from './tasks'
import { CRM_PREFS_ROLE, CRM_REMINDER_ROLE } from './reminders'
import { CRM_EMAIL_ROLE } from './crmemail'
import { CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, CRM_EMAIL_SWEEP_ROLE } from './emailreply'
import { CRM_SIGNATURE_ROLE, CRM_SITE_CONTACT_ROLE } from './signature'

export { CRM_TASK_ROLE, CRM_PREFS_ROLE, CRM_REMINDER_ROLE, CRM_EMAIL_ROLE }
export { CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, CRM_EMAIL_SWEEP_ROLE }

export const CRM_STAGE_ROLE = 'crm_stage'
export const CRM_NOTE_ROLE = 'crm_note'
export const CRM_FIELD_ROLE = 'crm_field'
export const CRM_VALUE_ROLE = 'crm_value'

// CRM_ROLES is the canonical list of every crm_* control role. lib/controlroles.ts
// spreads it into CONTROL_ROLES, and app/api/admin/conversations subtracts it
// from the DB-side message count — so a role added HERE is automatically kept
// out of chat views and out of the conversation previews. Any new crm_* role
// must land in this array or it leaks (see the denylist note in controlroles.ts).
// crm_task is defined in lib/tasks.ts, which owns the task semantics; only the
// role name is imported so this stays the one registration point.
// crm_prefs and crm_reminder normally live on a RESERVED site/session rather
// than a lead conversation (see lib/reminders.ts), so they cannot reach a
// preview in the first place — they are listed here anyway so that a row
// written to a lead session by mistake is still filtered out of the transcript,
// the previews and the message counts. One entry, both protections.
// The name a CUSTOMER sees when this member answers in the chat widget.
// Member-scoped, so it lives on the reserved site with the other member rows
// (see lib/membername.ts) and never touches a conversation.
export const CRM_MEMBER_NAME_ROLE = 'crm_member_name'

// WhatsApp, both directions, on a lead's timeline. Separate roles rather than
// one with a `direction` field, so a query can ask for "messages from the
// customer" without parsing every row — the same shape the email pair uses.
export const CRM_WA_IN_ROLE = 'crm_wa_in'
export const CRM_WA_OUT_ROLE = 'crm_wa_out'

// A phone call placed from a lead's record. One row per call, updated by a
// second row when Twilio reports how it ended — newest wins on read, like every
// other control row here.
export const CRM_CALL_ROLE = 'crm_call'

// What Twilio Lookup said about a phone number's line type. Cached on the
// reserved zeeops-crm site because it belongs to a NUMBER, not a conversation —
// and because the lookup costs money per call and the answer never changes.
export const CRM_WA_LOOKUP_ROLE = 'crm_wa_lookup'

// A lead somebody has marked "not a lead" — a supplier pitch, a duplicate, a
// mistake. Append-only: the newest row per session wins, so un-marking is
// another row rather than a delete. See lib/notalead.ts.
export const CRM_NOT_A_LEAD_ROLE = 'crm_not_a_lead'

export const CRM_ROLES = [
  CRM_STAGE_ROLE, CRM_NOTE_ROLE, CRM_FIELD_ROLE, CRM_VALUE_ROLE, CRM_TASK_ROLE,
  CRM_PREFS_ROLE, CRM_REMINDER_ROLE, CRM_EMAIL_ROLE,
  CRM_EMAIL_IN_ROLE, CRM_EMAIL_READ_ROLE, CRM_EMAIL_SWEEP_ROLE,
  CRM_MEMBER_NAME_ROLE, CRM_WA_IN_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, CRM_WA_LOOKUP_ROLE,
  CRM_NOT_A_LEAD_ROLE,
  // Both live on the reserved zeeops-crm site, not on a lead — but registered
  // here anyway, as the second line of defence the reserved site is the first.
  CRM_SIGNATURE_ROLE, CRM_SITE_CONTACT_ROLE,
] as const

// ── Pipeline stages ──────────────────────────────────────────────────────────
// Order matters: it is the board's column order, the dropdown's option order and
// the rank the list view sorts on. The three dead-end outcomes sit between Won
// and Lost so every way a deal can die is grouped at the end of the funnel.
export const CRM_STAGES = [
  'new', 'contacted', 'quote_sent', 'follow_up', 'pending_design', 'won',
  'contact_not_successful', 'no_response', 'not_interested', 'lost',
] as const
export type CrmStage = (typeof CRM_STAGES)[number]

export function isCrmStage(v: unknown): v is CrmStage {
  return typeof v === 'string' && (CRM_STAGES as readonly string[]).includes(v)
}

export const CRM_STAGE_LABEL: Record<CrmStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  quote_sent: 'Quote Sent',
  follow_up: 'Follow-Up',
  pending_design: 'Pending Design',
  won: 'Won',
  contact_not_successful: 'Contact Not Successful',
  no_response: 'No Response',
  not_interested: 'Not Interested',
  lost: 'Lost',
}

// Pill styling. Deliberately built from the -100/-700/-300 Tailwind shades the
// rest of the dashboard uses: globals.css remaps exactly those utilities for
// dark mode, so a hand-picked hex here would be the one thing that goes
// dark-on-dark when the theme is flipped.
export const CRM_STAGE_STYLE: Record<CrmStage, string> = {
  new: 'bg-gray-200 text-gray-700 border-gray-300',
  contacted: 'bg-blue-100 text-blue-700 border-blue-300',
  quote_sent: 'bg-purple-100 text-purple-700 border-purple-300',
  follow_up: 'bg-amber-100 text-amber-700 border-amber-300',
  pending_design: 'bg-orange-100 text-orange-700 border-orange-300',
  won: 'bg-green-100 text-green-700 border-green-300',
  // The dead ends are deliberately quiet: a dead deal should not shout louder
  // than a live one. `not_interested` shares Lost's red because it IS a stated
  // loss — the dot below is what separates the two at a glance.
  contact_not_successful: 'bg-gray-100 text-gray-700 border-gray-300',
  no_response: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  not_interested: 'bg-red-100 text-red-700 border-red-300',
  lost: 'bg-red-100 text-red-700 border-red-300',
}

// Solid accent per stage, for the timeline dot / progress rail where a tinted
// pill background isn't enough. Saturated mid-tones read on both themes.
export const CRM_STAGE_DOT: Record<CrmStage, string> = {
  new: '#94a3b8',
  contacted: '#3b82f6',
  quote_sent: '#a855f7',
  follow_up: '#f59e0b',
  pending_design: '#f97316',
  won: '#22c55e',
  contact_not_successful: '#64748b',
  no_response: '#eab308',
  not_interested: '#fb7185',
  lost: '#ef4444',
}

// Stages a deal dies in. They are NOT funnel steps — a lead that stopped
// answering has not advanced past wherever it stalled — so the record page's
// progress rail excludes them and greys out, exactly as it always did for the
// single `lost` case.
export const CRM_DEAD_STAGES: readonly CrmStage[] = [
  'contact_not_successful', 'no_response', 'not_interested', 'lost',
]

export function isDeadStage(stage: CrmStage): boolean {
  return CRM_DEAD_STAGES.includes(stage)
}

// Stages that end the deal — used to decide whether to show "won revenue" and
// to stop counting a lead as needing follow-up.
export const CRM_CLOSED_STAGES: readonly CrmStage[] = ['won', ...CRM_DEAD_STAGES]

// ── Legacy lead_status ↔ stage ───────────────────────────────────────────────
// The Billing tab's 5-value lead_status came first and is still what the
// billing report reads. Every existing status maps onto one of the 7 stages, so
// nothing set before this page existed is lost.
export function stageFromLeadStatus(status: LeadStatus | string | null | undefined): CrmStage | null {
  switch (status) {
    case 'new': return 'new'
    case 'contacted': return 'contacted'
    case 'quoted': return 'quote_sent'
    case 'won': return 'won'
    case 'lost': return 'lost'
    default: return null
  }
}

// The reverse, for keeping Billing in sync when a stage is set here. The stages
// with no legacy equivalent collapse onto their nearest one (a lead that is
// awaiting design or being chased has, in billing terms, been quoted /
// contacted; one that never answered or said no is, in billing terms, lost) —
// the exact stage stays in the crm_stage row either way, and the `stagePairAt`
// guard in loadPipeline stops this coarser value ever reading back over it.
export function leadStatusForStage(stage: CrmStage): LeadStatus {
  switch (stage) {
    case 'new': return 'new'
    case 'contacted': return 'contacted'
    case 'follow_up': return 'contacted'
    case 'quote_sent': return 'quoted'
    case 'pending_design': return 'quoted'
    case 'won': return 'won'
    case 'contact_not_successful': return 'lost'
    case 'no_response': return 'lost'
    case 'not_interested': return 'lost'
    case 'lost': return 'lost'
  }
}

// ── Row shapes + parsers ─────────────────────────────────────────────────────
export interface CrmStageEntry {
  stage: CrmStage
  previous: CrmStage | null
  changed_by: string
  at: string
}

export function parseCrmStage(message: string | null | undefined): CrmStageEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && isCrmStage(o.stage)) {
      return {
        stage: o.stage,
        previous: isCrmStage(o.previous) ? o.previous : null,
        changed_by: typeof o.changed_by === 'string' ? o.changed_by : '',
        at: typeof o.at === 'string' ? o.at : '',
      }
    }
  } catch { /* not a stage row */ }
  return null
}

export interface CrmNoteEntry {
  id: string
  body: string
  author: string
  at: string
  edited_at?: string
  // Notes are append-only (the audit trail must survive), so a deletion is a
  // new row for the same note id carrying this flag rather than a DELETE.
  deleted?: boolean
}

export const MAX_NOTE_LENGTH = 4000

export function parseCrmNote(message: string | null | undefined): CrmNoteEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && typeof o.id === 'string' && o.id) {
      return {
        id: o.id,
        body: typeof o.body === 'string' ? o.body : '',
        author: typeof o.author === 'string' ? o.author : '',
        at: typeof o.at === 'string' ? o.at : '',
        edited_at: typeof o.edited_at === 'string' ? o.edited_at : undefined,
        deleted: o.deleted === true,
      }
    }
  } catch { /* not a note row */ }
  return null
}

// Contact fields the record page may override. The auto-captured value is never
// destroyed — the override is just a newer row that wins on read.
export const CRM_FIELDS = ['name', 'email', 'phone'] as const
export type CrmField = (typeof CRM_FIELDS)[number]

export function isCrmField(v: unknown): v is CrmField {
  return typeof v === 'string' && (CRM_FIELDS as readonly string[]).includes(v)
}

export const CRM_FIELD_LABEL: Record<CrmField, string> = { name: 'Name', email: 'Email', phone: 'Phone' }

export interface CrmFieldEntry {
  field: CrmField
  value: string
  updated_by: string
  at: string
}

export function parseCrmField(message: string | null | undefined): CrmFieldEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && isCrmField(o.field)) {
      return {
        field: o.field,
        value: typeof o.value === 'string' ? o.value : '',
        updated_by: typeof o.updated_by === 'string' ? o.updated_by : '',
        at: typeof o.at === 'string' ? o.at : '',
      }
    }
  } catch { /* not a field row */ }
  return null
}

// The dashboard has never shown money anywhere (Billing counts leads, it does
// not price them), so there is no established currency to inherit. USD is the
// default because every tracked store sells in it; the choice is stored on the
// row so a lead quoted in another currency stays correct.
export const CRM_CURRENCIES = ['USD', 'GBP', 'EUR', 'AUD', 'CAD', 'PKR'] as const
export type CrmCurrency = (typeof CRM_CURRENCIES)[number]
export const DEFAULT_CURRENCY: CrmCurrency = 'USD'

export function isCrmCurrency(v: unknown): v is CrmCurrency {
  return typeof v === 'string' && (CRM_CURRENCIES as readonly string[]).includes(v)
}

export const CURRENCY_SYMBOL: Record<CrmCurrency, string> = {
  USD: '$', GBP: '£', EUR: '€', AUD: 'A$', CAD: 'C$', PKR: '₨',
}

export interface CrmValueEntry {
  estimated: number | null
  won: number | null
  currency: CrmCurrency
  updated_by: string
  at: string
}

export function parseCrmValue(message: string | null | undefined): CrmValueEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && typeof o === 'object') {
      const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : null)
      return {
        estimated: num(o.estimated),
        won: num(o.won),
        currency: isCrmCurrency(o.currency) ? o.currency : DEFAULT_CURRENCY,
        updated_by: typeof o.updated_by === 'string' ? o.updated_by : '',
        at: typeof o.at === 'string' ? o.at : '',
      }
    }
  } catch { /* not a value row */ }
  return null
}

export function formatMoney(amount: number | null | undefined, currency: CrmCurrency): string {
  if (amount === null || amount === undefined) return '—'
  return `${CURRENCY_SYMBOL[currency]}${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

// ── Follow-up counter ────────────────────────────────────────────────────────
// Derived, never stored: the user must not have to maintain it. A "follow-up"
// is one outbound push at the lead — a burst of agent replies sent in the same
// sitting counts once, so a 6-message conversation isn't reported as 6 chases.
export const FOLLOW_UP_GAP_MS = 4 * 60 * 60 * 1000

export interface FollowUpSummary {
  count: number
  lastAt: string | null
}

// `outboundAt` = ISO timestamps of every agent-side touch, any order.
export function deriveFollowUps(outboundAt: string[]): FollowUpSummary {
  const times = outboundAt
    .map((t) => new Date(t).getTime())
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b)
  if (times.length === 0) return { count: 0, lastAt: null }
  let count = 1
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > FOLLOW_UP_GAP_MS) count++
  }
  return { count, lastAt: new Date(times[times.length - 1]).toISOString() }
}
