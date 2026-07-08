// Lead pipeline status — persisted WITHOUT any schema change (no DDL), as a
// chat_logs control row: role 'lead_status', message JSON { status, by, at }.
// The latest row per session wins. Client-safe module (no supabase import) so
// the dashboard can share the status list and colors.

export const LEAD_STATUS_ROLE = 'lead_status'

export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost'] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

export function isLeadStatus(v: unknown): v is LeadStatus {
  return typeof v === 'string' && (LEAD_STATUSES as readonly string[]).includes(v)
}

export interface LeadStatusEntry {
  status: LeadStatus
  by: string // member email who set it
  at: string // ISO timestamp
}

export function parseLeadStatus(message: string | null | undefined): LeadStatusEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && isLeadStatus(o.status)) {
      return { status: o.status, by: typeof o.by === 'string' ? o.by : '', at: typeof o.at === 'string' ? o.at : '' }
    }
  } catch { /* not a status row */ }
  return null
}

// Pill styling per status (light theme).
export const LEAD_STATUS_STYLE: Record<LeadStatus, string> = {
  new: 'bg-blue-100 text-blue-700 border-blue-300',
  contacted: 'bg-amber-100 text-amber-700 border-amber-300',
  quoted: 'bg-indigo-100 text-indigo-700 border-indigo-300',
  won: 'bg-green-100 text-green-700 border-green-300',
  lost: 'bg-gray-200 text-gray-600 border-gray-300',
}
