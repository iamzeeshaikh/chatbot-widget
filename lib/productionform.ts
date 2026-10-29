// A new production form, filled from what the lead already has: the newest
// ZeeOps invoice (number, PO = job number, CSR, date, the product lines and
// where it ships). Nothing is saved here — the job page shows the result as a
// draft and it is stored only when someone saves the job.
import 'server-only'
import { supabase } from './supabase'
import { pktDayKey } from './datetime'
import { CRM_INVOICE_DOC_ROLE, parseInvoiceDoc, shipParty, poNumber, prefixOf, type InvoiceDoc } from './invoicedoc'
import { blankProductionForm, type Job, type ProductionForm, type ProductionItem } from './jobs'

const SIZE = /\d\s*(?:"|in|cm|mm)?\s*[x×]\s*\d/i
const LAMINATION = /lamina|\bmatte\b|\bgloss|soft[\s-]?touch|velvet/i
const PRINTING = /print|cmyk|pms|pantone|\bfoil\b|spot uv|emboss|deboss/i
const STOCK = /\bpt\b|\d\s*pt\b|gsm|sbs|kraft|board|material|corrugated|flute|rigid|paper|stock/i

/** "5 x 4.5 x 1"\n16pt SBS…\nNon-printed\nGloss laminated" → the form's columns. */
export function itemFromInvoiceLine(name: string, details: string, quantity: string): ProductionItem {
  const lines = String(details ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const take = (re: RegExp) => lines.filter((l) => re.test(l))
  const size = take(SIZE)[0] ?? ''
  const lam = take(LAMINATION)[0] ?? ''
  const printing = lines.filter((l) => l !== lam && PRINTING.test(l))
  const stock = lines.filter((l) => l !== size && l !== lam && !printing.includes(l) && STOCK.test(l))
  return {
    product: name.trim(),
    stock: stock.join(' / '),
    size,
    lamination: lam.replace(/\s*lamina\w*/i, '').trim() || lam,
    printing: printing.map((p) => (/^non[\s-]?print/i.test(p) ? 'NA' : p)).join(' / '),
    quantity: String(quantity ?? '').trim(),
  }
}

export function formFromInvoice(doc: InvoiceDoc | null, job: Job, csrFallback: string): ProductionForm {
  const f = blankProductionForm()
  f.folderPath = job.title
  f.csr = csrFallback
  f.sentToProduction = job.track === 'production' ? pktDayKey(job.createdAt) : ''
  if (!doc) return f
  f.invoiceNo = doc.number
  f.orderDate = doc.date
  f.csr = doc.agentName || csrFallback
  f.jobNo = doc.poNumber || poNumber(prefixOf(doc.number, ''), f.csr, doc.date)
  const items = doc.items.filter((it) => it.name.trim()).map((it) => itemFromInvoiceLine(it.name, it.details, it.quantity))
  if (items.length) f.items = items
  const to = shipParty(doc)
  f.client = { name: to.name || doc.billTo.name, phone: to.phone || doc.billTo.phone, company: to.company || doc.billTo.company, address: to.address }
  return f
}

/** The lead's newest invoice that is not deleted. */
export async function newestInvoiceDoc(leadId: string): Promise<InvoiceDoc | null> {
  if (!leadId) return null
  const { data } = await supabase.from('chat_logs').select('message').eq('session_id', leadId)
    .eq('role', CRM_INVOICE_DOC_ROLE).order('created_at', { ascending: false }).limit(200)
  const seen = new Set<string>()
  for (const r of data ?? []) {
    const d = parseInvoiceDoc(r.message)
    if (!d || seen.has(d.id)) continue
    seen.add(d.id)
    if (!d.deleted) return d
  }
  return null
}

/** The designer's jobs-only account never sees where the customer lives or their number. */
export function withoutContacts(f: ProductionForm | null | undefined): ProductionForm | null {
  if (!f) return null
  return { ...f, client: { ...f.client, phone: '', company: '', address: '' } }
}
