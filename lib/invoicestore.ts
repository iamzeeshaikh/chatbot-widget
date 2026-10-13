// Reading and writing invoices (lib/invoicedoc.ts) on a lead. Server only.

import { supabase } from './supabase'
import { writeControlRow } from './leadrecord'
import { CRM_INVOICE_DOC_ROLE, parseInvoiceDoc, type InvoiceDoc } from './invoicedoc'

/** Every live invoice on the lead, newest first. */
export async function listInvoices(sessionId: string): Promise<InvoiceDoc[]> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', sessionId).eq('role', CRM_INVOICE_DOC_ROLE)
    .order('created_at', { ascending: true }).limit(2000)
  const byId = new Map<string, InvoiceDoc>()
  for (const r of data ?? []) {
    const d = parseInvoiceDoc(r.message)
    if (d) byId.set(d.id, d)
  }
  return [...byId.values()].filter((d) => !d.deleted)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}

export async function saveInvoice(sessionId: string, siteId: string, doc: InvoiceDoc): Promise<{ error: string | null }> {
  return writeControlRow({ sessionId, siteId, role: CRM_INVOICE_DOC_ROLE, message: JSON.stringify(doc) })
}
