// Costing — the production cost of each packaging sale, entered by the person
// who actually knows it (Shazzy, who works as samirkhan@ in ZeeOps).
//
// The owner read a red "Net profit" for October because 12 of 14 sales had no
// cost on them: the costs live with production, and nobody asked. This page
// asks. It shows the orders that are paid but have no cost yet, WITHOUT any
// money — no order value, no payments, no profit, no notes (notes quote
// prices) — and lets the costing person add PKR cost lines. Admins see the
// same page. Everything else about a sale stays admin-only (lib/salescore.ts).
//
// Client-safe module: the page and the API share these shapes.

import type { Member } from './auth'
import { hasFeature } from './workspaces'
import type { ProductionStatus, Sale, SaleCost, SaleFigures } from './salescore'

/** Who is asked for costs. Shazzy's ZeeOps login is samirkhan@ (owner, 2026-10-26). */
export const COSTING_MEMBERS = ['samirkhan@shopcardboardboxes.com']

export function canUseCosting(m: Pick<Member, 'role' | 'workspace' | 'email'> | null | undefined): boolean {
  if (!m || m.workspace !== 'packaging' || !hasFeature(m.workspace, 'sales')) return false
  return m.role === 'admin' || COSTING_MEMBERS.includes(String(m.email).trim().toLowerCase())
}

export const COST_LABELS = [
  'Printing & material', 'Die / plate', 'Lamination / foil', 'Inserts',
  'Packing', 'Shipping', 'Sample', 'Other',
] as const

export type CostingBucket = 'needs' | 'unpaid' | 'done'

/** A sale as the costing page may show it: the order, never the money. */
export interface CostingItem {
  id: string
  bucket: CostingBucket
  reference: string
  customer: string
  company: string
  country: string
  orderDate: string
  product: string
  size: string
  material: string
  printing: string
  quantity: string
  production: ProductionStatus | null
  salesPerson: string
  leadId: string | null
  /** PKR lines only; a sale costed in another currency is read-only here. */
  costs: { id: string; label: string; amount: number; note: string }[]
  editable: boolean
  updatedAt: string
  updatedBy: string
}

/**
 * Which list a sale belongs on. Only Model Town's direct packaging sales: the
 * partner stream is costed by the partner. Closed (refunded/cancelled) sales
 * and ones whose profit the deal already fixed need nothing.
 */
export function costingBucket(s: Sale, f: SaleFigures): CostingBucket | null {
  if (s.workspace !== 'packaging' || s.stream !== 'pk_direct' || s.deleted) return null
  if (f.closed || s.agreedProfit) return null
  if (s.costs.length > 0) return 'done'
  return f.received > 0 ? 'needs' : 'unpaid'
}

export function costingItem(s: Sale, bucket: CostingBucket): CostingItem {
  const pkrOnly = s.costs.every((c) => c.currency === 'PKR')
  return {
    id: s.id, bucket,
    // The reference can carry a PayPal invoice number; it never carries an amount.
    reference: s.reference, customer: s.customer, company: s.company, country: s.country,
    orderDate: s.orderDate, product: s.product, size: s.size, material: s.material,
    printing: s.printing, quantity: s.quantity, production: s.production,
    salesPerson: s.salesPerson, leadId: s.leadId,
    costs: s.costs.filter((c) => c.currency === 'PKR').map((c) => ({ id: c.id, label: c.label, amount: c.amount, note: c.note })),
    editable: pkrOnly,
    updatedAt: s.updatedAt, updatedBy: s.updatedBy,
  }
}

/** Clean what the page posts back: PKR lines, a label, a positive amount. */
export function cleanCostLines(raw: unknown): SaleCost[] {
  const out: SaleCost[] = []
  for (const r of (Array.isArray(raw) ? raw : []).slice(0, 30)) {
    const o = (r ?? {}) as Record<string, unknown>
    const amount = Math.round(Number(String(o.amount ?? '').replace(/[,\s]/g, '')) * 100) / 100
    if (!Number.isFinite(amount) || amount <= 0 || amount > 50_000_000) continue
    const label = String(o.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Production'
    const id = String(o.id ?? '').trim().slice(0, 40) || `cost_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    out.push({ id, label, amount, currency: 'PKR', rate: null, note: String(o.note ?? '').trim().slice(0, 300) })
  }
  return out
}
