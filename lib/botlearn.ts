// The quote bot learns from the team, every day (owner, 2026-10-24: "daily ki
// human conversation se seekhe, max train karwana chahta hun").
//
// Three signals, strongest first:
//   1. a bot draft an agent EDITED before pressing Send — the first revision
//      of a crm_bot_draft is the bot's text, the 'sent' revision is the agent's;
//   2. a bot draft an agent DISCARDED, and what they sent the customer instead;
//   3. emails agents wrote themselves (not the bot), with the customer message
//      they answered.
// A model turns them into short, general lessons ("when a customer gives only
// a candle's ounces, ask for its height and diameter"), merged with the
// lessons already learned, capped at MAX_LESSONS. They are stored as one
// crm_bot_lessons control row (newest wins, history kept) on the reserved
// zeeops-crm site and appended to the draft writer's instructions — the hard
// rules there still win. The owner sees and removes them at /bot-lessons.

import { supabase, fetchAllPages } from './supabase'
import { REMINDER_SITE } from './reminders'
import { llmComplete, CLAUDE_WORK_MODEL } from './llm'
import { CRM_BOT_DRAFT_ROLE, parseBotDraft, type BotDraft } from './botdraft'
import { CRM_EMAIL_ROLE, parseCrmEmail } from './crmemail'
import { PACKAGING_SITES } from './workspaces'
import { splitQuoted } from './emailreply'

export const CRM_BOT_LESSONS_ROLE = 'crm_bot_lessons'
export const BOT_LESSONS_SESSION = 'zeeops-bot-lessons'
export const MAX_LESSONS = 40

export interface BotLesson { id: string; text: string; from: 'edited' | 'discarded' | 'human' | 'owner'; at: string; evidence?: string }
export interface BotLessons { lessons: BotLesson[]; at: string; by: string; learnedFrom?: { edited: number; discarded: number; human: number } }

export function parseLessons(message: string | null | undefined): BotLessons | null {
  try {
    const o = JSON.parse(String(message ?? ''))
    return o && Array.isArray(o.lessons) ? (o as BotLessons) : null
  } catch { return null }
}

export async function readLessons(): Promise<BotLessons> {
  const { data } = await supabase.from('chat_logs').select('message')
    .eq('session_id', BOT_LESSONS_SESSION).eq('role', CRM_BOT_LESSONS_ROLE)
    .order('created_at', { ascending: false }).limit(1)
  return parseLessons(data?.[0]?.message) ?? { lessons: [], at: '', by: '' }
}

export async function writeLessons(l: BotLessons): Promise<void> {
  await supabase.from('chat_logs').insert({ site_id: REMINDER_SITE, session_id: BOT_LESSONS_SESSION, role: CRM_BOT_LESSONS_ROLE, message: JSON.stringify(l) })
}

let cache: { at: number; text: string } | null = null
/** The lessons as a block for the draft writer's instructions (cached 10 min). */
export async function lessonsBlock(): Promise<string> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.text
  let text = ''
  try {
    const l = await readLessons()
    if (l.lessons.length) {
      text = `\n\nLESSONS LEARNED FROM OUR AGENTS' REAL EMAILS (follow them unless a numbered rule above says otherwise):\n${l.lessons.map((x) => `- ${x.text}`).join('\n')}`
    }
  } catch { text = '' }
  cache = { at: Date.now(), text }
  return text
}

