// Scheduled bot on/off for the PACKAGING workspace only. The sports bot is
// always-on and never consulted here.
//
// Schedule (Pakistan Standard Time, PKT = UTC+5, no daylight saving):
//   • Bot ON:  one continuous weekend window — Saturday 10:00 AM PKT through the
//              end of Sunday (i.e. up to, but not including, Monday 00:00).
//   • Bot OFF (human-only): everything else — all of Mon–Fri, plus Saturday
//              00:00–10:00.
//
// During bot-OFF the bot stays completely silent (no reply/ack); a human agent
// initiates. Manual human takeover always wins, and the bot auto-resumes when
// the ON window opens (the schedule never persists any mode).
//
// ── Edit these constants to change the schedule ──────────────────────────────
import { siteWorkspace, type Workspace } from './workspaces'

// Only this workspace follows the schedule. Others (sports) are always-on.
export const SCHEDULED_WORKSPACE: Workspace = 'packaging'

// PKT has a fixed +5h offset from UTC, no DST.
export const PKT_OFFSET_HOURS = 5

// Days of week: 0 = Sunday … 6 = Saturday.
// The ON window starts on this day at the hour below…
export const BOT_ON_START_DAY = 6 // Saturday
export const BOT_ON_START_HOUR = 10 // 10:00 AM PKT (start hour is inclusive)
// …and these days are bot-ON for the full 24h (the rest of the weekend window).
export const BOT_ON_FULL_DAYS = [0] // Sunday (00:00–23:59)
// ─────────────────────────────────────────────────────────────────────────────

// Current PKT day-of-week (0=Sun..6=Sat) and hour/minute, computed from UTC so
// it's correct no matter what timezone the server runs in.
export function pktParts(now: Date = new Date()): { day: number; hour: number; minute: number } {
  const shifted = new Date(now.getTime() + PKT_OFFSET_HOURS * 60 * 60 * 1000)
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
}

// Pure schedule check (no workspace gating): is the bot ON at this PKT
// day/hour? ON = a full-on day (Sunday), or Saturday from 10:00 onward.
export function isScheduledOn(day: number, hour: number): boolean {
  if (BOT_ON_FULL_DAYS.includes(day)) return true
  if (day === BOT_ON_START_DAY && hour >= BOT_ON_START_HOUR) return true
  return false
}

// Is the bot currently OFF (human-only) for this site because of the schedule?
// Returns false for any non-scheduled workspace (e.g. sports) — they're never
// affected. This does NOT consider manual human takeover; the caller combines
// the two (manual human always wins).
export function isBotOffBySchedule(siteId: string, now: Date = new Date()): boolean {
  if (siteWorkspace(siteId) !== SCHEDULED_WORKSPACE) return false
  const { day, hour } = pktParts(now)
  return !isScheduledOn(day, hour)
}
