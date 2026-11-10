import { NextRequest, NextResponse } from 'next/server'
import { guardLeadAccess, writeControlRow, leadPhone } from '@/lib/leadrecord'
import { getMember, type Member } from '@/lib/auth'
import { twilioConfig, twilioProblem, sendWhatsAppTemplate } from '@/lib/twilio'
import { metaWaConfig, sendMetaTemplate } from '@/lib/metawa'
import { CRM_WA_OUT_ROLE } from '@/lib/crm'
import { WA_TEMPLATES, templateByName, renderTemplate, templateStatuses, cleanVar } from '@/lib/watemplates'
import { waLeadContext, greetableFirstName } from '@/lib/wacontext'
import { memberDisplayName } from '@/lib/membername'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Approved WhatsApp templates for a lead whose 24-hour window has closed
// (lib/watemplates.ts). GET lists what may be sent, with the blanks already
// filled from the record and a preview; POST { name } sends one on the lead's
// own line. Packaging only ('watemplates'), and — like the free-form send —
// the recipient is never taken from the request.

async function varsFor(member: Member, id: string): Promise<{ vars: string[]; line: 'twilio' | 'meta' } | null> {
  const ctx = await waLeadContext(id)
  if (!ctx) return null
  // A shared login (packaging@, info@) has no person's name to sign with.
  const agent = greetableFirstName((await memberDisplayName(member.email)).split(/\s+/)[0]) ?? 'the team'
  return {
    line: ctx.line,
    vars: [cleanVar(ctx.firstName ?? '', 'there'), cleanVar(agent, 'the team'), cleanVar(ctx.siteName, 'ZEE Pack')],
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const access = await guardLeadAccess(await getMember(req), id, 'watemplates')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const v = await varsFor(access.member, id)
  if (!v) return NextResponse.json({ error: 'No such lead' }, { status: 404 })
  const status = await templateStatuses(v.line)
  return NextResponse.json({
    line: v.line === 'meta' ? 'UK' : 'US',
    templates: WA_TEMPLATES.map((t) => ({
      name: t.name, label: t.label, status: status.get(t.name) ?? 'unknown', preview: renderTemplate(t, v.vars),
    })),
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const access = await guardLeadAccess(await getMember(req), id, 'watemplates')
  if (!access.ok) return NextResponse.json({ error: 'Not allowed' }, { status: access.status })
  const body = await req.json().catch(() => ({}))
  const t = templateByName(String(body.name ?? ''))
  if (!t) return NextResponse.json({ error: 'Unknown template.' }, { status: 400 })
  const v = await varsFor(access.member, id)
  if (!v) return NextResponse.json({ error: 'No such lead' }, { status: 404 })
  if ((await templateStatuses(v.line)).get(t.name) !== 'approved') {
    return NextResponse.json({ error: 'WhatsApp has not approved this template on this line yet.' }, { status: 409 })
  }
  const meta = v.line === 'meta' ? metaWaConfig() : null
  const cfg = v.line === 'meta' ? null : twilioConfig(access.member.workspace)
  const problem = v.line === 'meta'
    ? (meta ? null : 'The UK WhatsApp line is not configured on the server (META_UK_*).')
    : twilioProblem(access.member.workspace)
  if (problem || (!cfg && !meta)) return NextResponse.json({ error: problem, needsSetup: true }, { status: 503 })
  const to = await leadPhone(id)
  if (!to) return NextResponse.json({ error: 'This lead has no phone number on file, so it cannot be messaged.' }, { status: 400 })

  const statusUrl = `${req.nextUrl.origin}/api/twilio/whatsapp/status?leadId=${encodeURIComponent(id)}`
  let sent
  try {
    sent = meta
      ? await sendMetaTemplate(meta, to, t.name, t.language, v.vars)
      : await sendWhatsAppTemplate(cfg!, to, t.twilioSid, Object.fromEntries(v.vars.map((x, i) => [String(i + 1), x])), statusUrl)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'WhatsApp refused the template.' }, { status: 502 })
  }
  // The same row shape as any outbound WhatsApp, plus the template's name, so
  // the timeline and thread show it and every "did an agent reply?" check
  // counts it — an agent did.
  const entry = {
    sid: sent.sid, from: meta ? meta.number : cfg!.whatsappFrom.replace(/^whatsapp:/, ''), to,
    body: renderTemplate(t, v.vars), at: new Date().toISOString(),
    sentBy: access.member.email, direction: 'outbound' as const,
    status: sent.status || 'queued', template: t.name,
  }
  const { error } = await writeControlRow({ sessionId: id, siteId: access.siteId, role: CRM_WA_OUT_ROLE, message: JSON.stringify(entry) })
  return NextResponse.json({ ok: true, sent: true, recorded: !error, status: sent.status })
}
