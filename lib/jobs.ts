// Jobs — the work a CSR hands to the estimator / designer / production side.
//
// One person does all three today (estimates, designs, gets it produced, with
// Sameer Khan). A job is: what kind of work, what is required, who has it, and
// where it stands — Pending → In Progress → Verification (the CSR checks the
// work) → Completed → In Production → Shipped. The CSR and the designer talk
// inside the job, so the requirement, the files and the back-and-forth stay in
// one place instead of a WhatsApp thread nobody else can see.
//
// Client-safe: the /jobs pages and the API share these types and helpers.
//
// Stored without DDL, like everything in this CRM: `crm_job` snapshots (one per
// save, newest per id wins, delete = `deleted: true`) and `crm_job_msg` rows,
// both on the reserved zeeops-crm site under one session per workspace.

export const CRM_JOB_ROLE = 'crm_job'
export const CRM_JOB_MSG_ROLE = 'crm_job_msg'
export const JOB_SITE = 'zeeops-crm'
export const jobSession = (workspace: string) => `zeeops-jobs-${workspace}`

/**
 * Who estimates, designs and runs production, per workspace. New jobs are
 * assigned here by default (still changeable), and the name is labelled so a
 * CSR picking an assignee knows who does the work. Owner, 2026-10-13: the
 * designer/estimator works from the jenniferwright@ account.
 */
export const JOB_DESIGNERS: Record<string, string[]> = {
  packaging: ['jenniferwright@shopcardboardboxes.com'],
}

export const JOB_TYPES = ['estimate', 'design_2d3d', 'print_ready', 'dieline', 'china_template', 'other'] as const
export type JobType = (typeof JOB_TYPES)[number]
export const JOB_TYPE_LABEL: Record<JobType, string> = {
  estimate: 'Estimate',
  design_2d3d: '2D / 3D design',
  print_ready: 'Print-ready file',
  dieline: 'Open size (dieline)',
  china_template: 'China template',
  other: 'Other',
}
// Standard -100/-300/-700 shades so globals.css can remap them for dark mode.
export const JOB_TYPE_STYLE: Record<JobType, string> = {
  estimate: 'bg-amber-100 text-amber-700 border-amber-300',
  design_2d3d: 'bg-violet-100 text-violet-700 border-violet-300',
  print_ready: 'bg-blue-100 text-blue-700 border-blue-300',
  dieline: 'bg-teal-100 text-teal-700 border-teal-300',
  china_template: 'bg-rose-100 text-rose-700 border-rose-300',
  other: 'bg-gray-200 text-gray-700 border-gray-300',
}

export const JOB_STATUSES = ['pending', 'in_progress', 'verification', 'completed', 'in_production', 'shipped'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  verification: 'Verification',
  completed: 'Completed',
  in_production: 'In Production',
  shipped: 'Shipped',
}
export const JOB_STATUS_DOT: Record<JobStatus, string> = {
  pending: '#9ca3af', in_progress: '#2563eb', verification: '#d97706',
  completed: '#16a34a', in_production: '#7c3aed', shipped: '#0f766e',
}
/** What the button on a job says, to move it to the next status. */
export const NEXT_ACTION: Partial<Record<JobStatus, { to: JobStatus; label: string; who: string }>> = {
  pending: { to: 'in_progress', label: 'Start work', who: 'designer' },
  in_progress: { to: 'verification', label: 'Send for verification', who: 'designer' },
  verification: { to: 'completed', label: 'Verified — mark completed', who: 'CSR' },
  completed: { to: 'in_production', label: 'Send to production', who: 'production' },
  in_production: { to: 'shipped', label: 'Mark shipped', who: 'production' },
}

