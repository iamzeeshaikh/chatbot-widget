// Why a lead was lost — the short list the team picks from when a lead moves
// to Lost, and the filter on the Lost page (/lost). Client-safe: no imports.
//
// Stored as a `crm_lost` control row (CRM_LOST_ROLE in lib/crm.ts, registered
// in CRM_ROLES) on the lead's own session: { reason, note, by, at }. Newest row
// wins, and only a row written at or after the lead's newest move to Lost
// counts — a reason from an earlier time it was lost (and then recovered) must
// not be shown against the current one. Optional: a lead dragged to Lost on the
// board has no reason until somebody picks one on the Lost page.

export const LOST_REASONS = [
  { key: 'size', label: "Size or spec we can't make" },
  { key: 'price', label: 'Price too high' },
  { key: 'min_qty', label: 'Quantity too small' },
  { key: 'no_reply', label: 'Stopped replying' },
  { key: 'elsewhere', label: 'Bought elsewhere' },
  { key: 'timeline', label: 'Deadline too tight' },
  { key: 'other', label: 'Other' },
] as const

export type LostReason = (typeof LOST_REASONS)[number]['key']

export function isLostReason(v: unknown): v is LostReason {
  return typeof v === 'string' && LOST_REASONS.some((r) => r.key === v)
}

export function lostReasonLabel(v: string | null | undefined): string {
  return LOST_REASONS.find((r) => r.key === v)?.label ?? ''
}

export const MAX_LOST_NOTE = 500

export interface CrmLostEntry { reason: LostReason; note: string; by: string; at: string }

export function parseCrmLost(message: string | null | undefined): CrmLostEntry | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && isLostReason(o.reason)) {
      return {
        reason: o.reason,
        note: typeof o.note === 'string' ? o.note.slice(0, MAX_LOST_NOTE) : '',
        by: typeof o.by === 'string' ? o.by : '',
        at: typeof o.at === 'string' ? o.at : '',
      }
    }
  } catch { /* not a lost-reason row */ }
  return null
}

/** The stages a lead can be recovered INTO — the live working stages. */
export const RECOVER_STAGES = ['new', 'contacted', 'quote_sent', 'follow_up', 'pending_design', 'on_hold'] as const

// ── What the customer asked for, read off the enquiry text ──────────────────
// Form mail writes "Product: …", "Quantity: …", "Size: …" or Length/Width/
// Height lines (+ "Unit:"); a free-text enquiry writes "2.5 x 3.5 x 1.5 in" and
// "500 boxes". Best effort: an empty cell is better than a wrong one.
function field(text: string, names: string[]): string {
  for (const n of names) {
    const m = text.match(new RegExp(`^\\s*${n}\\s*:[ \\t]*(.+)$`, 'im'))
    if (m && m[1].trim() && !/^(n\/?a|none|-)$/i.test(m[1].trim())) return m[1].trim().slice(0, 120)
  }
  return ''
}

const DIM_RE = /(\d+(?:\.\d+)?)\s*(?:"|''|in(?:ch(?:es)?)?|cm|mm)?\s*[x×X*]\s*(\d+(?:\.\d+)?)\s*(?:"|''|in(?:ch(?:es)?)?|cm|mm)?(?:\s*[x×X*]\s*(\d+(?:\.\d+)?))?\s*("|in(?:ch(?:es)?)?\b|cm\b|mm\b)?/

export function orderDetails(message: string | null | undefined): { product: string; size: string; quantity: string } {
  const text = String(message ?? '').replace(/^\[(?:Custom Quote|Checkout|Reorder)\]\s*/i, '')
  let product = field(text, ['Product', 'Product Name', 'Box Type', 'Box Style', 'Style', 'Item']).split(' | ')[0]
  // A ZeeOps checkout / order-box lead lists its line as
  // "- Custom Popcorn Bags: 100 bags, $30.00" or "Blank Cardboard Boxes × 100 — USD 20.00".
  const line = text.match(/^\s*-\s+(.+?):\s*(\d[\d,]*\s*[A-Za-z]*)\s*,/m) ?? text.match(/^\s*(.+?)\s+×\s+(\d[\d,]*)\s+—/m)
  if (!product && line) product = line[1].trim().slice(0, 120)
  let size = field(text, ['Size', 'Dimensions', 'Box Size', 'Dimension'])
  if (!size) {
    const l = field(text, ['Length']), w = field(text, ['Width']), h = field(text, ['Height', 'Depth'])
    if (l && w) size = [l, w, h].filter(Boolean).join(' x ') + (field(text, ['Unit']) ? ` ${field(text, ['Unit'])}` : '')
  }
  if (!size) {
    const m = text.match(DIM_RE)
    if (m) size = m[0].trim()
  }
  let quantity = field(text, ['Quantity', 'Qty', 'Order Quantity'])
  if (!quantity && line) quantity = line[2].trim()
  if (!quantity) {
    const m = text.match(/\b(\d{1,3}(?:,\d{3})+|\d{2,6})\s*(?:pcs|pieces|boxes|units|bags|sleeves|cups|labels|stickers|mailers|pcs\.)\b/i)
    if (m) quantity = m[0]
  }
  return { product, size: size.slice(0, 60), quantity: quantity.slice(0, 40) }
}
