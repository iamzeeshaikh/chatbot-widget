// Typing indicators — no DDL, no websockets. Each side stamps a timestamp into
// the session's active_visitors packed page_url blob ('vty' = visitor typing,
// 'aty' = agent typing); the other side's existing poll reads it back and shows
// dots while the stamp is fresh. Stamps are merged into the raw JSON (not via
// packVisitor) so nothing else in the blob is lost; the widget's 30s presence
// ping may rewrite the blob without these keys, which is fine — typing stamps
// only need to survive a few seconds.

import { supabase } from './supabase'

export const VISITOR_TYPING_KEY = 'vty'
export const AGENT_TYPING_KEY = 'aty'
export const TYPING_FRESH_MS = 6 * 1000

export async function stampTyping(sessionId: string, key: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('active_visitors')
      .select('page_url')
      .eq('session_id', sessionId)
      .maybeSingle()
    if (!data) return // no visitor row yet — nothing to stamp onto
    const raw = data.page_url as string | null
    let o: Record<string, unknown> = {}
    if (raw && raw[0] === '{') { try { o = JSON.parse(raw) } catch { o = { u: raw } } }
    else if (raw) o = { u: raw }
    o[key] = new Date().toISOString()
    await supabase.from('active_visitors').update({ page_url: JSON.stringify(o) }).eq('session_id', sessionId)
  } catch (err) {
    console.error('[typing] stampTyping failed (non-fatal):', err instanceof Error ? err.message : err)
  }
}

// Is the given typing stamp inside the raw blob still fresh?
export function typingActive(raw: string | null | undefined, key: string): boolean {
  if (!raw || raw[0] !== '{') return false
  try {
    const o = JSON.parse(raw)
    const ts = o?.[key]
    if (typeof ts !== 'string') return false
    return Date.now() - new Date(ts).getTime() < TYPING_FRESH_MS
  } catch { return false }
}

export async function readTyping(sessionId: string, key: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('active_visitors')
      .select('page_url')
      .eq('session_id', sessionId)
      .maybeSingle()
    return typingActive(data?.page_url ?? null, key)
  } catch { return false }
}
