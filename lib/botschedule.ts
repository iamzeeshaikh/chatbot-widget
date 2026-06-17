// Scheduled bot on/off for the PACKAGING workspace only. The sports bot is
// always-on and never consulted here.
//
// Schedule (Pakistan Standard Time, PKT = UTC+5, no daylight saving):
//   • Mon–Fri: bot ON 10:00–18:00 PKT; OFF (human-only) otherwise.
//   • Sat & Sun: bot ON 24 hours.
//
// ── Edit these constants to change the schedule ──────────────────────────────
import { siteWorkspace, type Workspace } from './workspaces'

// Only this workspace follows the schedule. Others (sports) are always-on.
export const SCHEDULED_WORKSPACE: Workspace = 'packaging'

// PKT has a fixed +5h offset from UTC, no DST.
export const PKT_OFFSET_HOURS = 5

// Weekday (Mon–Fri) bot-ON window in PKT, 24h clock. Outside this window the
// bot is OFF (human-only). End hour is exclusive (18 = until 18:00 sharp).
export const WEEKDAY_BOT_ON_START_HOUR = 10 // 10:00 AM PKT
export const WEEKDAY_BOT_ON_END_HOUR = 18 // 6:00 PM PKT

// Days that are bot-ON for the full 24h regardless of hour. 0 = Sunday … 6 = Saturday.
export const ALWAYS_ON_DAYS = [0, 6] // Sunday, Saturday
// ─────────────────────────────────────────────────────────────────────────────

// Current PKT day-of-week (0=Sun..6=Sat) and hour/minute, computed from UTC so
// it's correct no matter what timezone the server runs in.
export function pktParts(now: Date = new Date()): { day: number; hour: number; minute: number } {
  const shifted = new Date(now.getTime() + PKT_OFFSET_HOURS * 60 * 60 * 1000)
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
}

// Is the bot currently OFF (human-only) for this site because of the schedule?
// Returns false for any non-scheduled workspace (e.g. sports) — they're never
// affected. This does NOT consider manual human takeover; the caller combines
// the two (manual human always wins).
export function isBotOffBySchedule(siteId: string, now: Date = new Date()): boolean {
  if (siteWorkspace(siteId) !== SCHEDULED_WORKSPACE) return false
  const { day, hour } = pktParts(now)
  if (ALWAYS_ON_DAYS.includes(day)) return false // weekends: on all day
  const within = hour >= WEEKDAY_BOT_ON_START_HOUR && hour < WEEKDAY_BOT_ON_END_HOUR
  return !within // weekday outside the window → off
}
