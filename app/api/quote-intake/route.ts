import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { QUOTE_TAG, siteIdFromQuoteCode } from '@/lib/quoteintake'

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

  // Idempotency safety net: the Script already avoids reprocessing a message
  // (it labels each email after a successful POST), but if it ever re-runs on
  // the same message (e.g. a retry), don't double-count it for billing —
  // skip if an identical quote lead already landed for this site+email within
  // a day of THIS lead's own timestamp (not wall-clock "now" — a backlog
  // sweep can post months of history within minutes of real time, so
  // anchoring to "now" would never catch old duplicates).
  if (cleanEmail) {
    const anchor = new Date(createdAt).getTime()
    const sinceIso = new Date(anchor - 24 * 60 * 60 * 1000).toISOString()
    const untilIso = new Date(anchor + 24 * 60 * 60 * 1000).toISOString()
    const { data: dupe } = await supabase
      .from('leads')
      .select('id')
      .eq('site_id', siteId)
      .eq('email', cleanEmail)
      .gte('created_at', sinceIso)
      .lt('created_at', untilIso)
      .ilike('message', `${QUOTE_TAG}%`)
      .limit(1)
    if (dupe && dupe.length > 0) {
      return NextResponse.json({ success: true, deduped: true })
    }
  }

  const { error } = await supabase.from('leads').insert([{
    site_id: siteId,
    name: typeof name === 'string' ? name.trim() || null : null,
    email: cleanEmail || null,
    phone: cleanPhone || null,
    message: `${QUOTE_TAG}${bodyText}`,
    product: typeof product === 'string' ? product.trim() || null : null,
    created_at: createdAt,
  }])

  if (error) {
    console.error('[quote-intake] insert failed:', error.message)
    return NextResponse.json({ error: 'Insert failed' }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
