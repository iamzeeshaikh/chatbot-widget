import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteOfSession, canAccessSite } from '@/lib/auth'
import { MODE_ROLE } from '@/lib/mode'
import { unpackVisitor, CONTACT_ROLE, parseContact, EMPTY_CONTACT, VisitorContact } from '@/lib/visitor'

export const dynamic = 'force-dynamic'

// Rich detail for the visitor behind one chat session: editable contact,
// stats (visits / chats / time on site), page-visit path, and technical info.
// Always scoped through canAccessSession so a standard member can only ever read
// sessions for their assigned sites, and sports/packaging stay isolated.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const sessionId = req.nextUrl.searchParams.get('sessionId')
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const [visitorRes, logsRes] = await Promise.all([
    supabase.from('active_visitors').select('*').eq('session_id', sessionId).maybeSingle(),
    supabase
      .from('chat_logs')
      .select('role, message, created_at, site_id')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true }),
  ])

  const v = visitorRes.data
  const logs = logsRes.data ?? []

  // The session's site can come from the visitor row (visitors who never chatted)
  // or from its chat logs. Authorize against that site so the same workspace +
  // assigned-site isolation applies as everywhere else.
  const siteId = v?.site_id ?? logs[0]?.site_id ?? null
  if (!siteId || !canAccessSite(member, siteId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const packed = unpackVisitor(v?.page_url ?? null)

  // Latest contact control row wins (logs are ascending, so last one is newest).
  let contact: VisitorContact = { ...EMPTY_CONTACT }
  for (const log of logs) {
    if (log.role === CONTACT_ROLE) contact = parseContact(log.message)
  }

  // Genuine chat messages from the visitor (excludes control rows + the
  // '(session started)' sentinel).
  const userMessages = logs.filter(
    (l) => l.role === 'user' && l.message !== '(session started)',
  )
  const messageLogs = logs.filter((l) => l.role !== MODE_ROLE && l.role !== CONTACT_ROLE)

  // Time on site: first activity (visitor row creation or first log) → last seen.
  const times = [
    ...(v?.created_at ? [v.created_at] : []),
    ...(messageLogs.length ? [messageLogs[0].created_at] : []),
  ]
  const firstSeen = times.length ? times.reduce((a, b) => (a < b ? a : b)) : null
  const lastSeen = v?.last_seen
    ?? (messageLogs.length ? messageLogs[messageLogs.length - 1].created_at : null)

  // Page path. Prefer the recorded history trail; fall back to the single
  // current page for legacy rows that predate history capture.
  let path = packed.history.map((h) => ({ url: h.u, title: h.t, at: h.ts }))
  if (path.length === 0 && packed.page_url) {
    path = [{ url: packed.page_url, title: packed.page_title, at: lastSeen }]
  }

  return NextResponse.json({
    detail: {
      session_id: sessionId,
      site_id: siteId,
      contact,
      stats: {
        visits: packed.visits,
        chats: userMessages.length,
        first_seen: firstSeen,
        last_seen: lastSeen,
      },
      path,
      technical: {
        country: v?.country ?? null,
        city: v?.city ?? null,
        browser: v?.browser ?? null,
        os: v?.os ?? null,
        device_type: v?.device_type ?? null,
        ip: packed.ip,
        referrer: packed.referrer,
        screen_width: v?.screen_width ?? null,
        user_agent: v?.user_agent ?? null,
      },
    },
  })
}

// Save (upsert) the agent-entered contact details as a fresh control row.
export async function PATCH(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const sessionId: string | undefined = body.sessionId
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  // Resolve the site from chat logs, falling back to the visitor row for sessions
  // that have pinged but never chatted, then authorize against it.
  let siteId = await siteOfSession(sessionId)
  if (!siteId) {
    const { data } = await supabase
      .from('active_visitors').select('site_id').eq('session_id', sessionId).maybeSingle()
    siteId = data?.site_id ?? null
  }
  if (!siteId || !canAccessSite(member, siteId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const contact: VisitorContact = {
    name: String(body.name ?? '').trim(),
    email: String(body.email ?? '').trim(),
    phone: String(body.phone ?? '').trim(),
    notes: String(body.notes ?? '').trim(),
  }

  const { error } = await supabase.from('chat_logs').insert({
    site_id: siteId,
    session_id: sessionId,
    role: CONTACT_ROLE,
    message: JSON.stringify(contact),
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, contact })
}
