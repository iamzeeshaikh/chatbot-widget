'use client'

// ZeeDesk's home screen: every website the team answers for on one page, with
// what is happening on each (owner, 25 Nov: "dashboard to hona chahie"). The
// numbers come from the same workspace-scoped endpoints the other screens use:
// /api/admin/sites, /api/admin/visitors-history (7 days), /api/visitor/active
// and /api/admin/leads-list. Nothing here decides whose data is shown.

import { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Eye, MessageSquare, Contact, Radio } from 'lucide-react'
import { SITE_DOMAINS } from '@/lib/sitedomains'
import { timeAgo, formatDateTime } from '@/lib/datetime'
import { PageHead, Chip, Empty, type ZdScreenProps } from '../ui'

interface Site { site_id: string; name: string; primary_color: string | null }
interface Visit { session_id: string; site_id: string; created_at: string; last_seen: string; has_chat?: boolean }
interface Live { session_id: string; site_id: string }
interface Lead { id: string; site_id: string; name: string | null; email: string | null; phone: string | null; product?: string | null; message: string | null; created_at: string; session_id?: string | null; notALead?: boolean }
export interface WaitingChat { session_id: string; site_id: string; site_name: string; preview: string; last_at: string; name: string }

const DAY = 86_400_000
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export default function Dashboard({ me, openLead, openChat, waiting }: ZdScreenProps & { waiting: WaitingChat[] }) {
  const [sites, setSites] = useState<Site[] | null>(null)
  // null until the first answer: a card must not say "No visits" while loading.
  const [visits, setVisits] = useState<Visit[] | null>(null)
  const [live, setLive] = useState<Live[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  // The clock the 'today' and '7 days' figures are measured against; moved on
  // with each refresh, never read during render.
  const [now, setNow] = useState(0)

  useEffect(() => {
    const get = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    get('/api/admin/sites').then((d) => setSites(d?.sites ?? []))
    get('/api/admin/leads-list').then((d) => setLeads((d?.leads ?? []).filter((l: Lead) => !l.notALead)))
    const load = () => {
      get('/api/admin/visitors-history').then((d) => { setNow(Date.now()); if (d) setVisits(d.visitors ?? []) })
      get('/api/visitor/active').then((d) => { if (d) setLive(d.visitors ?? []) })
    }
    load()
    const t = setInterval(() => { if (!document.hidden) load() }, 30_000)
    return () => clearInterval(t)
  }, [])

  const days = useMemo(() => (now ? Array.from({ length: 7 }, (_, i) => dayKey(now - (6 - i) * DAY)) : []), [now])

  const rows = useMemo(() => {
    const mine = new Set(me.sites)
    return (sites ?? []).filter((s) => mine.size === 0 || mine.has(s.site_id)).map((s) => {
      const v = (visits ?? []).filter((x) => x.site_id === s.site_id)
      const perDay = days.map((d) => v.filter((x) => (x.created_at || '').slice(0, 10) === d).length)
      const last = v.reduce((m, x) => Math.max(m, new Date(x.last_seen || x.created_at).getTime() || 0), 0)
      const l = leads.filter((x) => x.site_id === s.site_id)
      return {
        site: s,
        domain: SITE_DOMAINS[s.site_id] ?? '',
        visitors7: v.length,
        today: perDay[6] ?? 0,
        perDay: perDay.length ? perDay : [0, 0, 0, 0, 0, 0, 0],
        chats7: v.filter((x) => x.has_chat).length,
        live: live.filter((x) => x.site_id === s.site_id).length,
        leads7: l.filter((x) => now > 0 && now - new Date(x.created_at).getTime() < 7 * DAY).length,
        leadsAll: l.length,
        last,
      }
    }).sort((a, b) => b.live - a.live || b.visitors7 - a.visitors7)
  }, [sites, visits, live, leads, days, me.sites, now])

  const total = {
    live: live.length,
    visitors7: (visits ?? []).length,
    today: (visits ?? []).filter((x) => (x.created_at || '').slice(0, 10) === days[6]).length,
    leads7: leads.filter((x) => now > 0 && now - new Date(x.created_at).getTime() < 7 * DAY).length,
  }
  const recent = [...leads].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6)

  return (
    <main className="flex-1 min-w-0 overflow-y-auto bg-[#f8f9f9]">
      <PageHead title="Dashboard" sub={`${rows.length} websites · visitors over the last 7 days`} />
      <div className="px-6 pb-10 space-y-6">
        <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Totals">
          <Stat icon={<Radio size={16} />} label="On your sites now" value={total.live} accent />
          <Stat icon={<Eye size={16} />} label="Visitors today" value={total.today} hint={`${total.visitors7.toLocaleString()} in 7 days`} />
          <Stat icon={<MessageSquare size={16} />} label="Chats waiting" value={waiting.length} warn={waiting.length > 0} />
          <Stat icon={<Contact size={16} />} label="New leads, 7 days" value={total.leads7} hint={`${leads.length} in total`} />
        </section>

        <section aria-label="Websites">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-[#68737d]">Your websites</h2>
          {sites === null ? <p className="text-[13px] text-[#68737d]">Loading…</p> : rows.length === 0 ? <Empty text="No websites are set up for this team yet." /> : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {rows.map((r) => <SiteCard key={r.site.site_id} r={r} now={now} loading={visits === null} />)}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section aria-label="Chats waiting" className="rounded-xl border border-[#d8dcde] bg-white">
            <h2 className="px-4 pt-4 pb-2 text-[13px] font-semibold uppercase tracking-wide text-[#68737d]">Chats waiting for a reply</h2>
            {waiting.length === 0 ? <p className="px-4 pb-4 text-[13px] text-[#68737d]">None right now.</p> : (
              <ul>{waiting.slice(0, 6).map((c) => (
                <li key={c.session_id}>
                  <button type="button" onClick={() => openChat(c.session_id)} className="w-full border-t border-[#e9ebed] px-4 py-3 text-left hover:bg-[#f8f9f9]">
                    <span className="flex items-center gap-2"><span className="font-medium">{c.name}</span><span className="text-[12px] text-[#87929d]">{c.site_name} · {timeAgo(c.last_at)}</span></span>
                    <span className="block truncate text-[13px] text-[#49545c]">{c.preview}</span>
                  </button>
                </li>
              ))}</ul>
            )}
          </section>
          <section aria-label="Latest leads" className="rounded-xl border border-[#d8dcde] bg-white">
            <h2 className="px-4 pt-4 pb-2 text-[13px] font-semibold uppercase tracking-wide text-[#68737d]">Latest leads</h2>
            {recent.length === 0 ? <p className="px-4 pb-4 text-[13px] text-[#68737d]">No leads yet.</p> : (
              <ul>{recent.map((l) => (
                <li key={l.id}>
                  <button type="button" onClick={() => openLead(l.session_id || `quote-${l.id}`)} className="w-full border-t border-[#e9ebed] px-4 py-3 text-left hover:bg-[#f8f9f9]">
                    <span className="flex items-center gap-2"><span className="font-medium">{l.name || l.email || l.phone || 'No name given'}</span><span className="text-[12px] text-[#87929d]">{l.site_id} · {formatDateTime(l.created_at)}</span></span>
                    <span className="block truncate text-[13px] text-[#49545c]">{l.product || (l.message ?? '').replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').slice(0, 90) || 'Not stated'}</span>
                  </button>
                </li>
              ))}</ul>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

function Stat({ icon, label, value, hint, accent, warn }: { icon: React.ReactNode; label: string; value: number; hint?: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? 'border-[#03363d] bg-[#03363d] text-white' : 'border-[#d8dcde] bg-white'}`}>
      <p className={`flex items-center gap-1.5 text-[12px] font-medium ${accent ? 'text-white/70' : 'text-[#68737d]'}`}>{icon}{label}</p>
      <p className={`mt-2 text-[28px] font-semibold leading-none tabular-nums ${warn ? 'text-[#cc3340]' : ''}`}>{value.toLocaleString()}</p>
      {hint && <p className={`mt-1.5 text-[12px] ${accent ? 'text-white/60' : 'text-[#87929d]'}`}>{hint}</p>}
    </div>
  )
}

type Row = { site: Site; domain: string; visitors7: number; today: number; perDay: number[]; chats7: number; live: number; leads7: number; leadsAll: number; last: number }

function SiteCard({ r, now, loading }: { r: Row; now: number; loading: boolean }) {
  const max = Math.max(1, ...r.perDay)
  const quiet = loading ? 'loading' : r.last === 0 ? 'none' : now - r.last > DAY ? 'quiet' : 'ok'
  return (
    <article className="min-w-0 rounded-xl border border-[#d8dcde] bg-white p-4 flex flex-col gap-3">
      <header className="flex items-start gap-2.5">
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.site.primary_color || '#1f73b7' }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{r.site.name}</p>
          {r.domain ? (
            <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[12px] text-[#1f73b7] hover:underline">{r.domain}<ArrowUpRight size={12} /></a>
          ) : <p className="text-[12px] text-[#87929d]">{r.site.site_id}</p>}
        </div>
        {r.live > 0 ? <Chip tone="green">{r.live} live</Chip>
          : quiet === 'none' ? <Chip tone="red">No visits</Chip>
          : quiet === 'quiet' ? <Chip tone="amber">Quiet 24h</Chip> : null}
      </header>
      <div className="flex items-end gap-1 h-10" aria-label={`Visitors per day, last 7 days: ${r.perDay.join(', ')}`}>
        {r.perDay.map((n, i) => (
          <span key={i} className="flex-1 rounded-sm" style={{ height: `${Math.max(6, (n / max) * 100)}%`, backgroundColor: i === 6 ? '#1f73b7' : n ? '#c5e0f6' : '#e9ebed' }} title={`${n} visitor${n === 1 ? '' : 's'}`} />
        ))}
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Fig label="Today" value={r.today} />
        <Fig label="7 days" value={r.visitors7} />
        <Fig label="Leads 7d" value={r.leads7} strong={r.leads7 > 0} />
      </dl>
      <p className="text-[12px] text-[#87929d]">{loading ? 'Loading visits…' : r.last ? `Last visit ${timeAgo(new Date(r.last).toISOString())}` : 'No visit in 7 days'}{r.chats7 ? ` · ${r.chats7} chat${r.chats7 === 1 ? '' : 's'}` : ''}</p>
    </article>
  )
}

function Fig({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="rounded-lg bg-[#f8f9f9] py-2">
      <dt className="text-[11px] text-[#68737d]">{label}</dt>
      <dd className={`text-[17px] font-semibold tabular-nums ${strong ? 'text-[#038153]' : ''}`}>{value}</dd>
    </div>
  )
}
