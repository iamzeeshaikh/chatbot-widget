// GLOBAL bot kill switch — applies to EVERY site in BOTH workspaces (packaging
// and sports). When the bot is disabled, /api/chat never calls the LLM and never
// sends any automated reply: visitor messages just land in the conversation and
// wait for a human agent (the ONLY reply path). The widget, live-visitor
// tracking, agent dashboard and takeover flow all keep working normally.
//
// This is independent of, and stronger than, the packaging weekday schedule in
// lib/botschedule.ts: the schedule only matters while the bot is globally
// enabled here.
//
// ── How to flip it ────────────────────────────────────────────────────────────
// The default lives in code (BOT_ENABLED_DEFAULT below) so a plain git push
// deploys the desired state with no dashboard work. The BOT_ENABLED env var,
// when set, overrides the code default — set BOT_ENABLED=true in Vercel and
// redeploy to re-enable the bot without a code change (or flip the constant
// and push).

import { siteWorkspace, type Workspace } from './workspaces'

export const BOT_ENABLED_DEFAULT = false

// ── Sports is bot-first, packaging is human-first (2026-08-13) ───────────────
// The switch above is no longer global. Packaging has a full team of human
// agents on shift, so its bot stays off and every visitor message waits for a
// person. Sports has NO human agents at all — a visitor there who is not
// answered by the bot is not answered by anyone — so its bot is always on and
// is deliberately not subject to the BOT_ENABLED env var or the packaging
// weekday schedule (lib/botschedule.ts already exempts non-packaging sites).
const ALWAYS_ON_WORKSPACES: ReadonlySet<Workspace> = new Set<Workspace>(['sports'])

export function isBotEnabledForWorkspace(ws: Workspace): boolean {
  if (ALWAYS_ON_WORKSPACES.has(ws)) return true
  const env = process.env.BOT_ENABLED
  if (env === 'true') return true
  if (env === 'false') return false
  return BOT_ENABLED_DEFAULT
}

// `siteId` decides which workspace's rule applies. Called with no argument it
// answers for packaging, which is what every pre-existing caller meant, so
// their behaviour is unchanged. An unregistered site also falls to the
// packaging rule — the conservative side, since that one is off.
export function isBotEnabled(siteId?: string): boolean {
  const ws = (siteId ? siteWorkspace(siteId) : null) ?? 'packaging'
  return isBotEnabledForWorkspace(ws)
}

// One-time acknowledgement shown to the visitor after their FIRST message of a
// conversation while the bot is disabled (never repeated on later messages).
// Rendered by the widget only — it is NOT stored in chat_logs, so it can't show
// up as a bot reply in the dashboard or pollute agent response-time stats.
export const BOT_OFF_ACK_MESSAGE = 'Thanks for your message! Our team will respond shortly.'