// ── the estimate sheet ──────────────────────────────────────────────────────
// The columns of the estimation sheet the team keeps today, as the owner
// described it: style and size, board, printing, finishing, add-ons, and a
// price per quantity tier with its cost, so the margin is visible.
export interface EstimateTier { quantity: string; unitCost: string; unitPrice: string }
export interface Estimate {
  style: string
  length: string; width: string; height: string; unit: string
  material: string
  thickness: string
  printing: string
  sides: string
  finishing: string
  addOns: string
  tiers: EstimateTier[]
  shipping: string
  turnaround: string
  vendor: string
}

export const blankEstimate = (): Estimate => ({
  style: '', length: '', width: '', height: '', unit: 'in', material: '', thickness: '', printing: '', sides: '',
  finishing: '', addOns: '', tiers: [{ quantity: '', unitCost: '', unitPrice: '' }], shipping: '', turnaround: '', vendor: '',
})

export interface Job {
  id: string
  /** Short and human: J-0042. Assigned on creation, never reused. */
  number: string
  title: string
  type: JobType
  status: JobStatus
  requirements: string
  assignee: string
  leadId: string
  leadName: string
  siteId: string
  dueAt: string
  estimate: Estimate | null
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
  statusAt: string
  deleted?: boolean
}

export interface JobMessage { id: string; jobId: string; author: string; body: string; at: string }

const n = (v: string) => { const x = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(x) ? x : 0 }

/** Per tier: what it costs us, what we charge, and the margin between. */
export function tierMath(t: EstimateTier): { cost: number; price: number; margin: number | null } {
  const q = n(t.quantity)
  const cost = q * n(t.unitCost)
  const price = q * n(t.unitPrice)
  return { cost, price, margin: price > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : null }
}

export function newJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

const s = (v: unknown, max: number) => String(v ?? '').slice(0, max)

export function cleanEstimate(raw: unknown): Estimate | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const tiers = (Array.isArray(o.tiers) ? o.tiers : []).slice(0, 10).map((x) => {
    const t = (x ?? {}) as Record<string, unknown>
    return { quantity: s(t.quantity, 20), unitCost: s(t.unitCost, 20), unitPrice: s(t.unitPrice, 20) }
  })
  return {
    style: s(o.style, 120), length: s(o.length, 12), width: s(o.width, 12), height: s(o.height, 12),
    unit: o.unit === 'mm' || o.unit === 'cm' ? String(o.unit) : 'in',
    material: s(o.material, 120), thickness: s(o.thickness, 40), printing: s(o.printing, 120), sides: s(o.sides, 40),
    finishing: s(o.finishing, 200), addOns: s(o.addOns, 200), tiers: tiers.length ? tiers : blankEstimate().tiers,
    shipping: s(o.shipping, 120), turnaround: s(o.turnaround, 80), vendor: s(o.vendor, 120),
  }
}

/** What the browser may set on a job. Ids, numbers and audit fields are the server's. */
export function cleanJobInput(raw: unknown): Partial<Job> {
  const o = (raw ?? {}) as Record<string, unknown>
  const out: Partial<Job> = {}
  if ('title' in o) out.title = s(o.title, 160).trim()
  if ('type' in o && (JOB_TYPES as readonly string[]).includes(String(o.type))) out.type = o.type as JobType
  if ('status' in o && (JOB_STATUSES as readonly string[]).includes(String(o.status))) out.status = o.status as JobStatus
  if ('requirements' in o) out.requirements = s(o.requirements, 4000)
  if ('assignee' in o) out.assignee = s(o.assignee, 200).trim().toLowerCase()
  if ('leadId' in o) out.leadId = s(o.leadId, 120).trim()
  if ('dueAt' in o) out.dueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(o.dueAt)) ? String(o.dueAt) : ''
  if ('estimate' in o) out.estimate = cleanEstimate(o.estimate)
  return out
}

export function parseJob(message: string | null | undefined): Job | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && typeof o.id === 'string' && o.id ? (o as Job) : null
  } catch { return null }
}

export function parseJobMessage(message: string | null | undefined): JobMessage | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && typeof o.id === 'string' && typeof o.jobId === 'string' ? (o as JobMessage) : null
  } catch { return null }
}
