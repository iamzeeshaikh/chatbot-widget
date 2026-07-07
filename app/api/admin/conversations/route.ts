import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'
import { deriveModes } from '@/lib/mode'
import { CONTACT_ROLE, TAGS_ROLE, parseTags, parseContact, asUtcIso } from '@/lib/visitor'
import { parseAttachment } from '@/lib/attachment'
import { LEAD_CAPTURE_ROLE, parseLeadCapture, extractEmail } from '@/lib/leadtracking'
import { isControlRole } from '@/lib/controlroles'
import { isBotEnabled } from '@/lib/botflag'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ sessions: [] }, { status: 401 })
  const scope = await siteScope(member)

  const [logsRes, leadsRes, sitesRes] = await Promise.all([
    // Fetch the NEWEST rows (descending), then process ascending — so recent
    // conversations are always included even once the table is large. (A plain
    // ascending limit fetched the OLDEST rows and dropped recent activity.)
    supabase.from('chat_logs').select('*').order('created_at', { ascending: false }).limit(3000),
    supabase.from('leads').select('*'),
    supabase.from('sites').select('site_id, name, bot_name, primary_color'),
  ])

  const logs = (logsRes.data ?? []).reverse() // back to ascending for last-wins logic
  const leads = leadsRes.data ?? []
  const modes = deriveModes(logs) // per-session mode from 'mode' control rows
  const sites = sitesRes.data ?? []

  const sessionMap: Record<string, {
    session_id: string
    site_id: string
    preview: string
    last_at: string
    message_count: number
    last_role: string
    mode: string
    lead: { name: string | null; email: string | null } | null
    site_name: string
    tags: string[]
  }> = {}

  // Latest tags per session (logs are ascending, so the last TAGS_ROLE wins).
  const tagsBySession: Record<string, string[]> = {}
  // Genuine lead per session — set ONLY from a real email capture, never by site.
  const leadBySession: Record<string, { name: string | null; email: string | null }> = {}
  // email → session_id, built from real signals (visitor-typed email, contact
  // row, lead_capture) so leads-table rows can be matched by email, not by site.
  const emailToSession: Record<string, string> = {}

  for (const log of logs) {
    if (log.role === TAGS_ROLE) { tagsBySession[log.session_id] = parseTags(log.message); continue }
    if (log.role === LEAD_CAPTURE_ROLE) {
      const cap = parseLeadCapture(log.message)
      if (cap?.email) {
        leadBySession[log.session_id] = { name: cap.name, email: cap.email }
        emailToSession[`${log.site_id}|${cap.email.toLowerCase()}`] = log.session_id
      }
      continue
    }
    if (log.role === CONTACT_ROLE) {
      const c = parseContact(log.message)
      if (c.email) emailToSession[`${log.site_id}|${c.email.toLowerCase()}`] = log.session_id
      continue
    }
    // Any remaining control row (mode, reply_author, …) is metadata, not a
    // message — never let it become a preview or count toward the message total.
    if (isControlRole(log.role)) continue
    if (!sessionMap[log.session_id]) {
      const site = sites.find((s) => s.site_id === log.site_id)
      sessionMap[log.session_id] = {
        session_id: log.session_id,
        site_id: log.site_id,
        preview: '',
        last_at: log.created_at,
        message_count: 0,
        last_role: '',
        mode: 'bot',
        lead: null,
        site_name: site?.name ?? log.site_id,
        tags: [],
      }
    }
    if (log.message === '(session started)') continue // sentinel: not a real message
    // Preview = the LATEST message text (any role). Ascending order → last wins.
    const att = parseAttachment(log.message)
    sessionMap[log.session_id].preview = att ? `📎 ${att.name}` : log.message
    sessionMap[log.session_id].last_at = log.created_at
    sessionMap[log.session_id].last_role = log.role
    sessionMap[log.session_id].message_count++
    // Index any visitor-typed email for lead matching.
    if (log.role === 'user') {
      const e = extractEmail(log.message)
      if (e) emailToSession[`${log.site_id}|${e.toLowerCase()}`] = log.session_id
    }
  }

  for (const [sessionId, mode] of Object.entries(modes)) {
    if (sessionMap[sessionId]) sessionMap[sessionId].mode = mode
  }

  for (const [sessionId, tags] of Object.entries(tagsBySession)) {
    if (sessionMap[sessionId]) sessionMap[sessionId].tags = tags
  }

  // Lead flag: a session is a "lead" only if it actually captured an email
  // (lead_capture row), OR a leads-table lead matches it by email+site. Never by
  // site alone — that wrongly flagged unrelated recent conversations.
  for (const [sessionId, lead] of Object.entries(leadBySession)) {
    if (sessionMap[sessionId]) sessionMap[sessionId].lead = lead
  }
  for (const l of leads) {
    if (!l.email) continue
    const sid = emailToSession[`${l.site_id}|${String(l.email).toLowerCase()}`]
    if (sid && sessionMap[sid] && !sessionMap[sid].lead) {
      sessionMap[sid].lead = { name: l.name, email: l.email }
    }
  }

  const sessions = Object.values(sessionMap)
    .filter((s) => !scope || scope.has(s.site_id))
    .map((s) => ({ ...s, last_at: asUtcIso(s.last_at) })) // normalise naive-UTC so "X ago" is correct
    .sort((a, b) => new Date(b.last_at!).getTime() - new Date(a.last_at!).getTime())

  // bot_enabled carries the SERVER's view of the global kill switch (including
  // any BOT_ENABLED env override) to the dashboard so its bot UI stays truthful.
  return NextResponse.json({ sessions, bot_enabled: isBotEnabled() })
}
