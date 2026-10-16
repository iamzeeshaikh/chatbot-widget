// A chat that yields an email address becomes a `leads` row.
//
// The dashboard, the pipeline and the record page all read chat leads from
// their lead_capture control row, so for them nothing is missing. The quote
// bot (lib/quotebot.ts) reads only the `leads` table — and a chat produced a
// row there in just two cases: the visitor filled the widget's lead form
// (public/widget.js → /api/lead, transcript as the message), or the model's
// field extraction found ALL SEVEN of name/email/phone/product/quantity/
// budget/timeline, which a real chat almost never gives. So Anthony (300
// pallet boxes at 1266×990×940 mm, 16 Oct 2026) and Damon Scott (foil-stamped
// folders for a law firm) typed their email into the chat, got "a specialist
// will be in touch", and nobody was ever asked to be that specialist.
//
// This writes the same row the lead form writes: the transcript as the
// message, so the bot assesses the whole conversation, not a summary. The
// leads list folds a chat's leads row and its lead_capture row into one lead
// (app/api/admin/leads-list, keyed site|email), so nothing appears twice.
//
// Packaging only — called from the chat route behind a workspace gate.

import { supabase } from './supabase'
import { isGarbageName } from './quoteintake'
import { LEAD_CAPTURE_ROLE, parseLeadCapture } from './leadtracking'

export interface ChatLeadRowInput {
  siteId: string
  sessionId: string
  email: string
  name?: string | null
  phone?: string | null
  /** The capture time, for a row written after the fact. Defaults to now. */
  createdAt?: string
}

export interface ChatLeadRowResult {
  id: string | null
  created: boolean
  /** Which blank fields a later turn filled in on an existing row. */
  patched: ('name' | 'phone')[]
}

/** The address the chat captured earlier (lib/leadtracking.ts), for a turn
 *  whose 20-message history no longer reaches back to where it was typed. */
export async function capturedEmail(sessionId: string): Promise<string | null> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', sessionId).eq('role', LEAD_CAPTURE_ROLE).limit(1)
  return parseLeadCapture(data?.[0]?.message ?? '')?.email?.toLowerCase() ?? null
}

/** The conversation as the widget's lead form sends it: "role: text" lines. */
export async function chatTranscript(sessionId: string): Promise<string> {
  const { data } = await supabase.from('chat_logs').select('role, message')
    .eq('session_id', sessionId).in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true }).limit(400)
  return (data ?? []).map((r) => `${r.role}: ${String(r.message ?? '')}`).join('\n').slice(0, 20000)
}

/**
 * Make sure the chat has a `leads` row on its site for this address. Creates
 * one from the transcript when there is none; otherwise fills in a name or
 * phone the row still lacks (the visitor usually gives those a turn or two
 * after the email). Never throws — the chat reply must not depend on it.
 */
export async function ensureChatLeadRow(i: ChatLeadRowInput): Promise<ChatLeadRowResult> {
  const none: ChatLeadRowResult = { id: null, created: false, patched: [] }
  try {
    const email = i.email.trim()
    const key = email.toLowerCase()
    if (!key) return none
    const name = isGarbageName(i.name) ? '' : (i.name ?? '').trim()
    const phone = (i.phone ?? '').trim()
    const { data: existing } = await supabase.from('leads').select('id, name, phone')
      .eq('site_id', i.siteId).in('email', Array.from(new Set([email, key])))
      .order('created_at', { ascending: true }).limit(1)
    const row = existing?.[0]
    if (row) {
      const patch: Record<string, string> = {}
      const patched: ('name' | 'phone')[] = []
      if (!String(row.name ?? '').trim() && name) { patch.name = name; patched.push('name') }
      if (!String(row.phone ?? '').trim() && phone) { patch.phone = phone; patched.push('phone') }
      if (patched.length) await supabase.from('leads').update(patch).eq('id', row.id)
      return { id: String(row.id), created: false, patched }
    }
    const message = await chatTranscript(i.sessionId)
    if (!message) return none
    const insert: Record<string, string> = { site_id: i.siteId, name, email: key, phone, message }
    if (i.createdAt) insert.created_at = i.createdAt
    const { data: ins, error } = await supabase.from('leads').insert([insert]).select('id').limit(1)
    if (error) { console.error('[chatleads] insert failed:', error.message); return none }
    return { id: ins?.[0]?.id ? String(ins[0].id) : null, created: true, patched: [] }
  } catch (e) {
    console.error('[chatleads] failed (non-fatal):', e instanceof Error ? e.message : e)
    return none
  }
}
