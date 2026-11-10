import { NextRequest, NextResponse } from 'next/server'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { getMember } from '@/lib/auth'
import { supabase } from '@/lib/supabase'
import { CRM_WA_BOT_OFF_ROLE } from '@/lib/crm'
import { readBotConfig } from '@/lib/wabotsweep'

export const dynamic = 'force-dynamic'

// The per-lead "Bot off" switch for the WhatsApp assistant. Packaging only
// ('wabot'). GET → { off, workspaceOn }; POST { off: boolean } appends a row
// (newest wins, the history stays as the audit trail).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const access = await guardLeadAccess(await getMember(req), id, 'wabot')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const [{ data }, cfg] = await Promise.all([
    supabase.from('chat_logs').select('message').eq('session_id', id).eq('role', CRM_WA_BOT_OFF_ROLE)
      .order('created_at', { ascending: false }).limit(1),
    readBotConfig(),
  ])
  let off = false
  try { off = JSON.parse(data?.[0]?.message ?? '{}')?.off === true } catch { /* default on */ }
  return NextResponse.json({ off, workspaceOn: cfg.enabled, delayMin: cfg.delayMin })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const access = await guardLeadAccess(await getMember(req), id, 'wabot')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const b = await req.json().catch(() => ({}))
  if (typeof b.off !== 'boolean') return NextResponse.json({ error: 'off must be true or false' }, { status: 400 })
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_WA_BOT_OFF_ROLE,
    message: JSON.stringify({ off: b.off, by: access.member.email, at: new Date().toISOString() }),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, off: b.off })
}
