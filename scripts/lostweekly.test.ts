// Weekly Lost report — who gets what, against the real module with a fixed
// clock. Run: npm run test:lostweekly
import assert from 'node:assert/strict'
import { summarizeLost, planLostWeekly, splitLine, type LostWeeklyRow, type LostWeeklyAgent } from '../lib/lostweekly.ts'

const now = new Date('2026-11-16T05:00:00Z') // Monday 10:00 PKT
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
const agents: LostWeeklyAgent[] = [
  { email: 'samir@x.com', name: 'Samir Khan', role: 'standard' },
  { email: 'steve@x.com', name: 'Steve Hayes', role: 'standard' },
  { email: 'mark@x.com', name: 'Mark Taylor', role: 'standard' },
  { email: 'boss@x.com', name: 'Boss', role: 'admin' },
]
const row = (id: string, o: Partial<LostWeeklyRow>): LostWeeklyRow => ({ id, siteId: 's1', owner: null, lostAt: null, lostBy: null, reason: null, ...o })
const rows: LostWeeklyRow[] = [
  row('a', { owner: 'samir@x.com', lostBy: 'Samir@x.com', lostAt: ago(1), reason: 'price' }),
  row('b', { owner: 'samir@x.com', lostBy: 'samir@x.com', lostAt: ago(2), reason: null }),
  row('c', { owner: 'samir@x.com', lostBy: 'samir@x.com', lostAt: ago(30), reason: null }), // old, no reason
  row('d', { owner: 'steve@x.com', lostBy: 'steve@x.com', lostAt: ago(9), reason: 'size' }), // outside the week, has reason
  row('e', { owner: null, lostBy: 'zeeops-bot', lostAt: ago(3), reason: null }),            // bot, unassigned
  row('f', { owner: 'mark@x.com', lostBy: 'samir@x.com', lostAt: ago(6), reason: 'no_reply' }),
]
const sum = summarizeLost(rows, agents, now)
const samir = sum.perAgent.find((s) => s.email === 'samir@x.com')!
assert.equal(samir.weekTotal, 3)
assert.deepEqual(samir.week, { price: 1, none: 1, no_reply: 1 })
assert.equal(samir.ownedNoReason, 2)
assert.deepEqual(samir.taskLead, { id: 'b', siteId: 's1' }, 'task hangs on the NEWEST reason-less lead')
assert.ok(!sum.perAgent.some((s) => s.email === 'steve@x.com'), 'nothing this week, no reason-less leads: no message')
assert.ok(!sum.perAgent.some((s) => s.email === 'mark@x.com'), 'owns only a lead with a reason')
assert.deepEqual(sum.others, { 'zeeops-bot': { none: 1 } })
assert.equal(sum.totals.weekTotal, 4)
assert.equal(sum.totals.noReason, 3)
assert.equal(sum.totals.unassignedNoReason, 1)
assert.equal(splitLine({ none: 2, price: 1 }), 'Price too high 1, no reason 2')

const plan = planLostWeekly(sum, agents, '2026-11-16', 'https://chat.zeeops.dev')
assert.deepEqual(plan.map((m) => m.key), ['lostweekly:2026-11-16:samir@x.com', 'lostweekly:2026-11-16:admin:boss@x.com'])
assert.match(plan[0].title, /^Samir, /)
assert.match(plan[0].body, /moved 3 leads to Lost in the last 7 days: Price too high 1, Stopped replying 1, no reason 1\./)
assert.match(plan[0].body, /2 of your Lost leads still have no reason/)
assert.match(plan[0].body, /https:\/\/chat\.zeeops\.dev\/lost/)
assert.match(plan[1].body, /Samir: 3 lost/)
assert.match(plan[1].body, /zeeops-bot: 1 lost \(no reason 1\)/)
assert.equal(planLostWeekly(summarizeLost([], agents, now), agents, 'k', '').length, 0, 'nothing lost, nothing sent')
console.log('lostweekly: all assertions passed')
