// One-off historical backfill of billing leads for lead-tracked sites.
// Idempotent: re-running won't double-count (skips sessions that already have a
// lead_capture row, and only adds the "lead" tag when missing).
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = fs.readFileSync('.env.local', 'utf8')
const get = (k) => (env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1]?.trim()
const sb = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

const LEAD_TRACKED_SITES = ['shopcardboardboxes']
const LEAD_CAPTURE_ROLE = 'lead_capture'
const TAGS_ROLE = 'tags'
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const isValidEmail = (e) => !!e && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e.trim())
const extractEmail = (t) => { const m = (t || '').match(EMAIL_RE); return m ? m[0].toLowerCase().replace(/[.,;:]+$/, '') : null }
const extractPhone = (t) => { const m = (t || '').match(/\+?\d[\d\s().-]{6,}\d/); if (!m) return null; const d = m[0].replace(/\D/g, ''); return d.length >= 7 && d.length <= 15 ? m[0].trim() : null }

const DRY = process.argv.includes('--dry')

async function ensureTag(sessionId, siteId, at) {
  const { data: tagRows } = await sb.from('chat_logs').select('message').eq('session_id', sessionId).eq('role', TAGS_ROLE).order('created_at', { ascending: true })
  let current = []
  const last = tagRows?.[tagRows.length - 1]?.message
  if (last) { try { current = JSON.parse(last) } catch {} }
  if (!Array.isArray(current)) current = []
  if (current.some((t) => String(t).toLowerCase() === 'lead')) return false
  const next = ['lead', ...current].filter((v, i, a) => a.findIndex((x) => String(x).toLowerCase() === String(v).toLowerCase()) === i).slice(0, 20)
  // Use the historical capture time so adding the tag never widens the session's
  // activity window (which would corrupt time-based form-lead matching on re-run).
  if (!DRY) await sb.from('chat_logs').insert({ site_id: siteId, session_id: sessionId, role: TAGS_ROLE, message: JSON.stringify(next), created_at: at })
  return true
}

async function insertCapture(sessionId, siteId, lead, seenEmails) {
  // Dedupe by email across the whole site, and skip if this conversation already
  // has a lead_capture row.
  if (seenEmails.has(lead.email)) { console.log('  skip (email already captured):', lead.email); return false }
  const { data: existing } = await sb.from('chat_logs').select('id').eq('session_id', sessionId).eq('role', LEAD_CAPTURE_ROLE).limit(1)
  if (existing && existing.length) { console.log('  skip (already captured):', sessionId.slice(0, 18), lead.email); return false }
  if (!DRY) {
    await sb.from('chat_logs').insert({ site_id: siteId, session_id: sessionId, role: LEAD_CAPTURE_ROLE, message: JSON.stringify(lead), created_at: lead.at })
  }
  await ensureTag(sessionId, siteId, lead.at)
  seenEmails.add(lead.email)
  console.log('  CAPTURED:', sessionId.slice(0, 18), '|', lead.email, '| name:', lead.name || '-', '| phone:', lead.phone || '-', '| at:', lead.at)
  return true
}

async function run() {
  let backfilled = 0
  const months = {}
  const seenEmails = new Set()

  for (const SITE of LEAD_TRACKED_SITES) {
    const { data: logs } = await sb.from('chat_logs').select('session_id,role,message,created_at').eq('site_id', SITE).order('created_at', { ascending: true })
    const bySession = {}
    for (const l of logs) (bySession[l.session_id] = bySession[l.session_id] || []).push(l)

    // Pre-seed dedupe with emails already captured for this site (safe re-runs).
    for (const l of logs) {
      if (l.role !== LEAD_CAPTURE_ROLE) continue
      try { const c = JSON.parse(l.message); if (c.email) seenEmails.add(String(c.email).toLowerCase()) } catch {}
    }

    // Pass A — emails the visitor typed in chat (role 'user').
    const typedEmailSessions = new Set()
    for (const [sid, rows] of Object.entries(bySession)) {
      const emailMsg = rows.find((r) => r.role === 'user' && r.message && EMAIL_RE.test(r.message))
      if (!emailMsg) continue
      const email = extractEmail(emailMsg.message)
      if (!isValidEmail(email)) continue
      typedEmailSessions.add(sid)
      // name/phone enrichment from a contact control row, if any.
      let name = null, phone = extractPhone(emailMsg.message)
      const contact = [...rows].reverse().find((r) => r.role === 'contact')
      if (contact) { try { const c = JSON.parse(contact.message); name = c.name || name; phone = phone || c.phone || null } catch {} }
      console.log('[chat-typed]', sid.slice(0, 18), email)
      if (await insertCapture(sid, SITE, { email, name, phone, at: emailMsg.created_at }, seenEmails)) {
        backfilled++; months[emailMsg.created_at.slice(0, 7)] = (months[emailMsg.created_at.slice(0, 7)] || 0) + 1
      }
    }

    // Session activity windows (for mapping form leads to a conversation).
    const windows = Object.entries(bySession).map(([sid, rows]) => {
      const ts = rows.filter((r) => r.role !== 'mode').map((r) => new Date(r.created_at).getTime())
      return { sid, min: Math.min(...ts), max: Math.max(...ts) }
    })

    // Pass B — lead-form submissions (leads table; no session_id stored).
    const { data: formLeads } = await sb.from('leads').select('email,name,phone,created_at').eq('site_id', SITE)
    for (const fl of formLeads || []) {
      const email = (fl.email || '').toLowerCase().trim()
      if (!isValidEmail(email)) { console.log('[form] invalid email, skip:', fl.email); continue }
      if (seenEmails.has(email)) { console.log('[form] already captured this email, skip:', email); continue }
      const t = new Date(fl.created_at).getTime()
      // Unique time-containment match, excluding sessions that already have their
      // own typed email (so we don't mis-attach to a different visitor's chat).
      const candidates = windows.filter((w) => t >= w.min && t <= w.max && !typedEmailSessions.has(w.sid))
      const sessionId = candidates.length === 1 ? candidates[0].sid : `form-${SITE}-${t}`
      console.log('[form]', email, '→', candidates.length === 1 ? 'matched session ' + sessionId.slice(0, 18) : 'no unique match, synthetic ' + sessionId)
      const lead = { email, name: fl.name || null, phone: (fl.phone || '').trim() || null, at: fl.created_at }
      if (await insertCapture(sessionId, SITE, lead, seenEmails)) {
        backfilled++; months[fl.created_at.slice(0, 7)] = (months[fl.created_at.slice(0, 7)] || 0) + 1
      }
    }
  }

  console.log('\n=== SUMMARY' + (DRY ? ' (DRY RUN — nothing written)' : '') + ' ===')
  console.log('Backfilled leads:', backfilled)
  console.log('By month:', JSON.stringify(months))
}

run().catch((e) => { console.error(e); process.exit(1) })
