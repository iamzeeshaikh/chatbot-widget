// Runs the intake spam filter over every October 2026 lead (a local snapshot,
// path in SPAM_SNAPSHOT) — junk marked by hand must be caught, real customers never.
import fs from 'node:fs'
import { isLikelySpamQuote } from '../lib/quoteintake.ts'
const rows = JSON.parse(fs.readFileSync(process.env.SPAM_SNAPSHOT!, 'utf8')) as { id: string; junk: string | null; text: string; phone: string | null }[]
let caught = 0, missed: string[] = [], falsePos: string[] = []
for (const r of rows) {
  const hit = isLikelySpamQuote(r.text, r.phone)
  const isJunk = !!r.junk && r.junk !== 'duplicate'
  if (isJunk && hit) caught++
  if (isJunk && !hit) missed.push(`${r.junk} | ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`)
  if (!r.junk && hit) falsePos.push(`${r.id} | ${r.text.replace(/\s+/g, ' ').slice(0, 140)}`)
}
console.log(`junk caught ${caught}, missed ${missed.length}, real leads wrongly caught ${falsePos.length}`)
for (const m of missed) console.log('  MISSED', m)
for (const f of falsePos) console.log('  FALSE+', f)
