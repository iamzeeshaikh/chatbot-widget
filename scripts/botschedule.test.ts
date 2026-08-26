// Unit test for the packaging bot schedule: the weekend window
// (Sat 10:00 → Mon 16:00 PKT) and the weekday one (Tue–Fri 11:00–16:00 PKT).
// Run: node scripts/botschedule.test.ts
//
// All boundary times are expressed in UTC and chosen to map to the PKT (UTC+5)
// moment described in each label, so we exercise the real timezone conversion.
import { isBotOffBySchedule, isScheduledOn, pktParts } from '../lib/botschedule.ts'

const PACK = 'shopcardboardboxes' // packaging workspace (scheduled)
const SPORT = 'texasfootball' // sports workspace (never affected)

// UTC instant → PKT by subtracting the +5h offset from the desired PKT wall time.
// e.g. Sat 10:00 PKT === Sat 05:00 UTC.
const utcFor = (iso: string) => new Date(iso + 'Z')

interface Case { label: string; utc: string; site: string; expectOff: boolean }
const cases: Case[] = [
  // ── Saturday boundary (PKT) ──
  { label: 'Sat 09:59 PKT (Sat 04:59 UTC) packaging → OFF', utc: '2026-06-20T04:59:00', site: PACK, expectOff: true },
  { label: 'Sat 10:00 PKT (Sat 05:00 UTC) packaging → ON', utc: '2026-06-20T05:00:00', site: PACK, expectOff: false },
  { label: 'Sat 10:01 PKT (Sat 05:01 UTC) packaging → ON', utc: '2026-06-20T05:01:00', site: PACK, expectOff: false },
  { label: 'Sat 00:00 PKT (Fri 19:00 UTC) packaging → OFF', utc: '2026-06-19T19:00:00', site: PACK, expectOff: true },
  { label: 'Sat 23:59 PKT (Sat 18:59 UTC) packaging → ON', utc: '2026-06-20T18:59:00', site: PACK, expectOff: false },
  // ── Sunday: all day ON ──
  { label: 'Sun 00:00 PKT (Sat 19:00 UTC) packaging → ON', utc: '2026-06-20T19:00:00', site: PACK, expectOff: false },
  { label: 'Sun 12:00 PKT (Sun 07:00 UTC) packaging → ON', utc: '2026-06-21T07:00:00', site: PACK, expectOff: false },
  { label: 'Sun 23:59 PKT (Sun 18:59 UTC) packaging → ON', utc: '2026-06-21T18:59:00', site: PACK, expectOff: false },
  // ── Monday: ON until 16:00 PKT, OFF from 16:00 ──
  { label: 'Mon 00:00 PKT (Sun 19:00 UTC) packaging → ON', utc: '2026-06-21T19:00:00', site: PACK, expectOff: false },
  { label: 'Mon 12:00 PKT (Mon 07:00 UTC) packaging → ON', utc: '2026-06-22T07:00:00', site: PACK, expectOff: false },
  { label: 'Mon 15:59 PKT (Mon 10:59 UTC) packaging → ON', utc: '2026-06-22T10:59:00', site: PACK, expectOff: false },
  { label: 'Mon 16:00 PKT (Mon 11:00 UTC) packaging → OFF', utc: '2026-06-22T11:00:00', site: PACK, expectOff: true },
  { label: 'Mon 23:59 PKT (Mon 18:59 UTC) packaging → OFF', utc: '2026-06-22T18:59:00', site: PACK, expectOff: true },
  { label: 'Tue 00:00 PKT (Mon 19:00 UTC) packaging → OFF', utc: '2026-06-22T19:00:00', site: PACK, expectOff: true },
  // ── Weekday window: Tue–Fri 11:00–16:00 PKT is ON, the rest of the day OFF ──
  { label: 'Tue 10:59 PKT (Tue 05:59 UTC) packaging → OFF', utc: '2026-06-16T05:59:00', site: PACK, expectOff: true },
  { label: 'Tue 11:00 PKT (Tue 06:00 UTC) packaging → ON', utc: '2026-06-16T06:00:00', site: PACK, expectOff: false },
  { label: 'Tue 15:59 PKT (Tue 10:59 UTC) packaging → ON', utc: '2026-06-16T10:59:00', site: PACK, expectOff: false },
  { label: 'Tue 16:00 PKT (Tue 11:00 UTC) packaging → OFF', utc: '2026-06-16T11:00:00', site: PACK, expectOff: true },
  { label: 'Tue 17:00 PKT (Tue 12:00 UTC) packaging → OFF', utc: '2026-06-16T12:00:00', site: PACK, expectOff: true },
  { label: 'Wed 14:00 PKT (Wed 09:00 UTC) packaging → ON', utc: '2026-06-17T09:00:00', site: PACK, expectOff: false },
  { label: 'Wed 09:00 PKT (Wed 04:00 UTC) packaging → OFF', utc: '2026-06-17T04:00:00', site: PACK, expectOff: true },
  { label: 'Thu 12:30 PKT (Thu 07:30 UTC) packaging → ON', utc: '2026-06-18T07:30:00', site: PACK, expectOff: false },
  { label: 'Fri 15:00 PKT (Fri 10:00 UTC) packaging → ON', utc: '2026-06-19T10:00:00', site: PACK, expectOff: false },
  { label: 'Fri 16:00 PKT (Fri 11:00 UTC) packaging → OFF', utc: '2026-06-19T11:00:00', site: PACK, expectOff: true },
  { label: 'Fri 23:00 PKT (Fri 18:00 UTC) packaging → OFF', utc: '2026-06-19T18:00:00', site: PACK, expectOff: true },
  { label: 'Tue 03:00 PKT (Mon 22:00 UTC) packaging → OFF', utc: '2026-06-15T22:00:00', site: PACK, expectOff: true },
  // Monday stays out of the weekday window: 16:00 hands over to the human shift.
  { label: 'Mon 16:30 PKT (Mon 11:30 UTC) packaging → OFF', utc: '2026-06-22T11:30:00', site: PACK, expectOff: true },
  // ── Sports never affected, even mid-week ──
  { label: 'Wed 14:00 PKT sports → never OFF', utc: '2026-06-17T09:00:00', site: SPORT, expectOff: false },
  { label: 'Wed 03:00 PKT sports → never OFF', utc: '2026-06-16T22:00:00', site: SPORT, expectOff: false },
  { label: 'Sat 09:59 PKT sports → never OFF', utc: '2026-06-20T04:59:00', site: SPORT, expectOff: false },
]

