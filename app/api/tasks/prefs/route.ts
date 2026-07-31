import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import {
  CRM_PREFS_ROLE, REMINDER_SITE, PREFS_SESSION, DEFAULT_PREFS,
  parsePrefs, prefsFor, type ReminderPrefs,
} from '@/lib/reminders'

export const dynamic = 'force-dynamic'

// A member's own reminder preferences. Always scoped to the caller — there is
// no way to read or write someone else's, so this needs no site check: the
// identity IS the authorisation.
//
// Stored as crm_prefs control rows on a reserved session, append-only, newest
// revision per email wins.

async function currentPrefs(email: string): Promise<ReminderPrefs> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message, created_at')
    .eq('role', CRM_PREFS_ROLE)
    .eq('session_id', PREFS_SESSION)
    .order('created_at', { ascending: false })
    .limit(500)
  const target = email.toLowerCase()
  for (const r of data ?? []) {
    const p = parsePrefs(r.message)
    if (p && p.email.toLowerCase() === target) return p // descending → first is newest
  }
  return prefsFor(email, null)
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ prefs: await currentPrefs(member.email), defaults: DEFAULT_PREFS })
}

export async function POST(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const existing = await currentPrefs(member.email)

  const hour = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? Math.floor(v) : NaN
    return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback
  }
  const lead = typeof body.leadMinutes === 'number' && body.leadMinutes >= 0 && body.leadMinutes <= 10080
    ? Math.floor(body.leadMinutes)
    : existing.leadMinutes

  const next: ReminderPrefs = {
    // The email is taken from the session, never from the body — that is what
    // stops one member writing another's preferences.
    email: member.email,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
    leadMinutes: lead,
    digestEnabled: typeof body.digestEnabled === 'boolean' ? body.digestEnabled : existing.digestEnabled,
    digestHour: hour(body.digestHour, existing.digestHour),
    quietStart: hour(body.quietStart, existing.quietStart),
    quietEnd: hour(body.quietEnd, existing.quietEnd),
    updated_at: new Date().toISOString(),
  }

  const { error } = await supabase.from('chat_logs').insert({
    site_id: REMINDER_SITE,
    session_id: PREFS_SESSION,
    role: CRM_PREFS_ROLE,
    message: JSON.stringify(next),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, prefs: next })
}
