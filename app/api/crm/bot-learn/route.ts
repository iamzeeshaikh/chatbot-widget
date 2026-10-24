import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { learnFromTeam, readLessons, writeLessons, type BotLesson } from '@/lib/botlearn'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// The quote bot's daily lesson from the team (lib/botlearn.ts).
//   GET            cron (Bearer CRON_SECRET) or an admin: learn from the last day
//   GET ?dry=1     what it would learn, nothing stored
//   GET ?list=1    the lessons as they stand
//   POST {action:'remove', id} | {action:'add', text}   admin edits
async function who(req: NextRequest): Promise<{ ok: boolean; by: string; admin: boolean }> {
  const secret = process.env.CRON_SECRET
  if (secret && (req.headers.get('authorization') === `Bearer ${secret}` || req.headers.get('x-cron-secret') === secret)) return { ok: true, by: 'cron', admin: false }
  const m = await getMember(req)
  if (m?.role === 'admin' && hasFeature(m.workspace, 'quotebot')) return { ok: true, by: m.email, admin: true }
  return { ok: false, by: '', admin: false }
}

export async function GET(req: NextRequest) {
  const w = await who(req)
  if (!w.ok) return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  if (req.nextUrl.searchParams.get('list') === '1') return NextResponse.json(await readLessons())
  const dry = req.nextUrl.searchParams.get('dry') === '1'
  const hours = Math.min(24 * 30, Math.max(1, Number(req.nextUrl.searchParams.get('hours')) || 26))
  return NextResponse.json(await learnFromTeam({ dryRun: dry, hours }))
}

export async function POST(req: NextRequest) {
  const w = await who(req)
  if (!w.ok || !w.admin) return NextResponse.json({ error: 'Not allowed' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const cur = await readLessons()
  let lessons: BotLesson[] = cur.lessons
  if (body.action === 'remove') lessons = lessons.filter((l) => l.id !== body.id)
  else if (body.action === 'add') {
    const text = String(body.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 260)
    if (text.length < 8) return NextResponse.json({ error: 'Write the lesson in a sentence.' }, { status: 400 })
    lessons = [{ id: `bl_${Date.now().toString(36)}_o`, text, from: 'owner', at: new Date().toISOString() }, ...lessons]
  } else return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  const next = { ...cur, lessons, at: new Date().toISOString(), by: w.by }
  await writeLessons(next)
  return NextResponse.json(next)
}
