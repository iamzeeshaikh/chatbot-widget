import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow } from '@/lib/leadrecord'
import { supabase } from '@/lib/supabase'
import { CRM_NOTE_ROLE, MAX_NOTE_LENGTH, parseCrmNote, type CrmNoteEntry } from '@/lib/crm'

export const dynamic = 'force-dynamic'

// Internal notes. Never sent to the visitor: a crm_note row is a registered
// control role, so every message view filters it out.
//
// Append-only — an edit or a delete writes a NEW row carrying the same note id
// (newest row per id wins on read). Nothing is ever removed, because the older
// rows are the audit trail the activity timeline is built from.

async function latestRevision(sessionId: string, noteId: string): Promise<CrmNoteEntry | null> {
  const { data } = await supabase
    .from('chat_logs')
    .select('message')
    .eq('session_id', sessionId)
    .eq('role', CRM_NOTE_ROLE)
    .order('created_at', { ascending: false })
    .limit(200)
  for (const row of data ?? []) {
    const n = parseCrmNote(row.message)
    if (n?.id === noteId) return n
  }
  return null
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { body } = await req.json().catch(() => ({}))
  const text = typeof body === 'string' ? body.trim().slice(0, MAX_NOTE_LENGTH) : ''
  if (!text) return NextResponse.json({ error: 'Note is empty' }, { status: 400 })

  const note: CrmNoteEntry = {
    id: `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    body: text,
    author: access.member.email,
    at: new Date().toISOString(),
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(note),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, note })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { noteId, body } = await req.json().catch(() => ({}))
  const text = typeof body === 'string' ? body.trim().slice(0, MAX_NOTE_LENGTH) : ''
  if (typeof noteId !== 'string' || !noteId || !text) {
    return NextResponse.json({ error: 'noteId and body are required' }, { status: 400 })
  }
  const existing = await latestRevision(id, noteId)
  if (!existing || existing.deleted) return NextResponse.json({ error: 'Note not found' }, { status: 404 })

  const note: CrmNoteEntry = {
    ...existing,
    body: text,
    edited_at: new Date().toISOString(),
  }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(note),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true, note })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id)
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })

  const { noteId } = await req.json().catch(() => ({}))
  if (typeof noteId !== 'string' || !noteId) return NextResponse.json({ error: 'noteId required' }, { status: 400 })
  const existing = await latestRevision(id, noteId)
  if (!existing) return NextResponse.json({ error: 'Note not found' }, { status: 404 })

  const note: CrmNoteEntry = { ...existing, deleted: true, edited_at: new Date().toISOString() }
  const { error } = await writeControlRow({
    sessionId: id, siteId: access.siteId, role: CRM_NOTE_ROLE, message: JSON.stringify(note),
  })
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ ok: true })
}
