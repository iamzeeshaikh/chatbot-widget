// Who answered a lead first, and how fast — the quote bot or a person.
//
// Packaging's Recent Leads shows it (owner, 2026-10-14): the bot is meant to
// write within ~5 minutes, and an agent who got there first should get the
// credit. "First" means the first thing that reached the customer AFTER the
// lead existed: an email (the bot's or an agent's), a WhatsApp, a call an
// agent placed, or an agent's message in the chat. The chat greeting that
// fires before anyone leaves their details is not a response to the lead.
//
// A packaging chat lead is two records — the chat and the `leads` row the bot
// works (quote-<id>) — so both are read and the earlier answer wins.

import { supabase, fetchAllPages } from './supabase'
import { CRM_EMAIL_ROLE, parseCrmEmail } from './crmemail'
import { CRM_WA_OUT_ROLE, CRM_CALL_ROLE } from './crm'
import { REPLY_AUTHOR_ROLE, parseReplyAuthor } from './replyauthor'

export interface FirstResponse {
  /** 'bot', or the member's email. */
  by: string
  at: string
  /** Minutes from the lead arriving to the answer. */
  minutes: number
  via: 'email' | 'whatsapp' | 'call' | 'chat'
}

const ms = (s: string) => Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`)

export async function firstResponses(
  leads: { key: string; sessions: string[]; createdAt: string }[],
): Promise<Map<string, FirstResponse>> {
  const out = new Map<string, FirstResponse>()
  const all = [...new Set(leads.flatMap((l) => l.sessions))]
  type Row = { session_id: string; role: string; message: string; created_at: string }
  const bySession = new Map<string, Row[]>()
  for (let i = 0; i < all.length; i += 60) {
    const chunk = all.slice(i, i + 60)
    const rows = await fetchAllPages<Row>(
      () => supabase.from('chat_logs').select('session_id, role, message, created_at')
        .in('session_id', chunk).in('role', [CRM_EMAIL_ROLE, CRM_WA_OUT_ROLE, CRM_CALL_ROLE, 'admin', REPLY_AUTHOR_ROLE])
        .order('created_at', { ascending: true }),
      20000,
    )
    for (const r of rows) { const l = bySession.get(r.session_id) ?? []; l.push(r); bySession.set(r.session_id, l) }
  }

  for (const lead of leads) {
    const from = ms(lead.createdAt) - 60 * 1000
    let best: FirstResponse | null = null
    for (const sid of lead.sessions) {
      const rows = bySession.get(sid) ?? []
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const t = ms(r.created_at)
        if (!(t >= from) || (best && t >= ms(best.at))) continue
        let by = ''
        let via: FirstResponse['via'] = 'email'
        if (r.role === CRM_EMAIL_ROLE) {
          const e = parseCrmEmail(r.message)
          if (!e || e.imported) continue
          by = e.bot ? 'bot' : e.sentBy.toLowerCase()
        } else if (r.role === CRM_WA_OUT_ROLE) {
          via = 'whatsapp'
          try { by = String(JSON.parse(r.message)?.by ?? JSON.parse(r.message)?.sentBy ?? '').toLowerCase() } catch { by = '' }
        } else if (r.role === CRM_CALL_ROLE) {
          via = 'call'
          try { by = String(JSON.parse(r.message)?.by ?? '').toLowerCase() } catch { by = '' }
          if (!by.includes('@')) continue // a call TO us, not an answer
        } else if (r.role === 'admin') {
          via = 'chat'
          // The author row sits right before or right after the message.
          const near = rows.filter((x) => x.role === REPLY_AUTHOR_ROLE && Math.abs(ms(x.created_at) - t) < 10000)
            .sort((a, b) => Math.abs(ms(a.created_at) - t) - Math.abs(ms(b.created_at) - t))[0]
          by = (parseReplyAuthor(near?.message)?.email ?? '').toLowerCase()
          if (!by) continue
        } else continue
        if (!by) continue
        best = { by, at: new Date(t).toISOString(), minutes: Math.max(0, Math.round((t - ms(lead.createdAt)) / 60000)), via }
      }
    }
    if (best) out.set(lead.key, best)
  }
  return out
}
