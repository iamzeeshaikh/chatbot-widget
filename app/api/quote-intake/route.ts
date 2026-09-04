import { NextRequest, NextResponse } from 'next/server'
import { ATTACHMENT_BUCKET, MAX_ATTACHMENT_BYTES, buildAttachmentMessage, isAllowedMime, parseAttachment, uniqueAttachmentPath, type AttachmentInfo } from '@/lib/attachment'
import { supabase } from '@/lib/supabase'
import { QUOTE_TAG, CHECKOUT_TAG, siteIdFromQuoteCode, isLikelySpamQuote, isCheckoutOrder, checkoutOrderNumber, normalizeQuoteBody, isSameQuoteBody } from '@/lib/quoteintake'
import { isRetiredLeadSite } from '@/lib/workspaces'

export const dynamic = 'force-dynamic'

// Ingest a custom-quote lead pushed by the Google Apps Script Gmail watcher
// (scripts/quote-intake-apps-script.gs) — the Script does all the reading of
// the user's own Gmail; this endpoint never touches Gmail itself, it only
// accepts already-parsed fields over a shared secret. Never used by the
// widget or any browser — server-to-server only.
// The quote form's ARTWORK file used to die in the Gmail inbox: the Apps
// Script forwarded only the text, so the record said "(attached)" about a file
// nobody in ZeeOps could open (found via a real lead, 2026-09-04). The script
// now sends the attachments base64-encoded alongside, and they are stored
// EXACTLY as a chat upload is — same bucket, same {"__file":…} row on the
// lead's session — so the record's Files panel and timeline need no new code.
//
// Deduped by name+size against the rows already on the session, because the
// same form is routinely submitted twice with the same artwork, and the
// same-day merge path deliberately funnels those into one lead.
const MAX_INTAKE_FILES = 5

interface IntakeFile { name: string; mime: string; bytes: Buffer }

function parseIntakeAttachments(raw: unknown): IntakeFile[] {
  if (!Array.isArray(raw)) return []
  const out: IntakeFile[] = []
  for (const a of raw.slice(0, MAX_INTAKE_FILES)) {
    const name = typeof a?.name === 'string' ? a.name.slice(0, 200) : ''
    const mime = typeof a?.mime === 'string' ? a.mime : ''
    const data = typeof a?.data === 'string' ? a.data : ''
    if (!name || !data || !isAllowedMime(mime)) continue
    let bytes: Buffer
    try { bytes = Buffer.from(data, 'base64') } catch { continue }
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue
    out.push({ name, mime, bytes })
  }
  return out
}

