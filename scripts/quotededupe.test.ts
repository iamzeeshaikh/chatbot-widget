// The forwarded-copy duplicate.
//
// The same web form reaches us twice: once submitted straight to the site, and
// once forwarded by hand into the intake mailbox. In the first, the mail's
// subject is repeated as the opening line of the body; in the second it is a
// "Subject:" header that gets stripped. That one line made the two normalise to
// different text with neither a prefix of the other, and the duplicate check
// missed it — Nash Crawley became three leads and Max D two.
import assert from 'node:assert/strict'
import { normalizeQuoteBody, isSameQuoteBody } from '../lib/quoteintake.ts'

const DIRECT = `[Custom Quote] [Contact Form] Nash Crawley
⚽ California Soccer Jerseys
New contact submission from your website
Name Nash Crawley
Email nashcrawley@gmail.com
Phone 8067890284
Team Name Tumbleweeds
Product Kids Soccer Jerseys
Quantity 1-10 jerseys
Source Page https://www.californiasoccerjerseys.com/products/kids-soccer-jerseys.html`

const FORWARDED = `[Custom Quote] ---------- Forwarded message ---------
From: California Soccer Jerseys <noreply@www.californiasoccerjerseys.com>
Date: Thu, Aug 27, 2026 at 9:06 PM
Subject: [Contact Form] Nash Crawley
To: <shanzeeshan571@gmail.com>

⚽ California Soccer Jerseys
New contact submission from your website
Name Nash Crawley
Email nashcrawley@gmail.com
Phone 8067890284
Team Name Tumbleweeds
Product Kids Soccer Jerseys
Quantity 1-10 jerseys
Source Page https://www.californiasoccerjerseys.com/products/kids-soccer-jerseys.html`

const a = normalizeQuoteBody(DIRECT)
const b = normalizeQuoteBody(FORWARDED)
assert.equal(a, b, 'the echoed subject line must not make the two differ')
assert.ok(isSameQuoteBody(a, b), 'the forwarded copy is the same enquiry')

// A copy with a footer appended is still the same enquiry (the original rule).
assert.ok(isSameQuoteBody(a, a + ' sent from my iphone'), 'appended text still matches')
// And one with a line removed from the front, which is what a stripped
// forwarded header looks like.
assert.ok(isSameQuoteBody(a, 'urgent please read ' + a), 'prepended text still matches')

// Two genuinely different enquiries from the same customer must NOT merge.
const OTHER = normalizeQuoteBody(`[Custom Quote] [Contact Form] Nash Crawley
⚽ California Soccer Jerseys
New contact submission from your website
Name Nash Crawley
Email nashcrawley@gmail.com
Phone 8067890284
Team Name Tumbleweeds
Product Adult Goalkeeper Jerseys
Quantity 50-100 jerseys
Source Page https://www.californiasoccerjerseys.com/products/soccer-goalkeeper-jerseys.html`)
assert.ok(!isSameQuoteBody(a, OTHER), 'a different product and quantity is a different enquiry')

// A bracketed line that is NOT the first content line belongs to the customer
// and must survive normalising.
const KEEP = normalizeQuoteBody('[Custom Quote] Name Bob\n[URGENT] need these by Friday')
assert.ok(KEEP.includes('[urgent]'), 'only the first line can be an echoed subject')

console.log('quote dedupe: forwarded copies match, different enquiries do not')
