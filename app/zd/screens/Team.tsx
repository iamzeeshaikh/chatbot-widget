'use client'

// ZeeDesk: the team and its settings. Three views behind one rail entry:
//
//   People        (admins)   who is on the team, what they may see, their
//                            passwords, and removing them
//   Your profile  (everyone) the member's own email signature, their Gmail
//                            connection and the alert sound
//   Sites         (admins)   the websites this team answers for, the code that
//                            puts the chat on each one, and the business
//                            details every agent's mail carries for it
//
// Every list here comes from an endpoint that scopes itself to the signed-in
// member's workspace. This file never filters by workspace and never widens a
// list: what the server returns is what is shown.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  Building2, Check, Copy, Globe, KeyRound, Loader2, Mail, PenLine, Pencil, Play, RefreshCw, Trash2, UserPlus, Volume2, VolumeX,
} from 'lucide-react'
import { formatDate, formatDateTime, timeAgo } from '@/lib/datetime'
import { hasFeature, isWorkspace } from '@/lib/workspaces'
import { replyDing, unlockSound } from '../sound'
import {
  Avatar, Chip, Drawer, Empty, Notice, PageHead, Table, postJson, short,
  BTN_DANGER, BTN_PLAIN, BTN_PRIMARY, CARD, INPUT, LABEL, TEXTAREA,
  type Me, type ZdScreenProps,
} from '../ui'

// ── Shapes, exactly as the endpoints return them ─────────────────────────────
type Role = 'admin' | 'standard'
interface Member {
  id: string; email: string; role: Role; assigned_sites: string[]; created_at: string
  /** The name a customer sees on this member's chat replies. */
  display_name: string
  /** 'set' when somebody chose it, 'derived' when it was read off the address. */
  display_name_source: 'set' | 'derived'
  own_leads_only?: boolean
  hide_contacts?: boolean
}
interface Site { site_id: string; name: string; bot_name: string | null; primary_color: string | null }
interface Presence { email: string; online: boolean; lastSeen: string | null }
interface AgentSig { email: string; name: string; title: string; phone: string }
interface SiteContact { siteId: string; company: string; phone: string; website: string; address: string; logo?: string }
interface SignatureData { agent: AgentSig | null; sites: SiteContact[]; signature?: string; signatureHtml?: string }
interface GmailAlias { email: string; displayName?: string; isPrimary?: boolean; isDefault?: boolean }
interface GmailStatus {
  connected: boolean; available?: boolean; configured?: boolean; reason?: string | null; needsReconnect?: boolean
  connectedAt?: string; aliases?: GmailAlias[]; canReadReplies?: boolean; rateLimited?: boolean
}

type Tab = 'people' | 'profile' | 'sites'

// The widget as ZeeDesk sites load it (app/w.js/route.ts serves it on this host only).
const WIDGET_SRC = 'https://chat.zeedesk.dev/w.js'
const snippetFor = (siteId: string) => `<script src="${WIDGET_SRC}?siteId=${encodeURIComponent(siteId)}" async></script>`
const MAX_DISPLAY_NAME = 40
const MIN_PASSWORD = 6

/** Server messages are written for the other dashboard. Nothing on a ZeeDesk
 *  screen names it or its host. */
function clean(text: unknown): string {
  return typeof text === 'string'
    ? text.replace(/chat\.zeeops\.dev/gi, 'chat.zeedesk.dev').replace(/\bzeeops\b/gi, 'this app').trim()
    : ''
}

type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

/** One fetch wrapper for the whole screen: a failure always comes back as a
 *  sentence that can be put in front of the member. */
