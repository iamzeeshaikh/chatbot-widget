// Customer CCs kept on our replies (owner, 2026-10-22 — Dylan's Candy Bar).
import assert from 'node:assert/strict'
import { customerCc } from '../lib/customercc.ts'

const fwd = `---------- Forwarded message ---------\nFrom: Shayna Emmett <semmett@dylanscandybar.com>\nDate: Tue, 20 Oct 2026 at 10:43 PM\nSubject: Easter Candy Favor Box\nTo: info@shopcardboardboxes.com <info@shopcardboardboxes.com>\nCc: Lauren Kusha <lkusha@dylanscandybar.com>, Arleny Martin <\namartin@dylanscandybar.com>\n\nGood Afternoon,`
assert.deepEqual(customerCc({ customer: 'semmett@dylanscandybar.com', leadText: fwd }), ['lkusha@dylanscandybar.com', 'amartin@dylanscandybar.com'], 'forwarded Cc with a wrapped line')
const flat = 'From: Shayna Emmett <semmett@dylanscandybar.com> Date: Tue To: info@shopcardboardboxes.com <info@shopcardboardboxes.com> Cc: Lauren Kusha <lkusha@dylanscandybar.com>, Arleny Martin < amartin@dylanscandybar.com> Good Afternoon'
assert.deepEqual(customerCc({ customer: 'semmett@dylanscandybar.com', leadText: flat }), ['lkusha@dylanscandybar.com', 'amartin@dylanscandybar.com'], 'flattened header')
assert.deepEqual(customerCc({ customer: 'a@x.com', leadText: 'Cc: steve@shopcardboardboxes.com, b@x.com, a@x.com' }), ['b@x.com'], 'ours and the customer dropped')
assert.deepEqual(customerCc({ customer: 'a@x.com', inboundCc: ['Bob <bob@x.com>', 'bob@x.com, info@thepapercups.com'] }), ['bob@x.com'], 'inbound Cc, deduped, ours dropped')
assert.deepEqual(customerCc({ customer: 'a@x.com', leadText: 'Name: A\nEmail: a@x.com\nMessage: please cc my partner' }), [], 'no Cc line → nobody')
console.log('customer cc: 5 checks passed')
