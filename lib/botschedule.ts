// Scheduled bot on/off for the PACKAGING workspace only. The sports bot is
// always-on and never consulted here.
//
// Schedule (Pakistan Standard Time, PKT = UTC+5, no daylight saving). Two
// windows, and the bot is ON inside either of them:
//   • Weekend window: Saturday 10:00 AM PKT through Monday 7:00 PM PKT — one
//              continuous stretch (Sunday is on for its full 24h; Monday is on
//              up to, but not including, 19:00).
//   • Weekday window: Tuesday–Friday, 6:00 AM to 7:00 PM PKT (19:00 exclusive,
//              so the last bot-ON minute is 18:59). These are the hours with no
//              human agent on shift; the rest of the weekday is human-only.
//   • Bot OFF (human-only): everything else — Monday from 7:00 PM, Tue–Fri
//              outside 06:00–19:00, and Saturday 00:00–10:00.
//
// Widened on 2026-08-29 at the owner's request: the weekday window was
// 11:00–16:00 and Monday ended at 16:00. Saturday's 10:00 start is deliberately
// unchanged — the weekend was already covered and was not part of the ask.
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
// …and these days are bot-ON for the full 24h (the middle of the window).
export const BOT_ON_FULL_DAYS = [0] // Sunday (00:00–23:59)
// …and the window closes on this day at this hour (end hour is EXCLUSIVE, so 16
// means the last bot-ON minute is 15:59 and 16:00 is human-only). Set
// BOT_ON_END_DAY to -1 to end the window at the close of the last full day.
export const BOT_ON_END_DAY = 1 // Monday
export const BOT_ON_END_HOUR = 19 // 7:00 PM PKT

// The weekday window (added 2026-08-26). Separate from the weekend one above
// because it repeats daily instead of running continuously across days: these
// are the hours on Tue–Fri when nobody is on shift, so a visitor who isn't
// answered by the bot isn't answered at all. Outside it the weekday stays
// human-only exactly as before.
// Monday is deliberately NOT in this list — it is already bot-ON until 19:00 as
// the tail of the weekend window, and 19:00 is where its human shift starts.
export const WEEKDAY_BOT_DAYS = [2, 3, 4, 5] // Tuesday, Wednesday, Thursday, Friday
export const WEEKDAY_BOT_START_HOUR = 6 // 6:00 AM PKT (inclusive)
export const WEEKDAY_BOT_END_HOUR = 19 // 7:00 PM PKT (EXCLUSIVE — last ON minute is 18:59)
// ─────────────────────────────────────────────────────────────────────────────

// Current PKT day-of-week (0=Sun..6=Sat) and hour/minute, computed from UTC so
// it's correct no matter what timezone the server runs in.
export function pktParts(now: Date = new Date()): { day: number; hour: number; minute: number } {
  const shifted = new Date(now.getTime() + PKT_OFFSET_HOURS * 60 * 60 * 1000)
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() }
}

// Pure schedule check (no workspace gating): is the bot ON at this PKT
// day/hour? ON = a full-on day (Sunday), Saturday from 10:00 onward, Monday
// before 19:00 — the tail of the same window, not a second one — or a weekday
// inside the daily unattended-hours window.
export function isScheduledOn(day: number, hour: number): boolean {
  if (BOT_ON_FULL_DAYS.includes(day)) return true
  if (day === BOT_ON_START_DAY && hour >= BOT_ON_START_HOUR) return true
  if (day === BOT_ON_END_DAY && hour < BOT_ON_END_HOUR) return true
  if (WEEKDAY_BOT_DAYS.includes(day) && hour >= WEEKDAY_BOT_START_HOUR && hour < WEEKDAY_BOT_END_HOUR) return true
  return false
}

// Is the bot currently OFF (human-only) for this WORKSPACE because of the
// schedule? Returns false for any non-scheduled workspace (e.g. sports) —
// they're never affected. Used where there is no single site in hand, e.g. the
// dashboard's workspace-wide "Bot on/off" chip.
export function isBotOffByScheduleForWorkspace(ws: Workspace | null, now: Date = new Date()): boolean {
  if (ws !== SCHEDULED_WORKSPACE) return false
  const { day, hour } = pktParts(now)
  return !isScheduledOn(day, hour)
}

// Is the bot currently OFF (human-only) for this site because of the schedule?
// Returns false for any non-scheduled workspace (e.g. sports) — they're never
// affected. This does NOT consider manual human takeover; the caller combines
// the two (manual human always wins).
export function isBotOffBySchedule(siteId: string, now: Date = new Date()): boolean {
  return isBotOffByScheduleForWorkspace(siteWorkspace(siteId), now)
}