async function api<T>(url: string, init?: RequestInit, fallback = 'That did not work. Try again.'): Promise<Result<T>> {
  try {
    const r = await fetch(url, init)
    const body = await r.json().catch(() => null)
    if (!r.ok) {
      if (r.status === 401) return { ok: false, status: 401, error: 'Your session has ended. Sign in again to continue.' }
      return { ok: false, status: r.status, error: clean(body?.error) || fallback }
    }
    return { ok: true, data: (body ?? {}) as T }
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check your connection and try again.' }
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function readGmailReturn(): { ok: boolean; text: string } | null {
  if (typeof window === 'undefined') return null
  const sp = new URLSearchParams(window.location.search)
  const g = sp.get('gmail')
  if (g === 'connected') return { ok: true, text: 'Gmail is connected. You can now send email from a lead’s record.' }
  if (g === 'error') return { ok: false, text: clean(sp.get('reason')) || 'Gmail could not be connected. Try again.' }
  if (g === 'unavailable') return { ok: false, text: 'Email is not turned on for this team.' }
  return null
}

// ── The screen ───────────────────────────────────────────────────────────────
export default function Team({ me }: ZdScreenProps) {
  const isAdmin = me.role === 'admin'
  const emailOn = isWorkspace(me.workspace) && hasFeature(me.workspace, 'email')

  // Coming back from Google's consent screen lands on the profile, where the
  // result is shown.
  const [gmailReturn] = useState(readGmailReturn)
  const [tab, setTab] = useState<Tab>(isAdmin && !gmailReturn ? 'people' : 'profile')

  const [members, setMembers] = useState<Member[] | null>(null)
  const [membersError, setMembersError] = useState('')
  const [sites, setSites] = useState<Site[] | null>(null)
  const [sitesError, setSitesError] = useState('')
  const [presence, setPresence] = useState<Presence[]>([])
  const [leads, setLeads] = useState<string[]>([])

  const [sig, setSig] = useState<SignatureData | null>(null)
  const [sigError, setSigError] = useState('')

  const loadMembers = useCallback(async () => {
    const r = await api<{ members: Member[] }>('/api/admin/members', undefined, 'The team list could not be loaded.')
    if (r.ok) { setMembers(r.data.members ?? []); setMembersError('') } else setMembersError(r.error)
  }, [])
  const loadSites = useCallback(async () => {
    const r = await api<{ sites: Site[] }>('/api/admin/sites', undefined, 'The site list could not be loaded.')
    if (r.ok) { setSites(r.data.sites ?? []); setSitesError('') } else setSitesError(r.error)
  }, [])
  const loadPresence = useCallback(async () => {
    const r = await api<{ agents: Presence[] }>('/api/admin/presence')
    if (r.ok) setPresence(r.data.agents ?? [])
  }, [])
  const loadLeads = useCallback(async () => {
    const r = await api<{ leads: string[] }>('/api/admin/team-lead')
    if (r.ok) setLeads((r.data.leads ?? []).map((e) => e.toLowerCase()))
  }, [])
  const loadSig = useCallback(async () => {
    const r = await api<SignatureData>('/api/signature', undefined, 'Your signature could not be loaded.')
    if (r.ok) { setSig({ agent: r.data.agent ?? null, sites: r.data.sites ?? [] }); setSigError('') } else setSigError(r.error)
  }, [])

  useEffect(() => {
    const first = setTimeout(() => {
      if (isAdmin) { void loadMembers(); void loadSites(); void loadPresence(); void loadLeads() }
      if (emailOn) void loadSig()
    }, 0)
    return () => clearTimeout(first)
  }, [isAdmin, emailOn, loadMembers, loadSites, loadPresence, loadLeads, loadSig])

  // Who is online moves on its own; once a minute is plenty for a settings screen.
  useEffect(() => {
    if (!isAdmin || tab !== 'people') return
    const t = setInterval(() => { if (!document.hidden) void loadPresence() }, 60000)
    return () => clearInterval(t)
  }, [isAdmin, tab, loadPresence])

  const tabs: { key: Tab; label: string; count?: number }[] = isAdmin
    ? [
        { key: 'people', label: 'People', count: members ? peopleCount(members, presence, me) : undefined },
        { key: 'profile', label: 'Your profile' },
        { key: 'sites', label: 'Sites', count: sites?.length },
      ]
    : [{ key: 'profile', label: 'Your profile' }]
  const shown: Tab = isAdmin ? tab : 'profile'

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <PageHead
        title={isAdmin ? 'Team' : 'Your profile'}
        sub={isAdmin ? 'The people on this team, your own settings and the sites you answer for.' : 'Your email signature, Gmail connection and alert sound.'}
      />
      {tabs.length > 1 && (
        <div className="px-6 border-b border-[#d8dcde] flex gap-5" role="tablist" aria-label="Team sections">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" id={`zd-team-tab-${t.key}`} aria-selected={shown === t.key} aria-controls="zd-team-panel"
              onClick={() => setTab(t.key)}
              className={`relative -mb-px h-10 text-[13px] font-medium border-b-2 outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 rounded-t ${shown === t.key ? 'border-[#1f73b7] text-[#1f73b7]' : 'border-transparent text-[#68737d] hover:text-[#2f3941]'}`}>
              {t.label}
              {t.count !== undefined && <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-[#e9ebed] text-[#49545c] text-[11px] tabular-nums">{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      <div id="zd-team-panel" role={tabs.length > 1 ? 'tabpanel' : undefined} aria-labelledby={tabs.length > 1 ? `zd-team-tab-${shown}` : undefined} className="px-6 pt-5 pb-10">
        {shown === 'people' && (
          <People me={me} members={members} setMembers={setMembers} error={membersError} sites={sites ?? []}
            presence={presence} leads={leads} setLeads={setLeads} reload={loadMembers} openSites={() => setTab('sites')} />
        )}
        {shown === 'profile' && (
          <Profile me={me} isAdmin={isAdmin} emailOn={emailOn} sig={sig} sigError={sigError} reloadSig={loadSig}
            siteNames={siteNameMap(sites)} gmailReturn={gmailReturn}
            onAgentSaved={(agent) => setSig((cur) => (cur ? { ...cur, agent } : cur))} />
        )}
        {shown === 'sites' && (
          <Sites sites={sites} error={sitesError} reload={loadSites} emailOn={emailOn} contacts={sig?.sites ?? []}
            onContactSaved={(c) => setSig((cur) => (cur ? { ...cur, sites: cur.sites.some((x) => x.siteId === c.siteId) ? cur.sites.map((x) => (x.siteId === c.siteId ? c : x)) : [...cur.sites, c] } : cur))} />
        )}
      </div>
    </main>
  )
}

function siteNameMap(sites: Site[] | null): Record<string, string> {
  return Object.fromEntries((sites ?? []).map((s) => [s.site_id, s.name]))
}

/** Accounts that can sign in but are not rows in the team list: the built-in
 *  admin this workspace was set up with. Shown so the list is the whole team. */
function builtInAccounts(members: Member[], presence: Presence[], me: Me): string[] {
  const out: string[] = []
  const add = (email: string) => {
    if (!email || members.some((m) => same(m.email, email)) || out.some((e) => same(e, email))) return
    out.push(email)
  }
  for (const p of presence) add(p.email)
  if (me.role === 'admin') add(me.email)
  return out
}
function peopleCount(members: Member[], presence: Presence[], me: Me): number {
  return members.length + builtInAccounts(members, presence, me).length
}

// ── Small shared pieces ──────────────────────────────────────────────────────
function Spinner({ text }: { text: string }) {
  return <p className="flex items-center gap-2 py-8 text-[13px] text-[#68737d]" role="status"><Loader2 size={15} className="animate-spin" aria-hidden />{text}</p>
}

function LoadFailed({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div className={`${CARD} px-5 py-4 flex flex-wrap items-center gap-3`}>
      <Notice text={text} bad />
      <button type="button" className={`${BTN_PLAIN} ml-auto`} onClick={retry}><RefreshCw size={14} aria-hidden />Try again</button>
    </div>
  )
}

function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId()
  return (
    <div className="flex items-start gap-3">
      <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined}
        disabled={disabled} onClick={() => onChange(!checked)}
        className={`mt-0.5 relative w-9 h-5 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#1f73b7]/40 disabled:opacity-40 ${checked ? 'bg-[#1f73b7]' : 'bg-[#c2c8cc]'}`}>
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} aria-hidden />
      </button>
      <div className="min-w-0">
        <p id={`${id}-l`} className="text-[13px] font-medium text-[#2f3941]">{label}</p>
        {hint && <p id={`${id}-h`} className="text-[12px] text-[#68737d]">{hint}</p>}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-[12px] text-[#68737d]">{hint}</p>}
    </div>
  )
}

function CardHead({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-start gap-2.5 mb-4">
      <span className="mt-0.5 text-[#68737d]" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-[#2f3941]">{title}</h2>
        {sub && <p className="text-[12px] text-[#68737d]">{sub}</p>}
      </div>
    </div>
  )
}

function RoleSelect({ id, value, onChange }: { id: string; value: Role; onChange: (r: Role) => void }) {
  return (
    <select id={id} className={INPUT} value={value} onChange={(e) => onChange(e.target.value === 'admin' ? 'admin' : 'standard')}>
      <option value="standard">Standard: works chats and leads</option>
      <option value="admin">Admin: everything, including this screen</option>
    </select>
  )
}

/** Which sites a standard member covers. Nothing ticked means all of them,
 *  including any added later; that is the server's rule, said here in words. */
function SitePicker({ sites, value, onChange }: { sites: Site[]; value: string[]; onChange: (next: string[]) => void }) {
  if (sites.length === 0) {
    return <p className="text-[13px] text-[#68737d]">No sites are connected yet, so there is nothing to pick. This member will cover every site as it is added.</p>
  }
  return (
    <fieldset>
      <legend className={LABEL}>Sites</legend>
      <p className="mb-2 text-[12px] text-[#68737d]">
        {value.length === 0
          ? 'Nothing ticked: this member covers every site, including any added later.'
          : `Only the ${value.length} ticked site${value.length === 1 ? '' : 's'}. Clear them all to cover every site.`}
      </p>
      <div className="max-h-56 overflow-y-auto rounded-md border border-[#d8dcde] divide-y divide-[#e9ebed] [scrollbar-width:thin]">
        {sites.map((s) => {
          const on = value.includes(s.site_id)
          return (
            <label key={s.site_id} className="flex items-center gap-2.5 px-3 py-2 text-[13px] cursor-pointer hover:bg-[#f8f9f9]">
              <input type="checkbox" className="accent-[#1f73b7]" checked={on}
                onChange={() => onChange(on ? value.filter((x) => x !== s.site_id) : [...value, s.site_id])} />
              <span className="truncate">{s.name}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function PasswordInput({ id, value, onChange, autoFocus }: { id: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const [show, setShow] = useState(false)
  return (
    <div className="flex gap-2">
      <input id={id} type={show ? 'text' : 'password'} className={INPUT} value={value} autoFocus={autoFocus}
        autoComplete="new-password" minLength={MIN_PASSWORD} placeholder={`At least ${MIN_PASSWORD} characters`}
        onChange={(e) => onChange(e.target.value)} />
      <button type="button" className={`${BTN_PLAIN} h-9 shrink-0`} aria-pressed={show} onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
    </div>
  )
}

// ── People ───────────────────────────────────────────────────────────────────
function People({ me, members, setMembers, error, sites, presence, leads, setLeads, reload, openSites }: {
  me: Me
  members: Member[] | null
  setMembers: React.Dispatch<React.SetStateAction<Member[] | null>>
  error: string
  sites: Site[]
  presence: Presence[]
  leads: string[]
  setLeads: React.Dispatch<React.SetStateAction<string[]>>
  reload: () => Promise<void>
  openSites: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [accessError, setAccessError] = useState('')
  const [busyFlag, setBusyFlag] = useState('')

  if (!members) return error ? <LoadFailed text={error} retry={() => void reload()} /> : <Spinner text="Loading the team…" />

  const builtIns = builtInAccounts(members, presence, me)
  const seen = (email: string) => presence.find((p) => same(p.email, email))
  const online = presence.filter((p) => p.online).length
  const total = members.length + builtIns.length
  const siteName = (id: string) => sites.find((s) => s.site_id === id)?.name ?? id
  const editing = members.find((m) => m.id === editId) ?? null
  const isLead = (email: string) => leads.includes(email.toLowerCase())

  async function remove(m: Member) {
    const index = members ? members.findIndex((x) => x.id === m.id) : -1
    setConfirmId(null); setNote(null)
    // Gone from the list at once; put back exactly where it was if the server refuses.
    setMembers((cur) => (cur ? cur.filter((x) => x.id !== m.id) : cur))
    const r = await api('/api/admin/members', postJson({ id: m.id }, 'DELETE'), 'That member could not be removed.')
    if (!r.ok) {
      setMembers((cur) => {
        if (!cur || cur.some((x) => x.id === m.id)) return cur
        const next = [...cur]; next.splice(Math.max(0, Math.min(index, next.length)), 0, m)
        return next
      })
      setNote({ text: `${m.display_name} was not removed. ${r.error}`, bad: true })
      return
    }
    setNote({ text: `${m.display_name} was removed and can no longer sign in.` })
  }

  async function setFlag(m: Member, key: 'own_leads_only' | 'hide_contacts', on: boolean) {
    setAccessError(''); setBusyFlag(key)
    const before = !!m[key]
    setMembers((cur) => (cur ? cur.map((x) => (x.id === m.id ? { ...x, [key]: on } : x)) : cur))
    const r = await api('/api/admin/members', postJson({ id: m.id, [key]: on }, 'PATCH'), 'That setting could not be changed.')
    setBusyFlag('')
    if (!r.ok) {
      setMembers((cur) => (cur ? cur.map((x) => (x.id === m.id ? { ...x, [key]: before } : x)) : cur))
      setAccessError(r.error)
    }
  }

  async function setTeamLead(m: Member, on: boolean) {
    const e = m.email.toLowerCase()
    setAccessError(''); setBusyFlag('lead')
    setLeads((cur) => (on ? (cur.includes(e) ? cur : [...cur, e]) : cur.filter((x) => x !== e)))
    const r = await api('/api/admin/team-lead', postJson({ email: m.email, lead: on }), 'That setting could not be changed.')
    setBusyFlag('')
    if (!r.ok) {
      setLeads((cur) => (on ? cur.filter((x) => x !== e) : (cur.includes(e) ? cur : [...cur, e])))
      setAccessError(r.error)
    }
  }

  const status = (email: string) => {
    const p = seen(email)
    if (p?.online) return <span className="inline-flex items-center gap-1.5 text-[#038153]"><span className="w-2 h-2 rounded-full bg-[#038153]" aria-hidden />Online</span>
    if (p?.lastSeen) return <span title={formatDateTime(p.lastSeen)}>Seen {timeAgo(p.lastSeen)}</span>
    return <span className="text-[#87929d]">Not seen recently</span>
  }
  const cell = 'px-4 py-2.5 align-middle text-[#49545c]'

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-[#68737d]">{total} {total === 1 ? 'person' : 'people'} · {online} online now</p>
        <button type="button" className={`${BTN_PRIMARY} ml-auto`} onClick={() => { setAdding(true); setNote(null) }}><UserPlus size={15} aria-hidden />Add member</button>
      </div>
      {error && <div className="mb-3"><Notice text={`The list may be out of date. ${error}`} bad /></div>}
      {note && <div className="mb-3"><Notice text={note.text} bad={note.bad} /></div>}

      <Table head={['Member', 'Role', 'Sites', 'Status', 'Added', 'Actions']}>
        {builtIns.map((email) => (
          <tr key={`builtin-${email}`} className="border-t border-[#e9ebed]">
            <td className={cell}>
              <div className="flex items-center gap-2.5 min-w-0">
                <Avatar label={short(email)} tone="agent" size={28} />
                <div className="min-w-0">
                  <p className="font-medium text-[#2f3941] truncate">{short(email)}{same(email, me.email) && <span className="font-normal text-[#68737d]"> (you)</span>}</p>
                  <p className="text-[12px] text-[#68737d] truncate">{email}</p>
                </div>
              </div>
            </td>
            <td className={cell}><div className="flex flex-wrap gap-1"><Chip tone="blue">Admin</Chip><Chip>Built-in</Chip></div></td>
            <td className={cell}>All sites</td>
            <td className={`${cell} whitespace-nowrap`}>{status(email)}</td>
            <td className={`${cell} whitespace-nowrap`}>With the workspace</td>
            <td className={`${cell} text-[12px] text-[#68737d]`}>Cannot be edited or removed here</td>
          </tr>
        ))}
        {members.map((m) => {
          const self = same(m.email, me.email)
          return (
            <tr key={m.id} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9]">
              <td className={cell}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar label={m.display_name || short(m.email)} tone="agent" size={28} />
                  <div className="min-w-0">
                    <p className="font-medium text-[#2f3941] truncate max-w-[240px]">{m.display_name || short(m.email)}{self && <span className="font-normal text-[#68737d]"> (you)</span>}</p>
                    <p className="text-[12px] text-[#68737d] truncate max-w-[240px]">{m.email}</p>
                  </div>
                </div>
              </td>
              <td className={cell}>
                <div className="flex flex-wrap gap-1 max-w-[220px]">
                  <Chip tone={m.role === 'admin' ? 'blue' : 'grey'}>{m.role === 'admin' ? 'Admin' : 'Standard'}</Chip>
                  {m.role !== 'admin' && isLead(m.email) && <Chip tone="amber">Team lead</Chip>}
                  {m.role !== 'admin' && m.own_leads_only && <Chip>Own leads only</Chip>}
                  {m.role !== 'admin' && m.hide_contacts && <Chip>Contacts hidden</Chip>}
                </div>
              </td>
              <td className={cell}>
                {m.role === 'admin' || m.assigned_sites.length === 0 ? 'All sites' : (
                  <div className="flex flex-wrap gap-1 max-w-[260px]">{m.assigned_sites.map((id) => <Chip key={id}>{siteName(id)}</Chip>)}</div>
                )}
              </td>
              <td className={`${cell} whitespace-nowrap`}>{status(m.email)}</td>
              <td className={`${cell} whitespace-nowrap`} title={formatDateTime(m.created_at)}>{formatDate(m.created_at)}</td>
              <td className={cell}>
                {confirmId === m.id ? (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Confirm removing ${m.display_name}`}>
                    <span className="text-[12px] text-[#cc3340] max-w-[220px]">Remove {m.display_name}? They are signed out and cannot sign in again.</span>
                    <button type="button" className={BTN_DANGER} autoFocus onClick={() => void remove(m)}>Remove</button>
                    <button type="button" className={BTN_PLAIN} onClick={() => setConfirmId(null)}>Keep</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button type="button" className={BTN_PLAIN} aria-label={`Edit ${m.display_name}`} onClick={() => { setEditId(m.id); setAccessError(''); setNote(null) }}><Pencil size={14} aria-hidden />Edit</button>
                    {!self && (
                      <button type="button" className={BTN_PLAIN} aria-label={`Remove ${m.display_name}`} onClick={() => setConfirmId(m.id)}><Trash2 size={14} aria-hidden />Remove</button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          )
        })}
      </Table>

      {members.length === 0 && (
        <div className={`${CARD} mt-4 px-5 py-4`}>
          <p className="text-[14px] font-semibold text-[#2f3941]">Add your first agent</p>
          <p className="mt-1 text-[13px] text-[#68737d] max-w-2xl">
            So far only the built-in admin account can sign in. Give each person their own email and password with Add member, so chats and leads show who is handling them.
            {sites.length === 0 && ' No site is connected yet either: see the Sites tab for what is needed before chats can arrive.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={BTN_PLAIN} onClick={() => setAdding(true)}><UserPlus size={14} aria-hidden />Add member</button>
            {sites.length === 0 && <button type="button" className={BTN_PLAIN} onClick={openSites}><Globe size={14} aria-hidden />Go to Sites</button>}
          </div>
        </div>
      )}

      {adding && (
        <AddMember sites={sites} onClose={() => setAdding(false)}
          onAdded={(email) => { setAdding(false); setNote({ text: `${email} was added. Pass the password on privately; it is not shown again.` }); void reload() }} />
      )}
      {editing && (
        <EditMember key={editing.id} member={editing} self={same(editing.email, me.email)} sites={sites}
          teamLead={isLead(editing.email)} accessError={accessError} busyFlag={busyFlag}
          onFlag={(key, on) => void setFlag(editing, key, on)} onTeamLead={(on) => void setTeamLead(editing, on)}
          onClose={() => setEditId(null)}
          onSaved={() => { setEditId(null); setNote({ text: `Changes to ${editing.email} were saved.` }); void reload() }} />
      )}
    </>
  )
}

function AddMember({ sites, onClose, onAdded }: { sites: Site[]; onClose: () => void; onAdded: (email: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('standard')
  const [picked, setPicked] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const formId = useId()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) { setError('Enter the member’s email address.'); return }
    if (password.length < MIN_PASSWORD) { setError(`The password needs at least ${MIN_PASSWORD} characters.`); return }
    setSaving(true); setError('')
    const r = await api('/api/admin/members', postJson({ email: addr, password, role, assigned_sites: role === 'admin' ? [] : picked }), 'The member could not be added.')
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    setPassword('')
    onAdded(addr)
  }

  return (
    <Drawer title="Add member" onClose={onClose} footer={
      <>
        <button type="button" className={BTN_PLAIN} onClick={onClose}>Cancel</button>
        <button type="submit" form={formId} className={BTN_PRIMARY} disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" aria-hidden />}{saving ? 'Adding…' : 'Add member'}</button>
      </>
    }>
      <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Email" hint="They sign in with this address.">
          {(id) => <input id={id} type="email" required autoFocus autoComplete="off" className={INPUT} value={email} placeholder="name@yourcompany.com" onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Password" hint="Choose one and pass it on privately. It cannot be read back later, only replaced.">
          {(id) => <PasswordInput id={id} value={password} onChange={setPassword} />}
        </Field>
        <Field label="Role">{(id) => <RoleSelect id={id} value={role} onChange={setRole} />}</Field>
        {role === 'admin'
          ? <p className="text-[13px] text-[#68737d]">An admin covers every site and can add, edit and remove members.</p>
          : <SitePicker sites={sites} value={picked} onChange={setPicked} />}
        <Notice text={error} bad />
      </form>
    </Drawer>
  )
}

function EditMember({ member, self, sites, teamLead, accessError, busyFlag, onFlag, onTeamLead, onClose, onSaved }: {
  member: Member; self: boolean; sites: Site[]; teamLead: boolean; accessError: string; busyFlag: string
  onFlag: (key: 'own_leads_only' | 'hide_contacts', on: boolean) => void
  onTeamLead: (on: boolean) => void
  onClose: () => void; onSaved: () => void
}) {
  // Only a name somebody chose is put in the box. A name read off the address
  // stays a placeholder, so opening and saving does not freeze a guess.
  const [name, setName] = useState(member.display_name_source === 'set' ? member.display_name : '')
  const [role, setRole] = useState<Role>(member.role)
  const [picked, setPicked] = useState<string[]>(member.assigned_sites ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwNote, setPwNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const formId = useId()

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    const r = await api('/api/admin/members', postJson({
      id: member.id, role,
      assigned_sites: role === 'admin' ? [] : picked,
      // Always sent, empty included: an empty box clears the chosen name and
      // the one read off the address is used again.
      display_name: name.trim(),
    }, 'PATCH'), 'The changes could not be saved.')
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    onSaved()
  }

  async function changePassword() {
    if (password.length < MIN_PASSWORD) { setPwNote({ text: `The password needs at least ${MIN_PASSWORD} characters.`, bad: true }); return }
    setPwBusy(true); setPwNote(null)
    const r = await api('/api/admin/members', postJson({ id: member.id, password }, 'PATCH'), 'The password could not be changed.')
    setPwBusy(false)
    if (!r.ok) { setPwNote({ text: r.error, bad: true }); return }
    setPassword('')
    setPwNote({ text: self
      ? 'Your password was changed. Every signed-in browser, this one included, is asked to sign in again within about a minute.'
      : 'The password was changed and their signed-in browsers are signed out within about a minute. Pass the new one on privately.' })
  }

  return (
    <Drawer title={`Edit ${member.email}`} onClose={onClose} footer={
      <>
        <button type="button" className={BTN_PLAIN} onClick={onClose}>Close</button>
        <button type="submit" form={formId} className={BTN_PRIMARY} disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" aria-hidden />}{saving ? 'Saving…' : 'Save changes'}</button>
      </>
    }>
      <form id={formId} onSubmit={save} className="space-y-4" noValidate>
        <Field label="Name shown to customers" hint="Appears on this member’s replies in the chat window. Leave it empty to use the name taken from the email address.">
          {(id) => <input id={id} className={INPUT} value={name} maxLength={MAX_DISPLAY_NAME} autoFocus placeholder={member.display_name_source === 'derived' ? member.display_name : short(member.email)} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Role" hint={self ? 'This is your own account. If you make it Standard you lose this screen as soon as you save.' : undefined}>
          {(id) => <RoleSelect id={id} value={role} onChange={setRole} />}
        </Field>
        {role === 'admin'
          ? <p className="text-[13px] text-[#68737d]">An admin covers every site.</p>
          : <SitePicker sites={sites} value={picked} onChange={setPicked} />}
        <Notice text={error} bad />
      </form>

      {member.role !== 'admin' && (
        <section className="mt-6 pt-5 border-t border-[#e9ebed]" aria-label="Lead access">
          <h3 className={LABEL}>Lead access</h3>
          <p className="mb-3 text-[12px] text-[#68737d]">These switches take effect as soon as you flip them.</p>
          <div className="space-y-3.5">
            <Switch checked={teamLead} disabled={busyFlag === 'lead'} onChange={onTeamLead}
              label="Team lead" hint="Sees every lead on the team without being an admin." />
            <Switch checked={!!member.own_leads_only} disabled={busyFlag === 'own_leads_only'} onChange={(on) => onFlag('own_leads_only', on)}
              label="Own leads only" hint="Sees only the leads assigned to them: no unassigned leads and nobody else’s." />
            <Switch checked={!!member.hide_contacts} disabled={busyFlag === 'hide_contacts'} onChange={(on) => onFlag('hide_contacts', on)}
              label="Hide customer contacts" hint="Works leads without ever seeing a customer’s email address or phone number." />
          </div>
          <div className="mt-2"><Notice text={accessError} bad /></div>
        </section>
      )}

      <section className="mt-6 pt-5 border-t border-[#e9ebed]" aria-label="Password">
        <h3 className={LABEL}>Password</h3>
        <p className="mb-2 text-[12px] text-[#68737d]">The current password cannot be shown. Set a new one here and the old one stops working.</p>
        <Field label="New password">{(id) => <PasswordInput id={id} value={password} onChange={(v) => { setPassword(v); setPwNote(null) }} />}</Field>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button type="button" className={BTN_PLAIN} disabled={pwBusy || !password} onClick={() => void changePassword()}>
            {pwBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <KeyRound size={14} aria-hidden />}{pwBusy ? 'Changing…' : 'Set new password'}
          </button>
          {pwNote && <Notice text={pwNote.text} bad={pwNote.bad} />}
        </div>
      </section>
    </Drawer>
  )
}

// ── Your profile ─────────────────────────────────────────────────────────────
function Profile({ me, isAdmin, emailOn, sig, sigError, reloadSig, siteNames, gmailReturn, onAgentSaved }: {
  me: Me; isAdmin: boolean; emailOn: boolean
  sig: SignatureData | null; sigError: string; reloadSig: () => Promise<void>
  siteNames: Record<string, string>
  gmailReturn: { ok: boolean; text: string } | null
  onAgentSaved: (agent: AgentSig) => void
}) {
  return (
    <div className="max-w-5xl space-y-5">
      <section className={`${CARD} p-5 flex items-center gap-3`} aria-label="Your account">
        <Avatar label={short(me.email)} tone="agent" size={40} />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-[#2f3941] truncate">{short(me.email)}</p>
          <p className="text-[13px] text-[#68737d] truncate">{me.email}</p>
        </div>
        <div className="ml-auto"><Chip tone={isAdmin ? 'blue' : 'grey'}>{isAdmin ? 'Admin' : 'Standard'}</Chip></div>
      </section>

      {emailOn ? (
        <>
          {sig
            ? <SignatureCard me={me} initial={sig.agent} contacts={sig.sites} siteNames={siteNames} onSaved={onAgentSaved} />
            : <section className={`${CARD} p-5`}>
                <CardHead icon={<PenLine size={16} />} title="Email signature" />
                {sigError ? <LoadFailed text={sigError} retry={() => void reloadSig()} /> : <Spinner text="Loading your signature…" />}
              </section>}
          <GmailCard me={me} isAdmin={isAdmin} returned={gmailReturn} />
        </>
      ) : (
        <section className={`${CARD} p-5`}>
          <CardHead icon={<Mail size={16} />} title="Email" />
          <p className="text-[13px] text-[#68737d]">Email is not turned on for this team, so there is no signature or Gmail connection to set up.</p>
        </section>
      )}

      <SoundCard />
    </div>
  )
}

function SignatureCard({ me, initial, contacts, siteNames, onSaved }: {
  me: Me; initial: AgentSig | null; contacts: SiteContact[]; siteNames: Record<string, string>; onSaved: (agent: AgentSig) => void
}) {
  const [saved, setSaved] = useState({ name: initial?.name ?? '', title: initial?.title ?? '', phone: initial?.phone ?? '' })
  const [form, setForm] = useState(saved)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [siteId, setSiteId] = useState(contacts[0]?.siteId ?? '')
  const [version, setVersion] = useState(0)
  const [preview, setPreview] = useState<{ key: string; html: string; text: string } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const selectId = useId()

  const dirty = form.name !== saved.name || form.title !== saved.title || form.phone !== saved.phone
  const previewKey = `${siteId}#${version}`

  // With a site, the preview is the server's own rendering: the same function
  // that signs outgoing mail, so it cannot differ from what a customer gets.
  useEffect(() => {
    if (!siteId) return
    let alive = true
    api<SignatureData>(`/api/signature?siteId=${encodeURIComponent(siteId)}`, undefined, 'The preview could not be loaded.').then((r) => {
      if (!alive) return
      if (r.ok) { setPreview({ key: `${siteId}#${version}`, html: r.data.signatureHtml ?? '', text: r.data.signature ?? '' }); setPreviewError('') }
      else setPreviewError(r.error)
    })
    return () => { alive = false }
  }, [siteId, version])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setNote(null)
    const r = await api<{ agent: AgentSig }>('/api/signature', postJson(form), 'Your signature could not be saved.')
    setSaving(false)
    if (!r.ok) { setNote({ text: r.error, bad: true }); return }
    const a = r.data.agent
    const next = { name: a?.name ?? form.name.trim(), title: a?.title ?? form.title.trim(), phone: a?.phone ?? form.phone.trim() }
    setSaved(next); setForm(next); setVersion((v) => v + 1)
    onSaved({ email: a?.email ?? me.email, ...next })
    setNote({ text: 'Saved. New emails use it from now on.' })
  }

  const draft = [form.name.trim(), form.title.trim(), form.phone.trim(), me.email].filter(Boolean)

  return (
    <section className={`${CARD} p-5`} aria-label="Email signature">
      <CardHead icon={<PenLine size={16} />} title="Email signature" sub="Added to the bottom of every email you send from a lead’s record." />
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={save} className="space-y-3">
          <Field label="Name">{(id) => <input id={id} className={INPUT} value={form.name} maxLength={120} autoComplete="name" placeholder="Your full name" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Job title">{(id) => <input id={id} className={INPUT} value={form.title} maxLength={120} placeholder="Sales Executive" onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
          <Field label="Direct line" hint="Optional. The site’s own number is used when this is empty.">
            {(id) => <input id={id} type="tel" className={INPUT} value={form.phone} maxLength={40} autoComplete="tel" onChange={(e) => setForm({ ...form, phone: e.target.value })} />}
          </Field>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button type="submit" className={BTN_PRIMARY} disabled={saving || !dirty}>{saving && <Loader2 size={14} className="animate-spin" aria-hidden />}{saving ? 'Saving…' : 'Save signature'}</button>
            {dirty && !saving && <button type="button" className={BTN_PLAIN} onClick={() => { setForm(saved); setNote(null) }}>Discard changes</button>}
            {note && <Notice text={note.text} bad={note.bad} />}
          </div>
        </form>

        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h3 className={`${LABEL} mb-0`}>Preview</h3>
            {contacts.length > 1 && (
              <>
                <label htmlFor={selectId} className="ml-auto text-[12px] text-[#68737d]">On mail for</label>
                <select id={selectId} className={`${INPUT} w-auto max-w-[220px] h-8`} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                  {contacts.map((c) => <option key={c.siteId} value={c.siteId}>{siteNames[c.siteId] ?? (c.company || c.siteId)}</option>)}
                </select>
              </>
            )}
          </div>
          {siteId ? (
            <>
              <div className="rounded-md border border-[#d8dcde] bg-white p-4 min-h-[120px] overflow-x-auto" aria-live="polite">
                {previewError
                  ? <Notice text={previewError} bad />
                  : preview?.key !== previewKey
                    ? <Spinner text="Loading the preview…" />
                    : preview.html
                      // Built by the server from stored fields, by the function that signs real mail.
                      ? <div dangerouslySetInnerHTML={{ __html: preview.html }} />
                      : <p className="text-[13px] text-[#68737d]">Nothing to show yet. Fill in your name and save.</p>}
              </div>
              <p className="mt-1.5 text-[12px] text-[#68737d]">
                {dirty ? 'This shows your saved signature. Save to see your changes here.' : `As it appears on mail for ${siteNames[siteId] ?? siteId}.`}
              </p>
              {preview?.key === previewKey && preview.text && (
                <details className="mt-2">
                  <summary className="text-[12px] text-[#1f73b7] cursor-pointer">Plain-text version</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-[#e9ebed] bg-[#f8f9f9] p-3 text-[12px] leading-5 text-[#49545c]">{preview.text}</pre>
                </details>
              )}
            </>
          ) : (
            <>
              <div className="rounded-md border border-[#d8dcde] bg-white p-4 min-h-[120px] text-[13px] leading-5" aria-live="polite">
                {draft.map((line, i) => <p key={i} className={i === 0 && form.name.trim() ? 'font-semibold text-[#2f3941]' : 'text-[#49545c]'}>{line}</p>)}
              </div>
              <p className="mt-1.5 text-[12px] text-[#68737d]">Your own lines, as typed. The company name, phone, website and logo are added per site once a site is connected.</p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function GmailCard({ me, isAdmin, returned }: { me: Me; isAdmin: boolean; returned: { ok: boolean; text: string } | null }) {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(returned ? { text: returned.text, bad: !returned.ok } : null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const load = useCallback(async () => {
    const r = await api<GmailStatus>('/api/google/gmail/status', undefined, 'The Gmail connection could not be checked.')
    if (r.ok) { setStatus(r.data); setError('') } else setError(r.error)
  }, [])

  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    // The result of the Google round trip has been read; take it out of the
    // address bar so a reload does not show it again.
    if (returned) {
      const url = new URL(window.location.href)
      for (const k of ['gmail', 'reason']) url.searchParams.delete(k)
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return () => clearTimeout(first)
  }, [load, returned])

  function connect() {
    setLeaving(true)
    // Google sends the member back to the page they left.
    window.location.href = `/api/google/gmail/connect?back=${encodeURIComponent(window.location.pathname)}`
  }

  async function disconnect() {
    if (!status) return
    const before = status
    setBusy(true); setConfirming(false); setNote(null)
    setStatus({ connected: false, configured: true, aliases: [] })
    const r = await api('/api/google/gmail/disconnect', postJson({}), 'Gmail could not be disconnected.')
    setBusy(false)
    if (!r.ok) { setStatus(before); setNote({ text: r.error, bad: true }); return }
    setNote({ text: 'Gmail is disconnected. Email cannot be sent from your account until it is connected again.' })
    void load()
  }

  const connectButton = (label: string, primary = true) => (
    <button type="button" className={primary ? BTN_PRIMARY : BTN_PLAIN} disabled={leaving} onClick={connect}>
      {leaving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Mail size={14} aria-hidden />}{leaving ? 'Opening Google…' : label}
    </button>
  )

  let body: React.ReactNode
  if (!status) {
    body = error ? <LoadFailed text={error} retry={() => void load()} /> : <Spinner text="Checking your Gmail connection…" />
  } else if (status.available === false) {
    body = <p className="text-[13px] text-[#68737d]">Email is not turned on for this team.</p>
  } else if (status.configured === false) {
    body = (
      <>
        <p className="text-[13px] text-[#49545c]">Gmail sending has not been set up on the server yet, so there is nothing to connect. Ask whoever maintains your ZeeDesk server to finish the Google setup.</p>
        {isAdmin && status.reason && <p className="mt-1 text-[12px] text-[#68737d]">Server message: {clean(status.reason)}</p>}
      </>
    )
  } else if (status.connected) {
    const aliases = status.aliases ?? []
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="green">Connected</Chip>
          <span className="text-[13px] text-[#2f3941]">{me.email}</span>
          {status.connectedAt && <span className="text-[12px] text-[#68737d]">since {formatDateTime(status.connectedAt)}</span>}
        </div>
        {status.rateLimited && <p className="mt-2 text-[12px] text-[#ad5918]">Google is limiting requests right now, so your sending addresses cannot be listed. The connection itself is fine.</p>}
        {aliases.length > 0 && (
          <div className="mt-3">
            <p className={LABEL}>You can send from</p>
            <ul className="flex flex-wrap gap-1.5">
              {aliases.map((a) => <li key={a.email}><Chip tone={a.isDefault ? 'blue' : 'grey'}>{a.email}{a.isDefault ? ' · default' : ''}</Chip></li>)}
            </ul>
          </div>
        )}
        {status.canReadReplies === false && (
          <div className="mt-3 rounded-md bg-[#fff3e4] px-3 py-2.5">
            <p className="text-[13px] text-[#ad5918]">Customer replies are not being collected. This connection was made without permission to read replies, so they will not appear on the lead’s record. Sending still works. Reconnect to turn reply collection on.</p>
            <div className="mt-2">{connectButton('Reconnect Gmail', false)}</div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {isAdmin ? (
            confirming ? (
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm disconnecting Gmail">
                <span className="text-[12px] text-[#cc3340]">Disconnect Gmail? Sending and reply collection stop for your account.</span>
                <button type="button" className={BTN_DANGER} autoFocus disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
                <button type="button" className={BTN_PLAIN} onClick={() => setConfirming(false)}>Keep connected</button>
              </div>
            ) : (
              <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => setConfirming(true)}>Disconnect Gmail</button>
            )
          ) : (
            <p className="text-[12px] text-[#68737d]">Only an admin can disconnect Gmail. Ask one if this connection needs to be removed.</p>
          )}
        </div>
      </>
    )
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={status.needsReconnect ? 'amber' : 'grey'}>{status.needsReconnect ? 'Needs reconnecting' : 'Not connected'}</Chip>
          {status.reason && <span className="text-[12px] text-[#68737d]">{clean(status.reason)}</span>}
        </div>
        <p className="mt-2 text-[13px] text-[#49545c] max-w-2xl">
          Connect the Google account for <span className="font-medium text-[#2f3941]">{me.email}</span> to send email from a lead’s record and collect the customer’s replies there. Google must be signed in as that same address, and every permission box left ticked, or the connection is refused.
        </p>
        <div className="mt-3">{connectButton(status.needsReconnect ? 'Reconnect Gmail' : 'Connect Gmail')}</div>
      </>
    )
  }

  return (
    <section className={`${CARD} p-5`} aria-label="Gmail">
      <CardHead icon={<Mail size={16} />} title="Gmail" sub="Your own mailbox, used when you email a customer." />
      {body}
      {note && <div className="mt-3"><Notice text={note.text} bad={note.bad} /></div>}
    </section>
  )
}

function SoundCard() {
  // 'off' is the only value that mutes; anything else, or nothing, means on.
  const [on, setOn] = useState(() => { try { return typeof localStorage === 'undefined' || localStorage.getItem('zd-sound') !== 'off' } catch { return true } })
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)

  function change(next: boolean) {
    setOn(next)
    try {
      localStorage.setItem('zd-sound', next ? 'on' : 'off')
      setNote({ text: next ? 'Sound is on in this browser.' : 'Sound is off in this browser.' })
    } catch {
      setOn(!next)
      setNote({ text: 'This browser would not save the setting. Check that site data is allowed and try again.', bad: true })
      return
    }
    if (next) { unlockSound(); replyDing() }
  }

  return (
    <section className={`${CARD} p-5`} aria-label="Alert sound">
      <CardHead icon={on ? <Volume2 size={16} /> : <VolumeX size={16} />} title="Alert sound" sub="A chime when a visitor writes or a customer replies. Saved for this browser only." />
      <div className="flex flex-wrap items-center gap-4">
        <Switch checked={on} onChange={change} label={on ? 'Sound is on' : 'Sound is off'} hint="If the speaker button in the left rail still shows the old state, reload the page." />
        <button type="button" className={`${BTN_PLAIN} ml-auto`} disabled={!on} onClick={() => { unlockSound(); replyDing() }}><Play size={14} aria-hidden />Play a test sound</button>
      </div>
      {note && <div className="mt-3"><Notice text={note.text} bad={note.bad} /></div>}
    </section>
  )
}

// ── Sites ────────────────────────────────────────────────────────────────────
function Sites({ sites, error, reload, emailOn, contacts, onContactSaved }: {
  sites: Site[] | null; error: string; reload: () => Promise<void>; emailOn: boolean
  contacts: SiteContact[]; onContactSaved: (c: SiteContact) => void
}) {
  const [assistant, setAssistant] = useState<Record<string, boolean>>({})
  const [editId, setEditId] = useState<string | null>(null)
  const ids = (sites ?? []).map((s) => s.site_id).join(',')

  // What the widget itself is told for each site: whether the assistant
  // greets visitors there. Read-only, from the same endpoint the widget calls.
  useEffect(() => {
    if (!ids) return
    let alive = true
    Promise.all(ids.split(',').map(async (id) => {
      const r = await api<{ bot_enabled?: boolean }>(`/api/site-config?siteId=${encodeURIComponent(id)}&preview=1`)
      return [id, r.ok && typeof r.data.bot_enabled === 'boolean' ? r.data.bot_enabled : null] as const
    })).then((rows) => {
      if (!alive) return
      const next: Record<string, boolean> = {}
      for (const [id, v] of rows) if (v !== null) next[id] = v
      setAssistant(next)
    })
    return () => { alive = false }
  }, [ids])

  if (!sites) return error ? <LoadFailed text={error} retry={() => void reload()} /> : <Spinner text="Loading your sites…" />

  if (sites.length === 0) {
    return (
      <div className="max-w-3xl">
        <Empty text="No site is connected to ZeeDesk yet." />
        <div className={`${CARD} mt-4 p-5`}>
          <h2 className="text-[15px] font-semibold text-[#2f3941]">What happens next</h2>
          <ol className="mt-2 space-y-2 text-[13px] text-[#49545c] list-decimal pl-5">
            <li>A site is registered on the ZeeDesk server by whoever maintains it. It cannot be created from this screen. Send them the website’s name and address.</li>
            <li>Once registered, the site appears here with a short piece of code. Paste that code into the website, just before the closing <code className="px-1 rounded bg-[#e9ebed] text-[12px]">&lt;/body&gt;</code> tag, and the chat window shows on every page.</li>
            <li>Fill in the site’s business details here so your team’s emails carry the right company name, phone and address.</li>
            <li>On the People tab, choose which members cover the site. Members with no sites picked cover all of them.</li>
          </ol>
          <div className="mt-3"><button type="button" className={BTN_PLAIN} onClick={() => void reload()}><RefreshCw size={14} aria-hidden />Check again</button></div>
        </div>
      </div>
    )
  }

  const editing = sites.find((s) => s.site_id === editId) ?? null
  const contactOf = (id: string) => contacts.find((c) => c.siteId === id) ?? null

  return (
    <div className="max-w-4xl space-y-4">
      {error && <Notice text={`The list may be out of date. ${error}`} bad />}
      <p className="text-[13px] text-[#68737d] max-w-3xl">
        Paste a site’s code just before the closing <code className="px-1 rounded bg-[#e9ebed] text-[12px]">&lt;/body&gt;</code> tag on every page. If the website sends a Content-Security-Policy, allow <code className="px-1 rounded bg-[#e9ebed] text-[12px]">chat.zeedesk.dev</code> for scripts, connections and images. New sites are registered on the server, not here.
      </p>
      {sites.map((s) => (
        <SiteCard key={s.site_id} site={s} assistant={assistant[s.site_id]} emailOn={emailOn} contact={contactOf(s.site_id)} onEdit={() => setEditId(s.site_id)} />
      ))}
      {editing && (
        <BusinessDetails key={editing.site_id} site={editing} initial={contactOf(editing.site_id)} onClose={() => setEditId(null)}
          onSaved={(c) => { onContactSaved(c); setEditId(null) }} />
      )}
    </div>
  )
}

function SiteCard({ site, assistant, emailOn, contact, onEdit }: { site: Site; assistant: boolean | undefined; emailOn: boolean; contact: SiteContact | null; onEdit: () => void }) {
  const box = useRef<HTMLTextAreaElement | null>(null)
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const snippet = snippetFor(site.site_id)
  const codeId = useId()
  const color = site.primary_color && /^#[0-9a-f]{3,8}$/i.test(site.primary_color) ? site.primary_color : null
  const filled = !!contact && !!(contact.company || contact.phone || contact.website || contact.address)

  function selectCode() {
    const el = box.current
    if (!el) return
    el.focus(); el.select()
  }

  function copy() {
    const ok = () => { setCopied(true); setNote({ text: 'Copied. Paste it into the website.' }); setTimeout(() => setCopied(false), 2000) }
    const fallback = () => { selectCode(); setCopied(false); setNote({ text: 'The browser blocked copying. The code is selected: press Ctrl+C, or Command+C on a Mac.', bad: true }) }
    try {
      navigator.clipboard.writeText(snippet).then(ok).catch(fallback)
    } catch {
      fallback()
    }
  }

  return (
    <section className={`${CARD} p-5`} aria-label={site.name}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="w-8 h-8 rounded-md flex items-center justify-center text-white shrink-0" style={{ backgroundColor: color ?? '#2f5f62' }} aria-hidden><Globe size={16} /></span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-[#2f3941] truncate">{site.name}</h2>
          <p className="text-[12px] text-[#68737d] truncate">Site ID {site.site_id}{site.bot_name ? ` · Assistant name: ${site.bot_name}` : ''}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {assistant !== undefined && <Chip tone={assistant ? 'green' : 'grey'}>{assistant ? 'Assistant greets visitors' : 'Assistant is off'}</Chip>}
          {color && <Chip>Chat color {color}</Chip>}
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor={codeId} className={LABEL}>Install code</label>
        <div className="flex flex-wrap items-start gap-2">
          <textarea id={codeId} ref={box} readOnly rows={2} spellCheck={false} value={snippet} onFocus={(e) => e.currentTarget.select()}
            className={`${TEXTAREA} flex-1 min-w-[260px] font-mono text-[12px] resize-none bg-[#f8f9f9]`} />
          <button type="button" className={BTN_PRIMARY} onClick={copy} aria-label={`Copy the install code for ${site.name}`}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {note && <div className="mt-1.5"><Notice text={note.text} bad={note.bad} /></div>}
      </div>

      {emailOn && (
        <div className="mt-4 pt-4 border-t border-[#e9ebed] flex flex-wrap items-start gap-3">
          <span className="mt-0.5 text-[#68737d]" aria-hidden><Building2 size={16} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[#2f3941]">Business details on outgoing email</p>
            {filled && contact ? (
              <p className="text-[12px] text-[#68737d] break-words">{[contact.company, contact.phone, contact.website, contact.address].filter(Boolean).join(' · ')}</p>
            ) : (
              <p className="text-[12px] text-[#ad5918]">Not filled in yet. Until they are, emails for this site are signed with the agent’s own lines only.</p>
            )}
          </div>
          <button type="button" className={BTN_PLAIN} onClick={onEdit} aria-label={`Edit business details for ${site.name}`}><Pencil size={14} aria-hidden />{filled ? 'Edit' : 'Fill in'}</button>
        </div>
      )}
    </section>
  )
}

function BusinessDetails({ site, initial, onClose, onSaved }: { site: Site; initial: SiteContact | null; onClose: () => void; onSaved: (c: SiteContact) => void }) {
  const [form, setForm] = useState({
    company: initial?.company ?? '', phone: initial?.phone ?? '', website: initial?.website ?? '', address: initial?.address ?? '', logo: initial?.logo ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const formId = useId()
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value })

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const logo = form.logo.trim()
    if (logo && !/^https:\/\//i.test(logo)) { setError('The logo must be an address that starts with https://. Mail apps refuse anything else.'); return }
    setSaving(true); setError('')
    const r = await api<{ site: SiteContact }>('/api/signature/site', postJson({ siteId: site.site_id, ...form }), 'The business details could not be saved.')
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    onSaved(r.data.site ?? { siteId: site.site_id, ...form })
  }

  return (
    <Drawer title={`Business details: ${site.name}`} onClose={onClose} footer={
      <>
        <button type="button" className={BTN_PLAIN} onClick={onClose}>Cancel</button>
        <button type="submit" form={formId} className={BTN_PRIMARY} disabled={saving}>{saving && <Loader2 size={14} className="animate-spin" aria-hidden />}{saving ? 'Saving…' : 'Save details'}</button>
      </>
    }>
      <p className="mb-4 text-[13px] text-[#68737d]">These lines go under every agent’s name on email sent for this site, so one change here changes everybody’s signature.</p>
      <form id={formId} onSubmit={save} className="space-y-4" noValidate>
        <Field label="Company name">{(id) => <input id={id} className={INPUT} value={form.company} maxLength={160} autoFocus placeholder={site.name} onChange={set('company')} />}</Field>
        <Field label="Phone">{(id) => <input id={id} type="tel" className={INPUT} value={form.phone} maxLength={40} onChange={set('phone')} />}</Field>
        <Field label="Website">{(id) => <input id={id} className={INPUT} value={form.website} maxLength={160} placeholder="www.yoursite.com" onChange={set('website')} />}</Field>
        <Field label="Office address" hint="Leave it empty until you have the real one. No address is better than a wrong one on outgoing mail.">
          {(id) => <textarea id={id} rows={2} className={TEXTAREA} value={form.address} maxLength={300} onChange={set('address')} />}
        </Field>
        <Field label="Logo" hint="Optional. The https address of an image, shown small beside the signature.">
          {(id) => <input id={id} type="url" className={INPUT} value={form.logo} maxLength={400} placeholder="https://www.yoursite.com/logo.png" onChange={set('logo')} />}
        </Field>
        <Notice text={error} bad />
      </form>
    </Drawer>
  )
}
