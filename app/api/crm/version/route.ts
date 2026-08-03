import { NextRequest, NextResponse } from 'next/server'
import { getMember, memberSites } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { CRM_ROLES } from '@/lib/crm'
import { ASSIGNMENT_ROLE } from '@/lib/assignment'
import { LEAD_STATUS_ROLE } from '@/lib/leadstatus'

export const dynamic = 'force-dynamic'

// "Has anything changed?" — the cheap half of live updates.
//
// The screens poll THIS, not their real endpoint, and only refetch the heavy
// payload when the marker moves. Each answer is a single index-backed row:
//   • lead  — newest chat_logs row for one session   (idx_chat_logs_session_created)
//   • crm   — newest CRM row across the member's sites (idx_chat_logs_created_at)
// Both measured at the network floor (~250ms round trip, no measurable DB
// time), which is what makes a 20-second poll safe on a Micro instance that has
// fallen over once before.
//
// chat_logs is append-only, so "newest created_at" is a sound version marker: a
// note, a stage change, a captured reply and a task all append a row. It cannot
// see a DELETE, which only happens during manual cleanup — a case where a
// refresh is expected anyway.

const WATCHED_ROLES = [...CRM_ROLES, ASSIGNMENT_ROLE, LEAD_STATUS_ROLE]

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const leadId = req.nextUrl.searchParams.get('lead')
  const sites = memberSites(member)
  if (sites.length === 0) return NextResponse.json({ crm: null, lead: null })

  const [crmRes, leadRes] = await Promise.all([
    // Board-level marker: any CRM write on a site this member can see. Role
    // filtered so ordinary chat traffic does not invalidate the pipeline every
    // few seconds on a busy site.
    supabase.from('chat_logs')
      .select('created_at')
      .in('site_id', sites)
      .in('role', WATCHED_ROLES)
      .order('created_at', { ascending: false })
      .limit(1),
    // Record-level marker: ANY row on this lead, including visitor messages and
    // agent replies, because all of them show on the record.
    leadId
      ? supabase.from('chat_logs')
          .select('created_at')
          .eq('session_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1)
      : Promise.resolve({ data: null }),
  ])

  return NextResponse.json({
    crm: crmRes.data?.[0]?.created_at ?? null,
    lead: leadRes.data?.[0]?.created_at ?? null,
  })
}