const clip = (s: string, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const norm = (s: string) => clip(s, 4000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface LearnSignals {
  edited: { bot: string; agent: string }[]
  discarded: { bot: string; agent: string; why?: string }[]
  human: { customer: string; agent: string }[]
}

/** Gather `hours` of signals across the packaging sites, ending at `endMs`
 *  (now by default — the nightly pass). A history replay walks it back week by week. */
export async function gatherSignals(hours = 26, endMs = Date.now()): Promise<LearnSignals> {
  const since = new Date(endMs - hours * 3600_000).toISOString()
  const until = new Date(endMs).toISOString()
  const draftSince = new Date(endMs - (hours + 72) * 3600_000).toISOString()
  const sites = [...PACKAGING_SITES]
  // Paged: a plain select stops at 1,000 rows whatever .limit() asks for.
  const [drafts, emails] = await Promise.all([
    fetchAllPages<{ session_id: string; message: string; created_at: string }>(() => supabase.from('chat_logs').select('session_id, message, created_at').eq('role', CRM_BOT_DRAFT_ROLE).in('site_id', sites)
      .gte('created_at', draftSince).lte('created_at', until).order('created_at', { ascending: true }), 20000),
    fetchAllPages<{ session_id: string; message: string; created_at: string }>(() => supabase.from('chat_logs').select('session_id, message, created_at').in('role', [CRM_EMAIL_ROLE, 'crm_email_in']).in('site_id', sites)
      .gte('created_at', draftSince).lte('created_at', until).order('created_at', { ascending: true }), 40000),
  ])
  // Each draft id: its first (bot) revision and its decided revision.
  const byId = new Map<string, { session: string; first: BotDraft; last: BotDraft; lastAt: string }>()
  for (const r of drafts ?? []) {
    const d = parseBotDraft(r.message)
    if (!d) continue
    const cur = byId.get(d.id)
    if (!cur) byId.set(d.id, { session: r.session_id, first: d, last: d, lastAt: r.created_at })
    else { cur.last = d; cur.lastAt = r.created_at }
  }
  const sessionEmails = new Map<string, { at: string; out: boolean; bot: boolean; text: string; sentBy: string }[]>()
  for (const r of emails ?? []) {
    let item: { at: string; out: boolean; bot: boolean; text: string; sentBy: string } | null = null
    try {
      const o = JSON.parse(r.message)
      if (o?.direction === 'outbound') {
        const e = parseCrmEmail(r.message)
        if (e) item = { at: e.at || r.created_at, out: true, bot: !!(o.bot), text: e.body, sentBy: e.sentBy }
      } else if (o && (o.body || o.text)) {
        item = { at: o.at || r.created_at, out: false, bot: false, text: String(o.body ?? o.text ?? ''), sentBy: '' }
      }
    } catch { item = null }
    if (!item) continue
    const l = sessionEmails.get(r.session_id) ?? []
    l.push(item)
    sessionEmails.set(r.session_id, l)
  }
  const visible = (t: string) => { try { return splitQuoted(t).visible } catch { return t } }
  const out: LearnSignals = { edited: [], discarded: [], human: [] }
  const draftSent = new Set<string>()
  for (const d of byId.values()) {
    if (d.lastAt < since) continue
    if (d.last.status === 'sent') {
      draftSent.add(`${d.session}|${clip(d.last.text, 80)}`)
      if (norm(d.first.text) !== norm(d.last.text)) out.edited.push({ bot: clip(d.first.text, 1200), agent: clip(d.last.text, 1200) })
    } else if (d.last.status === 'discarded') {
      const after = (sessionEmails.get(d.session) ?? []).find((e) => e.out && !e.bot && e.at >= (d.last.decidedAt ?? d.lastAt))
      if (after) out.discarded.push({ bot: clip(d.first.text, 1200), agent: clip(visible(after.text), 1200), why: d.last.why })
    }
  }
  for (const [session, list] of sessionEmails) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (!e.out || e.bot || e.at < since) continue
      if (draftSent.has(`${session}|${clip(e.text, 80)}`)) continue
      const prev = [...list.slice(0, i)].reverse().find((x) => !x.out)
      out.human.push({ customer: prev ? clip(visible(prev.text), 900) : `@lead:${session}`, agent: clip(visible(e.text), 1200) })
    }
  }
  out.human = out.human.slice(-25)
  // A first reply answers the enquiry itself: read it off the lead.
  const want = out.human.filter((h) => h.customer.startsWith('@lead:quote-')).map((h) => h.customer.slice('@lead:quote-'.length))
  if (want.length) {
    const { data: leads } = await supabase.from('leads').select('id, message').in('id', want)
    const msg = new Map((leads ?? []).map((l) => [`@lead:quote-${l.id}`, clip(String(l.message ?? '').replace(/^\[[^\]]+\]\s*/, ''), 900)]))
    for (const h of out.human) if (h.customer.startsWith('@lead:')) h.customer = msg.get(h.customer) ?? ''
  }
  return out
}

const LEARN_SYSTEM = `You maintain the house rules a quote-reply bot follows at a custom packaging company (boxes, cups, sleeves, wax paper, stickers, mailers). Sales agents review the bot's first replies to customers; you are shown what they changed, what they threw away and wrote instead, and emails they wrote themselves. Turn that into SHORT, GENERAL, ACTIONABLE lessons for the bot.

Return JSON only: {"lessons":[{"text":"...","from":"edited|discarded|human|owner","evidence":"one short phrase"}]}

Rules for lessons:
- Each lesson is one sentence, at most 35 words, in English, written as an instruction to the bot ("When ..., ask for ...", "Never ...", "Mention ...").
- General, never about one customer: no names, emails, phone numbers, company names, prices, order numbers or dates.
- Only what the agents' behaviour clearly shows. Skip typos, signatures and small rewording.
- Never a lesson that writes a price, a discount, a turnaround promise or a free sample — those stay with the agent.
- Never a lesson that sends the customer to another supplier, turns a customer away, or tells the bot to state a fact it cannot know (an exact maximum size, stock, a capability, a lead time). The bot only knows what the customer wrote plus these facts: we make to the customer's own size and design; free 2D/3D mockups and design support; free shipping; no hidden charges; minimum usually 250 per size or design (1,000 cups and sleeves, 500 mailers and bags), and a smaller first run can be checked.
- The bot's fixed rules already cover: asking for missing size/style/quantity, stating the minimum when the quantity is below it, never promising samples, being honest about tight deadlines, oversized sizes and round corrugated boxes going to production. Do not restate those; learn what goes BEYOND them (wording, what to ask for which product, what to leave out).
- Merge with the EXISTING lessons: keep the ones still right (unchanged text, same "from"), improve or merge near-duplicates, drop ones the new evidence contradicts. Keep every lesson whose "from" is "owner" unchanged.
- At most ${MAX_LESSONS} lessons in total, most useful first.`