async function storeIntakeAttachments(siteId: string, leadId: string, files: IntakeFile[], createdAt: string): Promise<void> {
  if (files.length === 0) return
  const sessionId = `quote-${leadId}`
  const { data: existing } = await supabase.from('chat_logs')
    .select('message').eq('session_id', sessionId).eq('role', 'user').limit(200)
  const have = new Set((existing ?? [])
    .map((r) => parseAttachment(r.message))
    .filter((f): f is AttachmentInfo => !!f)
    .map((f) => `${f.name}|${f.size}`))
  for (const f of files) {
    if (have.has(`${f.name}|${f.bytes.length}`)) continue
    const path = uniqueAttachmentPath(siteId, sessionId, f.mime, f.name)
    const { error: upErr } = await supabase.storage.from(ATTACHMENT_BUCKET)
      .upload(path, f.bytes, { contentType: f.mime, upsert: false })
    if (upErr) { console.error('[quote-intake] attachment upload failed:', upErr.message); continue }
    const { data: pub } = supabase.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path)
    await supabase.from('chat_logs').insert([{
      session_id: sessionId, site_id: siteId, role: 'user',
      message: buildAttachmentMessage({ url: pub.publicUrl, name: f.name, mime: f.mime, size: f.bytes.length }),
      created_at: createdAt,
    }])
  }
}

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

  // Partnership ended for this site: accept silently without inserting, same
  // as the spam path — the Apps Script has already labeled the thread
  // Processed and must not retry. Existing leads are untouched.
  if (isRetiredLeadSite(siteId)) {
    return NextResponse.json({ success: true, retired: true })
  }

  const cleanEmail = typeof email === 'string' ? email.trim() : ''
  const cleanPhone = typeof phone === 'string' ? phone.trim() : ''
  if (!cleanEmail && !cleanPhone) {
    return NextResponse.json({ error: 'email or phone required' }, { status: 400 })
  }

  const bodyText = typeof message === 'string' ? message.trim() : ''
  const files = parseIntakeAttachments(body.attachments)
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
    // What to look for in a stored message. A Woo number is bare digits and
    // needs its "#" back or "6467" would also match a price or a phone; a COD
    // id ("SCB-1787700487431") is already unique enough to search as it stands,
    // and never appears with a "#" in front of it.
    const needle = /^\d+$/.test(orderNo) ? `#${orderNo}` : orderNo
    const { data: sameOrder } = await supabase
      .from('leads')
      .select('id')
      .eq('site_id', siteId)
      .ilike('message', `${CHECKOUT_TAG}%`)
      .ilike('message', `%${needle}%`)
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
    const isDupe = (candidates ?? []).some((c) => isSameQuoteBody(normalizeQuoteBody(c.message ?? ''), normalized))
    if (isDupe) {
      return NextResponse.json({ success: true, deduped: true })
    }
  }

  // Same person, same site, same day = ONE enquiry, however many times the form
  // was submitted. Customers routinely send the identical form two or three
  // times within minutes, attaching a different artwork file each go (and
  // sometimes fixing a typo in between). The body comparison above can't catch
  // those: the upload URL sits ABOVE the `---` footer, so it lands inside the
  // compared text and is different every time. A genuine second enquiry from
  // the same customer on the same day to the same site is vanishingly rare
  // next to that — 39 such rows across 1,020 leads were all repeat submissions.
  //
  // The fullest version wins: the first submission is often the one WITHOUT
  // the artwork attached, so a longer follow-up replaces the stored text
  // rather than being thrown away. The lead keeps its id, status and original
  // timestamp.
  if (cleanEmail && tag === QUOTE_TAG) {
    const dayStart = `${createdAt.slice(0, 10)}T00:00:00Z`
    const dayEnd = new Date(new Date(dayStart).getTime() + 86400000).toISOString()
    const { data: sameDay } = await supabase
      .from('leads')
      .select('id, message')
      .eq('site_id', siteId)
      .ilike('email', cleanEmail)
      .ilike('message', `${QUOTE_TAG}%`)
      .gte('created_at', dayStart)
      .lt('created_at', dayEnd)
      .order('created_at', { ascending: true })
      .limit(1)
    const existing = sameDay?.[0]
    if (existing) {
      const incoming = `${tag}${bodyText}`
      if (incoming.length > (existing.message?.length ?? 0)) {
        await supabase.from('leads').update({ message: incoming }).eq('id', existing.id)
      }
      await storeIntakeAttachments(siteId, existing.id, files, createdAt)
      return NextResponse.json({ success: true, deduped: true })
    }
  }

  const { data: inserted, error } = await supabase.from('leads').insert([{
    site_id: siteId,
    name: typeof name === 'string' ? name.trim() || null : null,
    email: cleanEmail || null,
    phone: cleanPhone || null,
    message: `${tag}${bodyText}`,
    product: typeof product === 'string' ? product.trim() || null : null,
    created_at: createdAt,
  }]).select('id').single()

  if (error) {
    console.error('[quote-intake] insert failed:', error.message)
    return NextResponse.json({ error: 'Insert failed' }, { status: 500 })
  }
  if (inserted?.id) await storeIntakeAttachments(siteId, inserted.id, files, createdAt)
  return NextResponse.json({ success: true })
}
