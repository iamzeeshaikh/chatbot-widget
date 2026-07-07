// Automated-traffic (bot burst) detection for visitor rows — no DDL, purely
// heuristic on data we already store. The signature we filter (seen Jul 4 2026:
// 557 "visitors" in one hour) is many sessions sharing the EXACT same
// user-agent string in a short window. Real devices with the same popular UA
// exist, but on this traffic level (~150 genuine visitors/day) dozens of
// identical-UA sessions per hour — or several live at once — never happen
// organically.
//
// Two thresholds for the two data shapes:
//  • Historical (analytics chart): > UA_BURST_PER_HOUR sessions with the same
//    UA inside one clock hour → the whole UA-hour group is bot traffic.
//  • Live (visitor list / dashboard alerts): > UA_FLOOD_CONCURRENT sessions
//    with the same UA live at the same moment → the group is hidden so the
//    dashboard doesn't ring or show hundreds of fake visitors.

export const UA_BURST_PER_HOUR = 30
export const UA_FLOOD_CONCURRENT = 8

const HOUR_MS = 60 * 60 * 1000

// Historical rows → the set of `${ua}|${hourIndex}` keys that are bursts.
// `tsMs` must be the row's timestamp in ms (any consistent epoch/offset).
export function burstKey(userAgent: string | null | undefined, tsMs: number): string {
  return `${userAgent ?? ''}|${Math.floor(tsMs / HOUR_MS)}`
}

export function findBurstKeys(rows: { userAgent: string | null | undefined; tsMs: number }[]): Set<string> {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const k = burstKey(r.userAgent, r.tsMs)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const bursts = new Set<string>()
  for (const [k, n] of counts) if (n > UA_BURST_PER_HOUR) bursts.add(k)
  return bursts
}

// Live rows → drop every visitor whose exact UA has more than
// UA_FLOOD_CONCURRENT sessions live right now.
export function filterLiveFlood<T extends { user_agent?: string | null }>(visitors: T[]): T[] {
  const counts = new Map<string, number>()
  for (const v of visitors) {
    const ua = v.user_agent ?? ''
    counts.set(ua, (counts.get(ua) ?? 0) + 1)
  }
  return visitors.filter((v) => (counts.get(v.user_agent ?? '') ?? 0) <= UA_FLOOD_CONCURRENT)
}
