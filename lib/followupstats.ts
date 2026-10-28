// Follow-up results for the team (owner, 2026-10-28: "team dekh k motivate
// ho"). What the quote bot's follow-ups did: how many went out, how many
// customers wrote back afterwards, and what they said — per agent, with every
// reply listed and linked to its lead. Packaging only, read-only.
//
// A follow-up is a `crm_bot` ledger row, step 'followup' (asking for details)
// or 'quote_fu' (after the price), state 'sent'. A reply is a `crm_email_in`
// on the same lead after that lead's first follow-up; bounces are not replies.

import { supabase, fetchAllPages, warnIfCapped } from './supabase'
import { workspaceSites } from './workspaces'

export type ReplyMood = 'interested' | 'later' | 'no'

export interface FollowUpReply {
  leadId: string
  siteId: string
  siteName: string
  name: string
  agent: string
  followUps: number
  firstFollowUpAt: string
  repliedAt: string
  mood: ReplyMood
  said: string
}

export interface FollowUpStats {
  days: number
  sent: number
  leads: number
  replied: number
  interested: number
  later: number
  no: number
  byAgent: { agent: string; sent: number; leads: number; replied: number; interested: number }[]
  replies: FollowUpReply[]
}

const NO_RE = /not (?:going to|be) (?:move|moving) forward|not interested|no longer (?:need|interested)|(?:went|go|going|moved?|decided to (?:go|move)) (?:forward )?with (?:another|a different|someone else)|ordered (?:from|with) (?:a )?(?:different|another)|other arrangements|out of (?:my|our) (?:price )?(?:range|budget)|price range|too (?:high|expensive|much)|moq is (?:a bit )?too high|found (?:a|another) (?:standard )?(?:box|supplier|option)|holding off|hold off|not (?:at this time|right now)|we(?:'| a)re all set|please remove|unsubscribe/i
const LATER_RE = /get back to you|on vacation|next week|follow up (?:on|next)|in a (?:few|couple of) (?:days|weeks)|let me (?:check|think|get back)|will (?:reach out|be in touch)|circle back/i

/** What the reply says, roughly. A reply that asks or adds anything counts as interested. */
export function moodOf(text: string): ReplyMood {
  const t = String(text || '').slice(0, 1500)
  if (NO_RE.test(t)) return 'no'
  if (LATER_RE.test(t)) return 'later'
  return 'interested'
}

const ownText = (body: string) => String(body || '').split(/\n--\s*\n|\nOn .{5,200}wrote:|\nLe .{5,200}écrit|\n>/)[0].replace(/\s+/g, ' ').trim()

export async function loadFollowUpStats(days = 30): Promise<FollowUpStats> {
  const since = new Date(Date.now() - days * 864e5).toISOString()
  const sites = workspaceSites('packaging')
  const rows = await fetchAllPages<{ session_id: string; site_id: string; message: string }>(() => supabase.from('chat_logs')
    .select('session_id, site_id, message').eq('role', 'crm_bot').in('site_id', sites).gte('created_at', since)
    .like('message', '%"state":"sent"%').order('created_at', { ascending: true }), 50000)
  warnIfCapped('follow-up stats', rows.length, 50000)

  interface L { siteId: string; agent: string; n: number; first: string }
  const lead = new Map<string, L>()
  const agentSent = new Map<string, number>()
  let sent = 0
  for (const r of rows) {
    let o: { step?: string; at?: string; agent?: string }
    try { o = JSON.parse(r.message) } catch { continue }
    if (o.step !== 'followup' && o.step !== 'quote_fu') continue
    sent++
    const agent = String(o.agent || '').toLowerCase()
    agentSent.set(agent, (agentSent.get(agent) ?? 0) + 1)
    const at = String(o.at || '')
    const cur = lead.get(r.session_id)
    if (!cur) lead.set(r.session_id, { siteId: r.site_id, agent, n: 1, first: at })
    else { cur.n++; if (at < cur.first) cur.first = at; if (agent) cur.agent = agent }
  }

  const ids = [...lead.keys()]
  const firstIn = new Map<string, { at: string; body: string }>()
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('chat_logs').select('session_id, message, created_at')
      .in('session_id', ids.slice(i, i + 100)).eq('role', 'crm_email_in').gte('created_at', since)
      .order('created_at', { ascending: true }).range(0, 9999)
    for (const r of data ?? []) {
      const l = lead.get(r.session_id)
      if (!l || firstIn.has(r.session_id) || r.created_at <= l.first) continue
      let o: { from?: string; body?: string }
      try { o = JSON.parse(r.message) } catch { continue }
      if (/mailer-daemon|postmaster/i.test(`${o.from ?? ''} ${(o.body ?? '').slice(0, 300)}`)) continue
      firstIn.set(r.session_id, { at: r.created_at, body: String(o.body ?? '') })
    }
  }

  const quoteIds = [...firstIn.keys()].filter((s) => s.startsWith('quote-')).map((s) => s.slice(6))
  const names = new Map<string, string>()
  for (let i = 0; i < quoteIds.length; i += 100) {
    const { data } = await supabase.from('leads').select('id, name, email').in('id', quoteIds.slice(i, i + 100))
    // A name the intake mis-read ("ATTACHMENT", "CONTENTS") is worse than the address.
    for (const l of data ?? []) names.set(`quote-${l.id}`, String((l.name && !/^[A-Z ]{4,}$/.test(l.name) ? l.name : '') || l.email || 'Customer'))
  }
  const { data: siteRows } = await supabase.from('sites').select('site_id, name')
  const siteName = new Map((siteRows ?? []).map((s) => [String(s.site_id), String(s.name ?? s.site_id)]))

  const replies: FollowUpReply[] = []
  for (const [id, r] of firstIn) {
    // A deleted lead (spam, our own test) is not a result.
    if (id.startsWith('quote-') && !names.has(id)) continue
    const l = lead.get(id)!
    const said = ownText(r.body)
    replies.push({ leadId: id, siteId: l.siteId, siteName: siteName.get(l.siteId) ?? l.siteId, name: names.get(id) ?? 'Customer',
      agent: l.agent, followUps: l.n, firstFollowUpAt: l.first, repliedAt: r.at, mood: moodOf(said), said: said.slice(0, 280) })
  }
  replies.sort((a, b) => b.repliedAt.localeCompare(a.repliedAt))

  const agents = new Map<string, { agent: string; sent: number; leads: number; replied: number; interested: number }>()
  const row = (a: string) => { let x = agents.get(a); if (!x) { x = { agent: a, sent: agentSent.get(a) ?? 0, leads: 0, replied: 0, interested: 0 }; agents.set(a, x) } return x }
  for (const l of lead.values()) row(l.agent).leads++
  for (const r of replies) { const x = row(r.agent); x.replied++; if (r.mood !== 'no') x.interested++ }

  return {
    days, sent, leads: lead.size, replied: replies.length,
    interested: replies.filter((r) => r.mood === 'interested').length,
    later: replies.filter((r) => r.mood === 'later').length,
    no: replies.filter((r) => r.mood === 'no').length,
    byAgent: [...agents.values()].filter((a) => a.agent).sort((a, b) => b.replied - a.replied || b.sent - a.sent),
    replies,
  }
}
