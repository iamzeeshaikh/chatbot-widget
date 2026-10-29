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

export const JOB_TYPES = ['estimate', 'design_2d3d', 'print_ready', 'dieline', 'china_template', 'production', 'other'] as const
export type JobType = (typeof JOB_TYPES)[number]
export const JOB_TYPE_LABEL: Record<JobType, string> = {
  estimate: 'Estimate',
  design_2d3d: '2D / 3D design',
  print_ready: 'Print-ready file',
  dieline: 'Open size (dieline)',
  china_template: 'China template',
  production: 'Production order',
  other: 'Other',
}
// Standard -100/-300/-700 shades so globals.css can remap them for dark mode.
export const JOB_TYPE_STYLE: Record<JobType, string> = {
  estimate: 'bg-amber-100 text-amber-700 border-amber-300',
  design_2d3d: 'bg-violet-100 text-violet-700 border-violet-300',
  print_ready: 'bg-blue-100 text-blue-700 border-blue-300',
  dieline: 'bg-teal-100 text-teal-700 border-teal-300',
  china_template: 'bg-rose-100 text-rose-700 border-rose-300',
  production: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  other: 'bg-gray-200 text-gray-700 border-gray-300',
}

// ── Two tracks (Uzair, 2026-10-14) ──────────────────────────────────────────
// Design work and production work move through different steps, so they are
// two boards: Design & Estimates (the designer/estimator, checked by the CSR)
// and Production (stock to shipped). An approved design job can open its own
// production job with one button. Stages can grow later — add them here.
// Three boards since 2026-10-23 (owner: "design, estimation aur production alag
// alag kar dein"): Estimation holds `estimate` jobs, Design every other design job.
export const JOB_TRACKS = ['design', 'estimate', 'production'] as const
export type JobTrack = (typeof JOB_TRACKS)[number]
export const JOB_TRACK_LABEL: Record<JobTrack, string> = { design: 'Design', estimate: 'Estimation', production: 'Production' }

/** Which board a new job of this type belongs on. */
export function trackForType(type: string | undefined): JobTrack {
  return type === 'production' ? 'production' : type === 'estimate' ? 'estimate' : 'design'
}

export const DESIGN_STATUSES = ['pending', 'in_process', 'verification', 'approved'] as const
export const PRODUCTION_STATUSES = ['stock', 'printing', 'lamination', 'die_cutting', 'packing', 'shipped'] as const
export const JOB_STATUSES = [...DESIGN_STATUSES, ...PRODUCTION_STATUSES] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export function statusesOf(track: JobTrack): readonly JobStatus[] {
  return track === 'production' ? PRODUCTION_STATUSES : DESIGN_STATUSES
}

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Pending',
  in_process: 'In Process',
  verification: 'Verification',
  approved: 'Approved',
  stock: 'Stock',
  printing: 'Printing',
  lamination: 'Lamination',
  die_cutting: 'Die cutting / Pasting',
  packing: 'Packing',
  shipped: 'Shipped',
}
export const JOB_STATUS_DOT: Record<JobStatus, string> = {
  pending: '#9ca3af', in_process: '#2563eb', verification: '#d97706', approved: '#16a34a',
  stock: '#78716c', printing: '#2563eb', lamination: '#0891b2', die_cutting: '#7c3aed', packing: '#d97706', shipped: '#0f766e',
}
/** What the button on a job says, to move it to the next status. */
export const NEXT_ACTION: Partial<Record<JobStatus, { to: JobStatus; label: string }>> = {
  pending: { to: 'in_process', label: 'Start work' },
  in_process: { to: 'verification', label: 'Send for verification' },
  verification: { to: 'approved', label: 'Verified — approve' },
  stock: { to: 'printing', label: 'Stock ready — start printing' },
  printing: { to: 'lamination', label: 'Printing done' },
  lamination: { to: 'die_cutting', label: 'Lamination done' },
  die_cutting: { to: 'packing', label: 'Die cutting / pasting done' },
  packing: { to: 'shipped', label: 'Mark shipped' },
}

