// Opportunities alerts — the time windows and the dedupe, against the real
// module with a fake clock and a fake ledger. Run: npm run test:oppalerts
import assert from 'node:assert/strict'
import {
  WAIT_PER_RUN, planAlerts, inQuiet, isLastDayOfMonth, morningKey, waitingKey, monthendKey, morningCopy, monthendCopy,
  type AlertInput, type Plan,
} from '../lib/oppalerts.ts'

// PKT = UTC+5. "2026-10-21 10:05 PKT" is 05:05 UTC.
const pkt = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:00`)

const agents: AlertInput['agents'] = [
  { email: 'samirkhan@shopcardboardboxes.com', key: 'samirkhan', name: 'Samir Khan', role: 'standard' },
  { email: 'stevehayes@shopcardboardboxes.com', key: 'stevehayes', name: 'Steve Hayes', role: 'standard' },
  { email: 'dev@zeecustomboxes.com', key: 'dev', name: 'Shop Cardboard Boxes', role: 'admin' },
]
const base = (now: Date, sent: string[] = [], extra: Partial<AlertInput> = {}): AlertInput => ({
  now, agents, sent: new Set(sent),
  counts: new Map([['samirkhan', { waiting: 16, hot: 1, invoices: 0 }], ['stevehayes', { waiting: 0, hot: 0, invoices: 0 }], ['', { waiting: 10, hot: 0, invoices: 0 }]]),
  waiting: [
    { id: 'quote-1', name: 'Carly Blake', owner: 'stevehayes', hours: 2.2, since: '2026-10-21T02:00:00.000Z' },
    { id: 'quote-2', name: 'Jo Kealoha', owner: 'samirkhan', hours: 1.5, since: '2026-10-21T03:00:00.000Z' },
    { id: 'quote-3', name: 'Mira Chahine', owner: null, hours: 30, since: '2026-10-19T20:00:00.000Z' },
  ],
  monthLabel: 'October 2026',
  leaderboard: [{ key: 'stevehayes', name: 'Steve Hayes', wonCount: 7, wonUsd: 7132 }, { key: 'samirkhan', name: 'Samir Khan', wonCount: 3, wonUsd: 1995 }, { key: 'dannydiaz', name: 'Danny Diaz', wonCount: 0, wonUsd: 0 }],
  ...extra,
})
const kinds = (plans: Plan[]) => plans.map((p) => `${p.kind}→${p.to.split('@')[0]}`).sort()
let n = 0
const ok = (label: string, fn: () => void) => { fn(); n++; console.log('  ok', label) }

// ── quiet hours ──
ok('04:00 PKT is quiet, 12:00 is not, 03:59 is not, 11:59 is; 23:00 is working time', () => {
  assert.equal(inQuiet(pkt('2026-10-21', '04:00')), true)
  assert.equal(inQuiet(pkt('2026-10-21', '12:00')), false)
  assert.equal(inQuiet(pkt('2026-10-21', '03:59')), false)
  assert.equal(inQuiet(pkt('2026-10-21', '11:59')), true)
  assert.equal(inQuiet(pkt('2026-10-21', '23:00')), false)
})

// ── daily (evening) summary — kind 'morning' for the ledger keys ──
ok('19:55 PKT: no summary yet; waiting nudges still fire', () => {
  const { plans } = planAlerts(base(pkt('2026-10-21', '19:55')))
  assert.deepEqual(kinds(plans), ['waiting→stevehayes', 'waiting24→dev'].sort())
})
ok('20:05 PKT: one summary per agent with anything + admin totals; Steve gets only the unassigned line', () => {
  const { plans } = planAlerts(base(pkt('2026-10-21', '20:05')))
  assert.deepEqual(kinds(plans), ['morning→dev', 'morning→samirkhan', 'morning→stevehayes', 'waiting→stevehayes', 'waiting24→dev'].sort())
  const samir = plans.find((p) => p.kind === 'morning' && p.to.startsWith('samir'))!
  assert.equal(samir.body, 'Good evening Samir. 16 customers are waiting for your reply, 1 quote can close this month. 10 unassigned customers are waiting for a reply — accept one.')
  assert.equal(samir.url, '/opportunities?agent=samirkhan&list=waiting')
  const steve = plans.find((p) => p.kind === 'morning' && p.to.startsWith('steve'))!
  assert.equal(steve.body, '10 unassigned customers are waiting for a reply — accept one.')
  assert.equal(steve.url, '/opportunities?agent=&list=waiting')
  const dev = plans.find((p) => p.kind === 'morning' && p.to.startsWith('dev'))!
  assert.equal(dev.body, 'Good evening. Across the team: 26 customers waiting for a reply (10 unassigned), 1 quote that can close this month.')
})
ok('zero parts are omitted; nothing at all → no summary', () => {
  assert.equal(morningCopy('Steve Hayes', { waiting: 0, hot: 2, invoices: 1 }), 'Good evening Steve. 2 quotes can close this month, 1 invoice is due.')
  assert.equal(morningCopy('Steve Hayes', { waiting: 0, hot: 0, invoices: 0 }), null)
})
ok('the summary fires once a day: ledger key blocks the 20:10 and 23:00 runs, a new day fires again', () => {
  const first = planAlerts(base(pkt('2026-10-21', '20:05'))).plans.filter((p) => p.kind === 'morning')
  const sent = first.map((p) => p.key)
  assert.equal(planAlerts(base(pkt('2026-10-21', '20:10'), sent)).plans.filter((p) => p.kind === 'morning').length, 0)
  assert.equal(planAlerts(base(pkt('2026-10-21', '23:00'), sent)).plans.filter((p) => p.kind === 'morning').length, 0)
  assert.equal(planAlerts(base(pkt('2026-10-22', '20:02'), sent)).plans.filter((p) => p.kind === 'morning').length, 3)
  assert.equal(morningKey('Samir@X.com', pkt('2026-10-21', '20:05')), 'morning:samir@x.com:2026-10-21')
})

// ── waiting nudges ──
ok('2 h nudge goes to the assigned agent, by name, once per episode', () => {
  const { plans } = planAlerts(base(pkt('2026-10-21', '12:00')))
  const w = plans.find((p) => p.kind === 'waiting')!
  assert.equal(w.to, 'stevehayes@shopcardboardboxes.com')
  assert.equal(w.body, 'Steve, Carly Blake has been waiting 2 h for a reply.')
  assert.equal(w.url, '/leads/quote-1')
  assert.equal(w.key, waitingKey('quote-1', '2026-10-21T02:00:00.000Z', 'waiting'))
  const again = planAlerts(base(pkt('2026-10-21', '14:00'), [w.key]))
  assert.equal(again.plans.filter((p) => p.kind === 'waiting').length, 0)
})
ok('under 2 h → nothing; unassigned → no 2 h nudge; 24 h → admins, once', () => {
  const { plans } = planAlerts(base(pkt('2026-10-21', '12:00')))
  assert.equal(plans.some((p) => p.kind === 'waiting' && p.url === '/leads/quote-2'), false)
  const esc = plans.filter((p) => p.kind === 'waiting24')
  assert.equal(esc.length, 1)
  assert.equal(esc[0].to, 'dev@zeecustomboxes.com')
  assert.equal(esc[0].body, 'Mira Chahine has had no reply for 30 h and nobody has taken the lead.')
  // The escalation key is per admin; sending once blocks the next run.
  const again = planAlerts(base(pkt('2026-10-21', '13:00'), esc.map((p) => p.key)))
  assert.equal(again.plans.filter((p) => p.kind === 'waiting24').length, 0)
})
ok('a new unanswered message from the same lead is a new episode', () => {
  const k1 = waitingKey('quote-1', '2026-10-21T02:00:00.000Z', 'waiting')
  const later = base(pkt('2026-10-23', '12:00'), [k1], { waiting: [{ id: 'quote-1', name: 'Carly Blake', owner: 'stevehayes', hours: 3, since: '2026-10-23T04:00:00.000Z' }] })
  assert.equal(planAlerts(later).plans.filter((p) => p.kind === 'waiting').length, 1)
})
ok('quiet hours hold everything and nothing is lost: it fires at 12:00', () => {
  const night = planAlerts(base(pkt('2026-10-22', '05:30')))
  assert.equal(night.plans.length, 0)
  assert.ok(night.held.some((h) => h.kind === 'waiting'))
  const noon = planAlerts(base(pkt('2026-10-22', '12:01')))
  assert.deepEqual(kinds(noon.plans), ['waiting→stevehayes', 'waiting24→dev'].sort())
})

// ── month end ──
ok('last day of the month is read in Karachi time', () => {
  assert.equal(isLastDayOfMonth(pkt('2026-10-31', '12:00')), true)
  assert.equal(isLastDayOfMonth(pkt('2026-10-30', '23:30')), false)
  assert.equal(isLastDayOfMonth(new Date('2026-10-31T19:30:00Z')), false) // already 1 Nov in Karachi
})
ok('leaderboard goes to everyone at 18:00 on the last day, once; not at 17:59', () => {
  assert.equal(planAlerts(base(pkt('2026-10-31', '17:59'))).plans.filter((p) => p.kind === 'monthend').length, 0)
  const { plans } = planAlerts(base(pkt('2026-10-31', '18:00')))
  const me = plans.filter((p) => p.kind === 'monthend')
  assert.equal(me.length, 3)
  assert.equal(me[0].body, 'October 2026: Steve 7 won ($7,132) · Samir 3 won ($1,995)')
  assert.equal(planAlerts(base(pkt('2026-10-31', '18:10'), me.map((p) => p.key))).plans.filter((p) => p.kind === 'monthend').length, 0)
  assert.equal(monthendKey('a@b.c', pkt('2026-10-31', '18:00')), 'monthend:a@b.c:2026-10')
  assert.equal(monthendCopy('May 2026', []), 'May 2026: no sales were booked this month.')
})

ok('a wait older than 3 days is backlog: no nudge, no escalation', () => {
  const old = base(pkt('2026-10-21', '12:00'), [], { waiting: [{ id: 'quote-9', name: 'Old One', owner: 'stevehayes', hours: 13 * 24, since: '2026-10-08T00:00:00.000Z' }] })
  const { plans } = planAlerts(old)
  assert.equal(plans.filter((p) => p.kind === 'waiting' || p.kind === 'waiting24').length, 0)
})
ok(`at most ${WAIT_PER_RUN} nudges per recipient per run, freshest first; the rest are held for the next run`, () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, name: `Customer ${i}`, owner: 'stevehayes', hours: 3 + i, since: `2026-10-21T0${i}:00:00.000Z` }))
  const { plans, held } = planAlerts(base(pkt('2026-10-21', '12:00'), [], { waiting: many }))
  const mine = plans.filter((p) => p.kind === 'waiting')
  assert.equal(mine.length, WAIT_PER_RUN)
  assert.equal(mine[0].url, '/leads/q0')
  assert.equal(held.filter((h) => h.kind === 'waiting' && h.why.includes('cap')).length, 8 - WAIT_PER_RUN)
  // Sending those unlocks the next batch on the following run.
  const next = planAlerts(base(pkt('2026-10-21', '12:05'), mine.map((p) => p.key), { waiting: many }))
  assert.equal(next.plans.filter((p) => p.kind === 'waiting').length, 8 - WAIT_PER_RUN)
})

console.log(`\n${n} checks passed`)