/** One learning pass: gather, ask the model, merge, store. */
export async function learnFromTeam(opts: { dryRun?: boolean; hours?: number; endMs?: number } = {}): Promise<{ ok: boolean; why?: string; signals: { edited: number; discarded: number; human: number }; before: number; after?: BotLessons }> {
  const sig = await gatherSignals(opts.hours ?? 26, opts.endMs ?? Date.now())
  const counts = { edited: sig.edited.length, discarded: sig.discarded.length, human: sig.human.length }
  const current = await readLessons()
  if (!counts.edited && !counts.discarded && !counts.human) return { ok: true, why: 'nothing new to learn from', signals: counts, before: current.lessons.length }
  const user = [
    'EXISTING LESSONS:', JSON.stringify(current.lessons.map((l) => ({ text: l.text, from: l.from }))), '',
    `DRAFTS THE AGENTS EDITED BEFORE SENDING (${counts.edited}):`,
    ...sig.edited.slice(0, 20).map((e, i) => `#${i + 1}\nBOT WROTE:\n${e.bot}\nAGENT SENT:\n${e.agent}`), '',
    `DRAFTS THE AGENTS DISCARDED (${counts.discarded}):`,
    ...sig.discarded.slice(0, 15).map((e, i) => `#${i + 1}${e.why ? ` (reason given: ${e.why})` : ''}\nBOT WROTE:\n${e.bot}\nAGENT SENT INSTEAD:\n${e.agent}`), '',
    `EMAILS AGENTS WROTE THEMSELVES (${counts.human}):`,
    ...sig.human.slice(0, 40).map((e, i) => `#${i + 1}\nCUSTOMER WROTE:\n${e.customer || '(new enquiry)'}\nAGENT REPLIED:\n${e.agent}`),
  ].join('\n').slice(0, 60000)
  const r = await llmComplete({ system: LEARN_SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: 8000, anthropicMaxTokens: 8000, model: CLAUDE_WORK_MODEL, timeoutMs: 110000 })
  if (r.error || !r.text.trim()) return { ok: false, why: 'the model did not answer', signals: counts, before: current.lessons.length }
  const m = r.text.match(/\{[\s\S]*\}/)
  let parsed: { lessons?: { text?: string; from?: string; evidence?: string }[] } = {}
  try { parsed = m ? JSON.parse(m[0]) : {} } catch { parsed = {} }
  if (!Array.isArray(parsed.lessons)) return { ok: false, why: `could not read the model's answer (stop: ${r.stopReason || '?'}): ${r.text.slice(0, 300)}`, signals: counts, before: current.lessons.length }
  const now = new Date().toISOString()
  const owner = current.lessons.filter((l) => l.from === 'owner')
  const learned: BotLesson[] = (parsed.lessons ?? [])
    .filter((l) => typeof l.text === 'string' && l.text.trim().length > 10)
    .filter((l) => !/[$€£]\s?\d|\bfree sample|alternat\w* (source|supplier|vendor)|another (supplier|vendor|company)|elsewhere/i.test(String(l.text)))
    .map((l, i) => {
      const text = clip(String(l.text), 260)
      const prev = current.lessons.find((x) => x.text === text)
      const from = (['edited', 'discarded', 'human', 'owner'].includes(String(l.from)) ? l.from : 'human') as BotLesson['from']
      return prev ?? { id: `bl_${Date.now().toString(36)}_${i}`, text, from, at: now, evidence: l.evidence ? clip(l.evidence, 120) : undefined }
    })
    .filter((l) => l.from !== 'owner' || owner.some((o) => o.text === l.text))
  const merged = [...owner, ...learned.filter((l) => !owner.some((o) => o.text === l.text))].slice(0, MAX_LESSONS)
  const next: BotLessons = { lessons: merged, at: now, by: 'zeeops-bot-learn', learnedFrom: counts }
  if (!opts.dryRun && merged.length) { await writeLessons(next); cache = null }
  return { ok: true, signals: counts, before: current.lessons.length, after: next }
}
