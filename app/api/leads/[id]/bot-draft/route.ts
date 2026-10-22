import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { guardLeadAccess, writeControlRow, markThreadRepliesRead } from '@/lib/leadrecord'
import { googleConfig, sendEmail, GmailAuthError } from '@/lib/gmail'
import { threadContextFor } from '@/lib/emailsweep'
import { buildSendSignature } from '@/lib/sendsignature'
import { openPixelHtml } from '@/lib/emailtrack'
import { makeSnippet, newEmailId, type CrmEmailEntry } from '@/lib/crmemail'
import { emailHtml, BOT_ACTOR } from '@/lib/quotebotcore'
import { CRM_BOT_ROLE } from '@/lib/quotebot'
import { CRM_EMAIL_ROLE, CRM_TASK_ROLE } from '@/lib/crm'
import { applyStageChange } from '@/lib/stagechange'
import { newTaskId, type CrmTaskEntry } from '@/lib/tasks'
import { sendPushToMember } from '@/lib/push'
import { supabase } from '@/lib/supabase'
import { CRM_BOT_DRAFT_ROLE, foldDrafts, type BotDraft } from '@/lib/botdraft'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PUBLIC_BASE = (process.env.NEXT_PUBLIC_BASE_URL || 'https://chat.zeeops.dev').replace(/\/$/, '')

// The agent's decision on a bot draft (lib/botdraft.ts): send it — exactly
// as the bot would have, from the lead's agent's mailbox, threaded, signed,
// tracked — or discard it. Either way the bot's ledger gets the row that
// keeps or stops its follow-ups.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const member = await getMember(req)
  const access = await guardLeadAccess(member, id, 'email')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const body = await req.json().catch(() => ({}))
  const action = body.action === 'discard' ? 'discard' : 'send'
  const draftId = String(body.draftId ?? '')

  const { data } = await supabase.from('chat_logs').select('role, message, site_id')
    .eq('session_id', id).eq('role', CRM_BOT_DRAFT_ROLE).order('created_at', { ascending: true })
  const rows = (data ?? []) as { role: string; message: string; site_id: string }[]
  const draft = foldDrafts(rows).find((d) => d.id === draftId)
  if (!draft) return NextResponse.json({ error: 'That draft is not on this lead.' }, { status: 404 })
  if (draft.status !== 'pending') return NextResponse.json({ error: `That draft was already ${draft.status}.` }, { status: 409 })
  const siteId = rows[0].site_id
  const by = access.member.email
  const decidedAt = new Date().toISOString()
  const ledger = (entry: Record<string, unknown>) => writeControlRow({ sessionId: id, siteId, role: CRM_BOT_ROLE, message: JSON.stringify(entry) })
  const revise = (patch: Partial<BotDraft>) => writeControlRow({ sessionId: id, siteId, role: CRM_BOT_DRAFT_ROLE, message: JSON.stringify({ ...draft, ...patch }) })

  if (action === 'discard') {
    await revise({ status: 'discarded', by, decidedAt, why: String(body.why ?? '').slice(0, 200) || undefined })
    await ledger({ step: draft.step, state: 'skipped', at: decidedAt, why: `draft discarded by ${by}`, to: draft.to, agent: draft.agent, inboundId: draft.inboundId })
    return NextResponse.json({ ok: true, status: 'discarded' })
  }

  const text = String(body.text ?? '').trim() || draft.text
  const subject = String(body.subject ?? '').trim().slice(0, 200) || draft.subject
  if (text.length > 20000) return NextResponse.json({ error: 'That message is too long to send.' }, { status: 400 })
  const cfg = googleConfig(PUBLIC_BASE)
  if (!cfg) return NextResponse.json({ error: 'Google OAuth is not configured' }, { status: 503 })

  const sig = await buildSendSignature({ memberEmail: draft.agent, workspace: 'packaging', siteId, from: draft.from, base: PUBLIC_BASE })
  const emailId = newEmailId()
  const finalText = sig.text ? `${text}\n\n${sig.text}` : text
  const finalHtml = `${emailHtml(text)}${sig.html}${openPixelHtml(PUBLIC_BASE, id, emailId)}`
  const thread = draft.step === 'reply' && draft.inboundId ? await threadContextFor(id, draft.inboundId) : null

  let sent
  try {
    sent = await sendEmail(draft.agent, cfg, {
      from: draft.from, to: draft.to, subject, body: finalText, html: finalHtml,
      threadId: thread?.threadId, inReplyTo: thread?.inReplyTo, references: thread?.references,
    })
  } catch (e) {
    const why = e instanceof GmailAuthError ? `${draft.agent}'s Gmail needs reconnecting` : (e instanceof Error ? e.message : 'Gmail rejected the message')
    return NextResponse.json({ error: why }, { status: 502 })
  }

  const at = new Date().toISOString()
  // bot:true keeps the follow-up chain alive (a human email would stop it);
  // sentBy is the mailbox it left from. The reviewer is on the draft row.
  const entry: CrmEmailEntry = {
    id: emailId, sentBy: draft.agent, from: draft.from, to: draft.to, subject,
    body: finalText, html: finalHtml, snippet: makeSnippet(text), at,
    gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId,
    direction: 'outbound', bot: true,
  }
  // reviewedBy: a person read and sent it — Opportunities counts it as a human reply.
  await writeControlRow({ sessionId: id, siteId, role: CRM_EMAIL_ROLE, message: JSON.stringify({ ...entry, reviewedBy: by }) })
  await revise({ status: 'sent', by, decidedAt: at, sentEmailId: emailId, text, subject })
  await ledger({ step: draft.step, state: 'sent', at, to: draft.to, agent: draft.agent, from: draft.from, complete: draft.complete, missing: draft.missing, emailId, inboundId: draft.inboundId })

  if (draft.step === 'first') {
    await applyStageChange({ leadId: id, siteId, stage: 'contacted', previous: 'new', actorEmail: by })
    if (draft.chatSessionId) await applyStageChange({ leadId: draft.chatSessionId, siteId, stage: 'contacted', previous: 'new', actorEmail: by })
  } else {
    await markThreadRepliesRead(id, siteId, sent.threadId, by)
  }
  if (draft.complete) {
    const task: CrmTaskEntry = {
      id: newTaskId(),
      title: `Send the price quote — ${draft.to} gave size, style and quantity`.slice(0, 200),
      type: 'email', due_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
      assignee: draft.agent, status: 'open', created_by: BOT_ACTOR, created_at: at,
    }
    await writeControlRow({ sessionId: id, siteId, role: CRM_TASK_ROLE, message: JSON.stringify(task) })
    if (draft.agent !== by) {
      await sendPushToMember(draft.agent, 'packaging', { title: 'Quote ready to price', body: `${draft.to} sent everything. Send the price.`, url: `/leads/${encodeURIComponent(id)}`, tag: `quotebot-${id}` }).catch(() => 0)
    }
  }
  return NextResponse.json({ ok: true, status: 'sent', emailId })
}
