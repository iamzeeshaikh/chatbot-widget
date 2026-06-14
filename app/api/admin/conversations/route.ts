import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { getMember, siteScope } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ sessions: [] }, { status: 401 })
  const scope = await siteScope(member)

  const [logsRes, leadsRes, modesRes, sitesRes] = await Promise.all([
    supabase.from('chat_logs').select('*').order('created_at', { ascending: true }).limit(2000),
    supabase.from('leads').select('*'),
    supabase.from('conversation_mode').select('*'),
    supabase.from('sites').select('site_id, name, bot_name, primary_color'),
  ])

  const logs = logsRes.data ?? []
  const leads = leadsRes.data ?? []
  const modes = modesRes.data ?? []
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
  }> = {}

  for (const log of logs) {
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
      }
    }
    if (log.role === 'user' && log.message !== '(session started)' && !sessionMap[log.session_id].preview) {
      sessionMap[log.session_id].preview = log.message
    }
    sessionMap[log.session_id].last_at = log.created_at
    sessionMap[log.session_id].last_role = log.role
    sessionMap[log.session_id].message_count++
  }

  for (const m of modes) {
    if (sessionMap[m.session_id]) sessionMap[m.session_id].mode = m.mode
  }

  for (const l of leads) {
    if (sessionMap[l.site_id]) {
      // match lead to session by site — best effort
    }
    // match by closest session from same site — attach to last session for that site
    const matchedSession = Object.values(sessionMap)
      .filter((s) => s.site_id === l.site_id)
      .sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime())[0]
    if (matchedSession && !matchedSession.lead) {
      matchedSession.lead = { name: l.name, email: l.email }
    }
  }

  const sessions = Object.values(sessionMap)
    .filter((s) => !scope || scope.has(s.site_id))
    .sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime())

  return NextResponse.json({ sessions })
}
