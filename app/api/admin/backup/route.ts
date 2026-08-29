import { NextRequest, NextResponse } from 'next/server'
import { supabase, fetchAllPages } from '@/lib/supabase'
import { getMember, memberSites } from '@/lib/auth'
import { CRM_ROLES } from '@/lib/crm'
import { LEAD_CAPTURE_ROLE } from '@/lib/leadtracking'
import { LEAD_STATUS_ROLE } from '@/lib/leadstatus'
import { ASSIGNMENT_ROLE } from '@/lib/assignment'
import { CONTACT_ROLE } from '@/lib/visitor'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// A copy of this workspace's leads that lives somewhere other than Supabase.
//
// Everything here is already in the dashboard; the point is having it OFF the
// platform. Agents can no longer export (see the Billing route), so without
// this the owner had no way either — every record sat in one database, on one
// Micro instance, with no second copy anywhere.
//
// THREE THINGS YOU CAN TAKE, for three different jobs:
//   • csv         — the leads themselves, openable in Excel. What you want when
//                   somebody asks "send me the customer list for August".
//   • json        — leads AND the CRM work around them: notes, stage changes,
//                   deal values, tasks, sent and received email, assignments.
//                   This one could rebuild the CRM; the CSV could not.
//   • json?full=1 — the above PLUS every chat transcript, the site settings and
//                   the member list. The whole system as data, minus the things
//                   that must never sit in a file: no passwords, no Gmail
//                   tokens, no push subscriptions, no webhook secrets.
//                   It is much bigger, so it is a deliberate choice rather than
//                   the default.
//
// ADMINS ONLY, and scoped to the caller's own workspace — a backup is the
// whole customer list in one file, which is exactly what the export lockdown
// was about.
//
// Bounded like every other query here (CLAUDE.md §6): the caps are generous but
// real, and the response says when one was hit rather than quietly returning
// less than everything, because a backup that is silently partial is worse than
// no backup at all.
const LEAD_CAP = 50_000
const CONTROL_CAP = 200_000

interface LeadRow {
  id: string; site_id: string; name: string | null; email: string | null
  phone: string | null; message: string | null; created_at: string
  product: string | null; quantity: string | null; budget: string | null
  timeline: string | null; qualification_score: number | null
}

interface ControlRow {
  session_id: string; site_id: string; role: string; message: string; created_at: string
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') {
    return NextResponse.json({ error: 'Only an admin can download a backup.' }, { status: 403 })
  }

  const sites = memberSites(member)
  if (sites.length === 0) return NextResponse.json({ error: 'No sites in this workspace.' }, { status: 400 })

  const format = req.nextUrl.searchParams.get('format') === 'csv' ? 'csv' : 'json'
  const full = req.nextUrl.searchParams.get('full') === '1'
  const stamp = new Date().toISOString().slice(0, 10)

  const leads = await fetchAllPages<LeadRow>(
    () => supabase.from('leads')
      .select('id, site_id, name, email, phone, message, created_at, product, quantity, budget, timeline, qualification_score')
      .in('site_id', sites)
      .order('created_at', { ascending: true }),
    LEAD_CAP)

  if (format === 'csv') {
    const header = ['created_at', 'site_id', 'name', 'email', 'phone', 'product', 'quantity', 'budget', 'timeline', 'score', 'message']
    const rows = leads.map((l) => [
      l.created_at, l.site_id, l.name, l.email, l.phone, l.product, l.quantity, l.budget, l.timeline,
      l.qualification_score, l.message,
    ].map(csvCell).join(','))
    // A BOM, so Excel opens a customer's name with an accent in it correctly
    // rather than as mojibake.
    const csv = '﻿' + [header.join(','), ...rows].join('\r\n')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="zeeops-${member.workspace}-leads-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // The CRM history: every control row that carries work done on a lead.
  const control = await fetchAllPages<ControlRow>(
    () => supabase.from('chat_logs')
      .select('session_id, site_id, role, message, created_at')
      .in('site_id', sites)
      .in('role', [...CRM_ROLES, LEAD_CAPTURE_ROLE, LEAD_STATUS_ROLE, ASSIGNMENT_ROLE, CONTACT_ROLE])
      .order('created_at', { ascending: true }),
    CONTROL_CAP)

  // The whole system, when asked for: conversations as they were typed, the
  // sites' own settings, and who had an account. Secrets are excluded by
  // listing what goes IN rather than what stays out — a denylist would let the
  // next control role that holds a token walk straight into a backup file.
  let messages: ControlRow[] = []
  let siteRows: unknown[] = []
  let memberRows: unknown[] = []
  if (full) {
    messages = await fetchAllPages<ControlRow>(
      () => supabase.from('chat_logs')
        .select('session_id, site_id, role, message, created_at')
        .in('site_id', sites)
        .in('role', ['user', 'visitor', 'assistant', 'admin'])
        .order('created_at', { ascending: true }),
      CONTROL_CAP)
    const s1 = await supabase.from('sites').select('*').in('site_id', sites)
    siteRows = s1.data ?? []
    const m1 = await supabase.from('members')
      .select('email, role, assigned_sites, created_at')
      .eq('workspace', member.workspace)
    memberRows = m1.data ?? []
  }

  const body = {
    generatedAt: new Date().toISOString(),
    workspace: member.workspace,
    by: member.email,
    scope: full ? 'full' : 'leads+crm',
    sites,
    counts: {
      leads: leads.length, crmRows: control.length,
      ...(full ? { chatMessages: messages.length, siteConfigs: siteRows.length, members: memberRows.length } : {}),
    },
    // Said out loud rather than left to be discovered: a cap that was reached
    // means this file is NOT the whole record.
    truncated: leads.length >= LEAD_CAP || control.length >= CONTROL_CAP || messages.length >= CONTROL_CAP,
    leads,
    crm: control,
    ...(full ? { conversations: messages, siteConfigs: siteRows, members: memberRows } : {}),
  }

  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="zeeops-${member.workspace}-${full ? 'full' : 'leads'}-backup-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
