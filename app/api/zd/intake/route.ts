import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { supabase } from '@/lib/supabase'
import { QUOTE_TAG, CHECKOUT_TAG, isLikelySpamQuote, isTestSubmission } from '@/lib/quoteintake'
import { siteWorkspace } from '@/lib/workspaces'
import { sendPushToWorkspace } from '@/lib/push'
import { recordIntakeDrop } from '@/lib/intakedrop'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ZeeDesk form intake — a ZeeDesk site's own server posts each quote request
// and each order here, so it becomes a lead in that team's workspace.
//
// The other team's intake (/api/quote-intake) reads a Gmail inbox through an
// Apps Script; these sites have no such inbox, so they call this directly from
// their /api/quote and /api/order handlers, server to server, with a shared
// secret (ZEEDESK_INTAKE_SECRET). It is never called from a browser, so there
// is no CORS here on purpose.
//
//   POST { siteId, kind: 'quote' | 'order', name, email, phone, product,
//          message, fields: { "Quantity": "500", … }, orderRef, pageUrl }
//
// Only ZeeDesk sites are accepted: the secret can never write a lead into
// another workspace, whatever siteId it names.

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : typeof v === 'number' ? String(v) : '')

function secretOk(given: string | null): boolean {
  const want = process.env.ZEEDESK_INTAKE_SECRET ?? ''
  if (!want || !given) return false
  const a = Buffer.from(given, 'utf8'); const b = Buffer.from(want, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  if (!secretOk(req.headers.get('x-zd-secret'))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const siteId = str(body.siteId, 80)
  if (!siteId || siteWorkspace(siteId) !== 'zeedesk') return NextResponse.json({ error: 'Unknown site' }, { status: 400 })

  const kind = body.kind === 'order' ? 'order' : 'quote'
  const name = str(body.name, 120)
  const email = str(body.email, 200).toLowerCase()
  const phone = str(body.phone, 40)
  const product = str(body.product, 200)
  const message = str(body.message, 3000)
  const orderRef = str(body.orderRef, 60)
  const pageUrl = str(body.pageUrl, 400)
  if (!email && !phone) return NextResponse.json({ error: 'An email or a phone number is required' }, { status: 400 })

  // The record's opening entry, written the way the form was filled in.
  const lines: string[] = []
  if (kind === 'order' && orderRef) lines.push(`Order: ${orderRef}`)
  if (name) lines.push(`Name: ${name}`)
  if (email) lines.push(`Email: ${email}`)
  if (phone) lines.push(`Phone: ${phone}`)
  if (product) lines.push(`Product: ${product}`)
  const fields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields as Record<string, unknown> : {}
  for (const [k, v] of Object.entries(fields).slice(0, 40)) {
    const label = str(k, 60); const value = str(v, 500)
    if (label && value) lines.push(`${label}: ${value}`)
  }
  if (message) lines.push(`Message: ${message}`)
  if (pageUrl) lines.push(`Page URL: ${pageUrl}`)
  const text = lines.join('\n')

  // Our own test submissions are acknowledged and not recorded, exactly as the
  // chat widget's lead form treats them.
  if (isTestSubmission(name, email, phone, message)) return NextResponse.json({ success: true, test: true })

  // A supplier or SEO pitch is not a lead. It is kept as an intake drop, never
  // thrown away, so anything misjudged can still be found. Orders are never
  // judged: somebody paid.
  if (kind === 'quote' && isLikelySpamQuote(text, phone || null)) {
    await recordIntakeDrop({ siteId, reason: 'spam', detail: 'site form: vendor or spam pitch', name, email, phone, product, excerpt: text })
    return NextResponse.json({ success: true, dropped: true })
  }

  const tag = kind === 'order' ? CHECKOUT_TAG : QUOTE_TAG
  const stored = `${tag}${text}`.slice(0, 4000)

  // A double click, or the site retrying after a slow answer, must not make two
  // leads: the same person sending the same thing within fifteen minutes is one.
  const since = new Date(Date.now() - 15 * 60_000).toISOString()
  let dupe = supabase.from('leads').select('id').eq('site_id', siteId).eq('message', stored).gte('created_at', since).limit(1)
  dupe = email ? dupe.eq('email', email) : dupe.eq('phone', phone)
  const { data: seen } = await dupe
  if (seen?.[0]?.id) return NextResponse.json({ success: true, deduped: true, id: seen[0].id })

  const { data: inserted, error } = await supabase.from('leads').insert([{
    site_id: siteId, name: name || null, email: email || null, phone: phone || null,
    message: stored, product: product || null,
  }]).select('id').single()
  if (error || !inserted?.id) {
    console.error('[zd-intake] insert failed:', error?.message)
    return NextResponse.json({ error: 'Could not save the lead' }, { status: 500 })
  }

  await sendPushToWorkspace('zeedesk', {
    title: kind === 'order' ? `New order — ${name || email || phone}` : `New quote request — ${name || email || phone}`,
    body: [product, message].filter(Boolean).join(' · ').slice(0, 140) || 'Open the record to see the details.',
    url: `/leads/quote-${inserted.id}`,
    tag: `zd-intake-${inserted.id}`,
  }).catch(() => {})

  return NextResponse.json({ success: true, id: inserted.id, recordId: `quote-${inserted.id}` })
}
