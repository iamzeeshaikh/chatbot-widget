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

export const BOT_ENABLED_DEFAULT = false

export function isBotEnabled(): boolean {
  const env = process.env.BOT_ENABLED
  if (env === 'true') return true
  if (env === 'false') return false
  return BOT_ENABLED_DEFAULT
}

// One-time acknowledgement shown to the visitor after their FIRST message of a
// conversation while the bot is disabled (never repeated on later messages).
// Rendered by the widget only — it is NOT stored in chat_logs, so it can't show
// up as a bot reply in the dashboard or pollute agent response-time stats.
export const BOT_OFF_ACK_MESSAGE = 'Thanks for your message! Our team will respond shortly.'
