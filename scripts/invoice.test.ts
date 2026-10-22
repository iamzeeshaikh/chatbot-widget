// The invoice worksheet must never offer our own office as the customer's
// shipping address. Two ways that happened on the Lilly Zelaya lead
// (californiasoccer, 2026-10-22): her iPhone replies quoted our whole email,
// signature included, and the site's address was read from the quoted part.
import assert from 'node:assert/strict'
import { addressKey, stripQuotedReply, suggestFromTimeline } from '../lib/invoice.ts'

const OURS = '1247 Wilshire Blvd, Suite 300, Los Angeles, CA 90017, USA'
const reply = `Hi Paul,\n\nThank you! I'm ready for the invoice when you are!\n\nBest,\nLilly Zelaya.\n\nEl oct 17, 2026, a la(s) 4:48 a.m., California Soccer Jerseys <info@californiasoccerjerseys.com> escribió:\n\nHi Lilly,\nPerfect, thank you!\nCalifornia Soccer Jerseys\n1247 Wilshire Blvd, Suite 300, Los Angeles, CA 90017\n`

assert.equal(stripQuotedReply(reply).includes('Wilshire'), false, 'quoted part cut (Spanish marker)')
assert.equal(stripQuotedReply('Hello\n\nOn Tue, Oct 21, 2026 at 3:09 PM Paul <p@x.com> wrote:\n> 1247 Wilshire Blvd').includes('Wilshire'), false, 'English marker')
assert.equal(stripQuotedReply('Ship to 2004 Oakridge Dr. Round Rock, TX 78681\n\nSent from my iPhone\n1247 Wilshire Blvd, Los Angeles, CA 90017').includes('Wilshire'), false, 'signature marker')
assert.equal(stripQuotedReply('Ship to 2004 Oakridge Dr. Round Rock, TX 78681').includes('Oakridge'), true, 'nothing cut without a marker')
assert.equal(addressKey(OURS), '1247wilshire')
assert.equal(addressKey('1247 Wilshire Boulevard Ste 300 LA CA'), '1247wilshire')

type Ev = Parameters<typeof suggestFromTimeline>[0][number]
const ev = (kind: string, body: string, at: string) => ({ kind, body, at, title: '' } as unknown as Ev)

// 1. Quoted signature in an inbound email: no address offered.
let s = suggestFromTimeline([ev('email_in', reply, '2026-10-19T22:25:00Z')])
assert.deepEqual(s.address, [], 'quoted office address is not a suggestion')

// 2. Our address written plainly by the customer (copied from the site): still refused when it is ours.
s = suggestFromTimeline([ev('email_in', 'Send it to 1247 Wilshire Blvd, Suite 300, Los Angeles, CA 90017 please', '2026-10-19T22:25:00Z')], { ownAddresses: [OURS] })
assert.deepEqual(s.address, [], 'own address refused')

// 3. A real customer address still comes through, and ranks newest first.
s = suggestFromTimeline([
  ev('email_in', 'Ship to 2004 Oakridge Dr. Round Rock, TX 78681', '2026-10-15T00:00:00Z'),
  ev('email_in', 'Thanks!\n\nEl oct 14 escribió:\n1247 Wilshire Blvd, Los Angeles, CA 90017', '2026-10-16T00:00:00Z'),
], { ownAddresses: [OURS] })
assert.equal(s.address.length, 1)
assert.equal(s.address[0].value, '2004 Oakridge Dr. Round Rock, TX 78681')

// 4. Amounts quoted back from our own email are not read as the customer's.
s = suggestFromTimeline([ev('email_in', 'Sounds good\n\nOn Mon wrote:\n> Total $522.50', '2026-10-16T00:00:00Z')])
assert.deepEqual(s.amount, [], 'quoted amount ignored')

console.log('invoice suggestions: 10 checks passed')
