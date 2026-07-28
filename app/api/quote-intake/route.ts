import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { QUOTE_TAG, CHECKOUT_TAG, siteIdFromQuoteCode, isLikelySpamQuote, isCheckoutOrder, checkoutOrderNumber, normalizeQuoteBody } from '@/lib/quoteintake'

export const dynamic = 'force-dynamic'

// Ingest a custom-quote lead pushed by the Google Apps Script Gmail watcher
// (scripts/quote-intake-apps-script.gs) — the Script does all the reading of
// the user's own Gmail; this endpoint never touches Gmail itself, it only
// accepts already-parsed fields over a shared secret. Never used by the
// widget or any browser — server-to-server only.
export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-quote-secret')
  if (!secret || secret !== process.env.QUOTE_INTAKE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { siteCode, name, email, phone, product, message, receivedAt } = body
  const siteId = typeof siteCode === 'string' ? siteIdFromQuoteCode(siteCode) : null
  if (!siteId) return NextResponse.json({ error: `Unknown siteCode: ${siteCode}` }, { status: 400 })

  const cleanEmail = typeof email === 'string' ? email.trim() : ''
  const cleanPhone = typeof phone === 'string' ? phone.trim() : ''
  if (!cleanEmail && !cleanPhone) {
    return NextResponse.json({ error: 'email or phone required' }, { status: 400 })
  }

  const bodyText = typeof message === 'string' ? message.trim() : ''
  const createdAt = typeof receivedAt === 'string' && !isNaN(new Date(receivedAt).getTime())
    ? receivedAt : new Date().toISOString()

  // Bot spam hits these WordPress quote-forms directly (crypto/loan/casino
  // promo content) and still carries a real site label since the visitor
  // labels the whole notification thread, not each individual message.
  // Silently accept without inserting — the Script already labeled it
  // Processed, so it won't retry.
  if (isLikelySpamQuote(bodyText, cleanPhone)) {
    return NextResponse.json({ success: true, spam: true })
  }

  // Idempotency safety net: a lead can also be manually forwarded into its
  // label days or weeks after the original submission (or the Script can
  // re-run on the same message), landing the exact same content twice under
  // different-looking metadata. Compare the customer-typed text itself
  // (stripped of forward headers/footer, case-folded) against every prior
  // submission from this email on this site — not just a recent time window,
  // since a genuine second inquiry always has different wording, but a
  // forward-duplicate never does regardless of the gap. Compared
  // case-insensitively — the same person's email can arrive differently
  // capitalized across a forward vs. the original submission.
  // A cart checkout is still a lead worth recording, it just isn't one the
  // buying partner sourced — so it gets its own tag and, through that, stays
  // out of the Billing tab while still counting everywhere else.
  const tag = isCheckoutOrder(bodyText) ? CHECKOUT_TAG : QUOTE_TAG

  // Checkout orders dedupe on the order number, not the body text — see
  // checkoutOrderNumber for why the text comparison can't catch a forwarded
  // copy of the same order.
  const orderNo = tag === CHECKOUT_TAG ? checkoutOrderNumber(bodyText) : null
  if (orderNo) {
    const { data: sameOrder } = await supabase
      .from('leads')
      .select('id')
      .eq('site_id', siteId)
      .ilike('message', `${CHECKOUT_TAG}%`)
      .ilike('message', `%#${orderNo}%`)
      .limit(1)
    if (sameOrder && sameOrder.length > 0) {
      return NextResponse.json({ success: true, deduped: true })
    }
  }

  if (cleanEmail) {
    const normalized = normalizeQuoteBody(`${tag}${bodyText}`)
    const { data: candidates } = await supabase
      .from('leads')
      .select('id, message')
      .eq('site_id', siteId)
      .ilike('email', cleanEmail)
      .ilike('message', `${tag}%`)
    const isDupe = (candidates ?? []).some((c) => normalizeQuoteBody(c.message ?? '') === normalized)
    if (isDupe) {
      return NextResponse.json({ success: true, deduped: true })
    }
  }

  const { error } = await supabase.from('leads').insert([{
    site_id: siteId,
    name: typeof name === 'string' ? name.trim() || null : null,
    email: cleanEmail || null,
    phone: cleanPhone || null,
    message: `${tag}${bodyText}`,
    product: typeof product === 'string' ? product.trim() || null : null,
    created_at: createdAt,
  }])

  if (error) {
    console.error('[quote-intake] insert failed:', error.message)
    return NextResponse.json({ error: 'Insert failed' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