// Jobs saved before the two tracks, read into the new names.
const LEGACY_STATUS: Record<string, { status: JobStatus; track: JobTrack }> = {
  in_progress: { status: 'in_process', track: 'design' },
  completed: { status: 'approved', track: 'design' },
  in_production: { status: 'stock', track: 'production' },
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

// ── the production form ─────────────────────────────────────────────────────
// The sheet the production side works from (Taylor_IH-029.xlsx, 2026-10-29:
// "production form is trha setup krein, ye sari information chahye"): invoice
// and job numbers, CSR, rush or standard, the printer's deadline and delivery
// date, a product table, designer detail, the client and where to ship, and
// the shipping record. lib/productionform.ts fills a new one from the lead's
// invoice; the job page prints it like the spreadsheet.
export interface ProductionItem { product: string; stock: string; size: string; lamination: string; printing: string; quantity: string }
export interface ProductionForm {
  invoiceNo: string
  jobNo: string
  orderDate: string        // YYYY-MM-DD, like every date on the form
  csr: string
  orderType: string        // 'Standard' | 'Rush'
  printerDeadline: string
  deliveryDate: string
  items: ProductionItem[]
  addOn: string
  handoverToDesigner: string
  sentToProduction: string
  designer: { die: string; color: string; quantity: string; stock: string; addOn: string }
  client: { name: string; phone: string; company: string; address: string }
  folderPath: string
  shipping: { via: string; date: string; weight: string; cartons: string; quantity: string; tracking: string }
  shipperReview: string
}

export const ORDER_TYPES = ['Standard', 'Rush'] as const
export const blankProductionItem = (): ProductionItem => ({ product: '', stock: '', size: '', lamination: '', printing: '', quantity: '' })
export const blankProductionForm = (): ProductionForm => ({
  invoiceNo: '', jobNo: '', orderDate: '', csr: '', orderType: 'Standard', printerDeadline: '', deliveryDate: '',
  items: [blankProductionItem()], addOn: '', handoverToDesigner: '', sentToProduction: '',
  designer: { die: '', color: '', quantity: '', stock: '', addOn: '' },
  client: { name: '', phone: '', company: '', address: '' }, folderPath: '',
  shipping: { via: '', date: '', weight: '', cartons: '', quantity: '', tracking: '' }, shipperReview: '',
})

export interface Job {
  id: string
  /** Short and human: J-0042. Assigned on creation, never reused. */
  number: string
  title: string
  type: JobType
  track: JobTrack
  status: JobStatus
  /** Production job: the design job it was opened from. */
  sourceJobId?: string
  /** Design job: the production job it was sent on to. */
  productionJobId?: string
  requirements: string
  assignee: string
  leadId: string
  leadName: string
  siteId: string
  dueAt: string
  estimate: Estimate | null
  /** Production jobs: the production form, once someone saves it. */
  production?: ProductionForm | null
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

const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '')

export function cleanProductionForm(raw: unknown): ProductionForm | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const sub = (k: string) => ((o[k] && typeof o[k] === 'object' ? o[k] : {}) as Record<string, unknown>)
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 20).map((x) => {
    const t = (x ?? {}) as Record<string, unknown>
    return { product: s(t.product, 160), stock: s(t.stock, 200), size: s(t.size, 80), lamination: s(t.lamination, 80), printing: s(t.printing, 120), quantity: s(t.quantity, 20) }
  })
  const d = sub('designer'), c = sub('client'), sh = sub('shipping')
  return {
    invoiceNo: s(o.invoiceNo, 40), jobNo: s(o.jobNo, 60), orderDate: day(o.orderDate), csr: s(o.csr, 80),
    orderType: o.orderType === 'Rush' ? 'Rush' : 'Standard',
    printerDeadline: day(o.printerDeadline), deliveryDate: day(o.deliveryDate),
    items: items.length ? items : [blankProductionItem()], addOn: s(o.addOn, 400),
    handoverToDesigner: day(o.handoverToDesigner), sentToProduction: day(o.sentToProduction),
    designer: { die: s(d.die, 200), color: s(d.color, 80), quantity: s(d.quantity, 20), stock: s(d.stock, 120), addOn: s(d.addOn, 200) },
    client: { name: s(c.name, 120), phone: s(c.phone, 40), company: s(c.company, 120), address: s(c.address, 400) },
    folderPath: s(o.folderPath, 200),
    shipping: { via: s(sh.via, 80), date: day(sh.date), weight: s(sh.weight, 40), cartons: s(sh.cartons, 20), quantity: s(sh.quantity, 20), tracking: s(sh.tracking, 300) },
    shipperReview: s(o.shipperReview, 600),
  }
}

/** What the browser may set on a job. Ids, numbers and audit fields are the server's. */
export function cleanJobInput(raw: unknown): Partial<Job> {
  const o = (raw ?? {}) as Record<string, unknown>
  const out: Partial<Job> = {}
  if ('title' in o) out.title = s(o.title, 160).trim()
  if ('type' in o && (JOB_TYPES as readonly string[]).includes(String(o.type))) out.type = o.type as JobType
  if ('status' in o && (JOB_STATUSES as readonly string[]).includes(String(o.status))) out.status = o.status as JobStatus
  if ('track' in o && (JOB_TRACKS as readonly string[]).includes(String(o.track))) out.track = o.track as JobTrack
  if ('requirements' in o) out.requirements = s(o.requirements, 4000)
  if ('assignee' in o) out.assignee = s(o.assignee, 200).trim().toLowerCase()
  if ('leadId' in o) out.leadId = s(o.leadId, 120).trim()
  if ('dueAt' in o) out.dueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(o.dueAt)) ? String(o.dueAt) : ''
  if ('estimate' in o) out.estimate = cleanEstimate(o.estimate)
  if ('production' in o) out.production = cleanProductionForm(o.production)
  return out
}

export function parseJob(message: string | null | undefined): Job | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    if (!o || typeof o.id !== 'string' || !o.id) return null
    const j = o as Job
    const legacy = LEGACY_STATUS[String(j.status)]
    if (legacy) { j.status = legacy.status; j.track = legacy.track }
    if (!(JOB_TRACKS as readonly string[]).includes(j.track)) {
      j.track = (PRODUCTION_STATUSES as readonly string[]).includes(j.status) || j.type === 'production' ? 'production' : 'design'
    }
    // Estimate jobs saved on the old shared design board move to Estimation.
    if (j.track === 'design' && j.type === 'estimate') j.track = 'estimate'
    if (!statusesOf(j.track).includes(j.status)) j.status = statusesOf(j.track)[0]
    return j
  } catch { return null }
}

export function parseJobMessage(message: string | null | undefined): JobMessage | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && typeof o.id === 'string' && typeof o.jobId === 'string' ? (o as JobMessage) : null
  } catch { return null }
}