let failures = 0
for (const c of cases) {
  const got = isBotOffBySchedule(c.site, utcFor(c.utc))
  const p = pktParts(utcFor(c.utc))
  const pass = got === c.expectOff
  if (!pass) failures++
  console.log(`${pass ? '✓' : '✗ FAIL'} ${c.label}  [PKT day=${p.day} hour=${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}] botOff=${got}`)
}

// Sanity on the pure function (day/hour grid).
const onAssert = (day: number, hour: number, exp: boolean) => {
  const got = isScheduledOn(day, hour)
  if (got !== exp) { failures++; console.log(`✗ FAIL isScheduledOn(day=${day},hour=${hour}) => ${got} (expected ${exp})`) }
}
onAssert(6, 9, false)  // Sat 09:00 off
onAssert(6, 10, true)  // Sat 10:00 on
onAssert(0, 0, true)   // Sun 00:00 on
onAssert(0, 23, true)  // Sun 23:00 on
onAssert(1, 15, true)  // Mon 15:00 on (window tail)
onAssert(1, 16, false) // Mon 16:00 off (end hour is exclusive)
onAssert(1, 23, false) // Mon night off
onAssert(1, 16, false) // Mon 16:00 off — Monday is not in the weekday window
onAssert(2, 10, false) // Tue 10:00 off (before the weekday window)
onAssert(2, 11, true)  // Tue 11:00 on
onAssert(3, 15, true)  // Wed 15:00 on (last ON hour)
onAssert(3, 16, false) // Wed 16:00 off (end hour is exclusive)
onAssert(4, 17, false) // Thu 17:00 off
onAssert(5, 12, true)  // Fri 12:00 on
onAssert(5, 23, false) // Fri night off
onAssert(6, 9, false)  // Sat 09:00 still off — Saturday is not a weekday-window day

console.log(failures === 0 ? `\nALL ${cases.length + 18} ASSERTIONS PASS` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
