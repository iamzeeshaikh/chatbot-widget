// The display name a customer sees when a member answers them in the widget.
//
// WHY IT IS NOT A COLUMN: this project has no DDL access, so `members` cannot
// grow a `name` field. It is stored the way every other member-scoped value is
// (prefs, reminders, push subscriptions): an append-only control row on the
// reserved `zeeops-crm` site, newest row per email wins on read. Nothing is
// updated in place, so who set which name and when stays in the record.
//
// A reserved site is in nobody's site scope, so these rows can never surface in
// a conversation list, a lead's timeline or a message count.

import { supabase } from './supabase'
import { CRM_MEMBER_NAME_ROLE } from './crm'
import { REMINDER_SITE } from './reminders'
import { agentDisplayName } from './agentname'

export const MEMBER_NAME_SESSION = 'zeeops-crm-member-names'
/** Long enough for a real name, short enough to fit the widget header. */
export const MAX_MEMBER_NAME = 40

interface Stored { email: string; displayName: string; phone?: string; by?: string; at?: string }

function parse(message: string | null | undefined): Stored | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (!o || typeof o.email !== 'string') return null
    return {
      email: o.email.toLowerCase(),
      displayName: typeof o.displayName === 'string' ? o.displayName : '',
      // The member's OWN number, which the CRM rings first when they place a
      // call. It is never shown to a customer — the caller ID is the business's
      // Twilio number — and never shown to other members either.
      phone: typeof o.phone === 'string' ? o.phone : '',
    }
  } catch {
    return null
  }
}

/**
 * email -> the name to show a customer. Only emails with a name SET appear;
 * the caller falls back to agentDisplayName, which derives one from the address.
 */
export async function storedMemberNames(): Promise<Map<string, string>> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('site_id', REMINDER_SITE)
    .eq('session_id', MEMBER_NAME_SESSION)
    .eq('role', CRM_MEMBER_NAME_ROLE)
    .order('created_at', { ascending: true })   // ascending → the newest wins
  const out = new Map<string, string>()
  for (const row of data ?? []) {
    const e = parse(row.message)
    if (!e) continue
    // An empty name is how a name is CLEARED — the row is kept, the value goes.
    if (e.displayName.trim()) out.set(e.email, e.displayName.trim())
    else out.delete(e.email)
  }
  return out
}

/** The one name to show for this member: theirs if set, otherwise derived. */
export async function memberDisplayName(email: string): Promise<string> {
  const names = await storedMemberNames()
  return names.get(email.trim().toLowerCase()) || agentDisplayName(email)
}

export async function setMemberDisplayName(
  email: string, displayName: string, by: string, phone?: string,
): Promise<string | null> {
  const clean = displayName.trim().slice(0, MAX_MEMBER_NAME)
  const cleanPhone = (phone ?? '').trim().slice(0, 24)
  const { error } = await supabase.from('chat_logs').insert([{
    session_id: MEMBER_NAME_SESSION,
    site_id: REMINDER_SITE,
    role: CRM_MEMBER_NAME_ROLE,
    message: JSON.stringify({
      email: email.trim().toLowerCase(), displayName: clean, phone: cleanPhone,
      by, at: new Date().toISOString(),
    }),
  }])
  return error?.message ?? null
}

/** The number to ring when this member places a call, or null if none is set. */
export async function memberCallPhone(email: string): Promise<string | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('site_id', REMINDER_SITE)
    .eq('session_id', MEMBER_NAME_SESSION)
    .eq('role', CRM_MEMBER_NAME_ROLE)
    .order('created_at', { ascending: true })
  let phone = ''
  const want = email.trim().toLowerCase()
  for (const row of data ?? []) {
    const e = parse(row.message)
    if (e && e.email === want) phone = (e.phone ?? '').trim()
  }
  return phone || null
}
