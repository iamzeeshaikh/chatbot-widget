'use client'

// ZeeDesk: the second packaging team's own interface. Same server, same APIs
// and the same rules as the ZeeOps dashboard (app/page.tsx), but nothing on
// screen is shared with it: an icon rail on the left, a queue of chats, the
// open conversation in the middle and the customer on the right, after the
// agent workspace built for LiveChat Desk. The owner asked for all of the
// ZeeOps function behind a completely different face (2026-11-17).
//
// Every request here goes to an endpoint that scopes itself to the signed-in
// member's workspace; this file never decides whose data is shown.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LayoutDashboard, MessageSquare, Users, Inbox, KanbanSquare, CheckSquare, BarChart3, UserCog, LogOut, Volume2, VolumeX, Bell, BellOff,
  Paperclip, Send, Search, UserRound, Globe, Monitor, MapPin, Clock, FileText, X, ChevronRight, Contact, CircleDollarSign,
} from 'lucide-react'
import { parseAttachment, isImageMime } from '@/lib/attachment'
import { hasFeature } from '@/lib/workspaces'
import { formatDateTime, timeAgo } from '@/lib/datetime'
import { chatDing, replyDing, visitorDing, unlockSound } from './sound'
import { readPushState, enablePush, disablePush, mirrorSoundToWorker, type PushState } from './push'
import { Avatar, Empty, PageHead, Table, Td, INPUT, KALE, short, postJson as json, type Me } from './ui'
import LeadRecord from './screens/LeadRecord'
import Pipeline from './screens/Pipeline'
import Tasks from './screens/Tasks'
import InboxScreen from './screens/Inbox'
import Reports from './screens/Reports'
import Sales from './screens/Sales'
import Team from './screens/Team'
import Dashboard from './screens/Dashboard'

interface Session { session_id: string; site_id: string; site_name: string; preview: string; last_at: string; message_count: number; last_role?: string; mode: string; lead: { name: string | null; email: string | null } | null; tags?: string[]; assignedTo?: string | null }
interface ChatMsg { id: string; session_id: string; site_id: string; role: string; message: string; created_at: string; author?: string | null }
interface LiveVisitor { session_id: string; site_id: string; site_name: string; page_url: string | null; page_title: string | null; referrer: string | null; visits: number; last_seen: string; created_at: string; device_type: string | null; browser: string | null; os: string | null; country: string | null; city: string | null }
interface VisitorDetail {
  session_id: string; site_id: string
  contact: { name: string; email: string; phone: string; notes: string }
  tags: string[]
  stats: { visits: number; chats: number; first_seen: string | null; last_seen: string | null }
  previousChats?: { session_id: string; messages: number; last_at: string | null }[]
  path: { url: string | null; title: string | null; at: string | null }[]
  technical: { country: string | null; city: string | null; browser: string | null; os: string | null; device_type: string | null; ip: string | null; referrer: string | null }
}
interface LeadRow { id: string; site_id: string; name: string | null; email: string | null; phone: string | null; message: string | null; created_at: string; product?: string | null; quantity?: string | null; session_id?: string | null; owner?: string | null; stage?: string; notALead?: boolean }

type Section = 'home' | 'chats' | 'visitors' | 'leads' | 'inbox' | 'pipeline' | 'tasks' | 'reports' | 'sales' | 'team' | 'lead'
type View = 'unassigned' | 'mine' | 'all'
const SECTIONS: readonly Section[] = ['home', 'chats', 'visitors', 'leads', 'inbox', 'pipeline', 'tasks', 'reports', 'sales', 'team']

const visitorName = (s: Session) => s.lead?.name || s.lead?.email || `Visitor ${s.session_id.slice(-4).toUpperCase()}`

// Live visitors are polled on this beat on EVERY screen: it is the worst-case
// delay between a customer landing on a site and the agent's doorbell, so it
// is kept as tight as the ZeeOps dashboard's (app/page.tsx VISITOR_POLL_MS).
const VISITOR_POLL_MS = 5 * 1000

// What an agent on another tab actually notices. A sound is useless there (a
// browser will not play one on a hidden tab anyway), so a desktop notification
// is drawn by the OS over whatever they are looking at, and the count in the
// tab title is the fallback when permission was never granted. Mirrors
// awayAlert in app/page.tsx. Cleared the moment the tab is looked at again.
let awayUnread = 0
let awayBaseTitle = ''
function awayAlert(title: string, body: string) {
  if (typeof document === 'undefined' || !document.hidden) return
  awayUnread += 1
  if (!awayBaseTitle) awayBaseTitle = document.title.replace(/^\(\d+\)\s*/, '')
  document.title = `(${awayUnread}) ${awayBaseTitle}`
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: 'zeedesk-away', icon: '/icon.svg' })
      n.onclick = () => { window.focus(); n.close() }
    }
  } catch { /* a browser that refuses is not worth breaking the poll over */ }
}
function awayClear() {
  if (typeof document === 'undefined') return
  awayUnread = 0
  if (awayBaseTitle) document.title = awayBaseTitle
}

// The address bar carries the open screen, so a reload or a shared link lands
// on the same place: #pipeline, or #lead/<record id>. #sales/lead/<record id>
// opens Sales with a new sale started from that lead.
function readHash(): { section: Section; leadId: string } {
  const h = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '')
  if (h.startsWith('lead/')) { const id = decodeURIComponent(h.slice(5)); if (id) return { section: 'lead', leadId: id } }
  if (h.startsWith('sales/lead/')) return { section: 'sales', leadId: decodeURIComponent(h.slice(11)) }
  return { section: (SECTIONS as readonly string[]).includes(h) ? (h as Section) : 'home', leadId: '' }
}

function RailButton({ icon, label, text, active, badge, onClick }: { icon: React.ReactNode; label: string; text: string; active?: boolean; badge?: number; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-current={active ? 'page' : undefined}
      className={`relative w-[72px] py-2 flex flex-col items-center gap-1 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${active ? 'bg-[#17494d] text-white' : 'text-[#c3d6d7] hover:bg-[#17494d] hover:text-white'}`}>
      {icon}
      <span className="text-[11px] leading-none font-medium">{text}</span>
      {!!badge && <span className="absolute top-1 right-3 min-w-[16px] h-4 px-1 rounded-full bg-[#e34f32] text-white text-[10px] font-bold leading-4 text-center tabular-nums">{badge > 99 ? '99+' : badge}</span>}
    </button>
  )
}

export default function ZdApp() {
  const [me, setMe] = useState<Me | null>(null)
  const [section, setSectionState] = useState<Section>('home')
  const [leadId, setLeadId] = useState('')
  const [leadQuery, setLeadQuery] = useState('')
  const backTo = useRef<Section>('leads')
  const [sessions, setSessions] = useState<Session[]>([])
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<View>('unassigned')
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [detail, setDetail] = useState<VisitorDetail | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [visitors, setVisitors] = useState<LiveVisitor[]>([])
  const [liveChatCount, setLiveChatCount] = useState(0)
  const [leads, setLeads] = useState<LeadRow[] | null>(null)
  const [sound, setSound] = useState(() => { try { return typeof localStorage === 'undefined' || localStorage.getItem('zd-sound') !== 'off' } catch { return true } })
  const [showInfo, setShowInfo] = useState(true)
  // Notifications on THIS device (app/zd/push.ts). 'unsupported' until read.
  const [push, setPush] = useState<PushState>('unsupported')
  const [pushNote, setPushNote] = useState('')
  const [pushBusy, setPushBusy] = useState(false)

  const lastUserAt = useRef<Record<string, string>>({})
  const seeded = useRef(false)
  const soundRef = useRef(sound)
  const scroller = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const typingPing = useRef(0)
  const openRef = useRef<string | null>(null)

  useEffect(() => {
    fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (!m?.email) { window.location.href = '/login'; return }
      setMe(m)
    }).catch(() => { window.location.href = '/login' })
    // The first click also asks for desktop-notification permission, so the
    // arrival/message alerts can reach an agent working on another tab. A
    // browser only lets a page ask after a gesture, which is why it sits here.
    const unlock = () => {
      unlockSound()
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission() } catch { /* ignore */ }
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    const onVisible = () => { if (!document.hidden) awayClear() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // ── Which screen is open ──
  useEffect(() => {
    const sync = () => { const h = readHash(); setSectionState(h.section); setLeadId(h.leadId) }
    // Coming back from the Google sign-in lands on "/?gmail=…": that belongs to the profile screen.
    if (!window.location.hash && new URLSearchParams(window.location.search).has('gmail')) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#team`)
    const first = setTimeout(sync, 0)
    window.addEventListener('hashchange', sync)
    return () => { clearTimeout(first); window.removeEventListener('hashchange', sync) }
  }, [])
  const setSection = useCallback((next: Section) => { window.location.hash = next === 'home' ? '' : next }, [])
  const openLead = useCallback((recordId: string) => {
    const from = readHash().section
    if (from !== 'lead') backTo.current = from
    window.location.hash = `lead/${encodeURIComponent(recordId)}`
  }, [])

  // ── Conversations: one poll feeds the queue, the rail badge and the chime ──
  const loadSessions = useCallback(async () => {
    const data = await fetch('/api/admin/conversations').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!data) return
    const list: Session[] = data.sessions ?? []
    let fresh = false
    const next: Record<string, string> = {}
    for (const s of list) {
      if (s.last_role !== 'user') continue
      next[s.session_id] = s.last_at
      if (seeded.current && lastUserAt.current[s.session_id] !== s.last_at) fresh = true
    }
    lastUserAt.current = next
    // Signing in to chats that were already waiting is not a new event.
    if (fresh && soundRef.current) chatDing()
    seeded.current = true
    setSessions(list)
    const cutoff = Date.now() - 30 * 60 * 1000
    setLiveChatCount(list.filter((s) => Date.parse(s.last_at) > cutoff || (s.last_role === 'user' && !s.assignedTo)).length)
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!me) return
    const first = setTimeout(loadSessions, 0)
    // 10s, the same cadence the ZeeOps dashboard polls at (CLAUDE.md §6).
    const t = setInterval(() => { if (!document.hidden) loadSessions() }, 10000)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [me, loadSessions])

  // A chat opened from the Visitors list has usually not been written in yet,
  // so it is not in `sessions`. It used to fall through to the empty "Pick a
  // chat" pane (owner, 2026-11-25: "clicked the visitor and nothing shows").
  // Stand a session up from the live-visitor row instead, so the agent gets a
  // header and a composer and can say hello first; the widget's open panel
  // polls for replies, so the greeting lands on the visitor's screen.
  const open = useMemo<Session | null>(() => {
    if (!openId) return null
    const known = sessions.find((s) => s.session_id === openId)
    if (known) return known
    const v = visitors.find((x) => x.session_id === openId)
    if (!v) return null
    return { session_id: v.session_id, site_id: v.site_id, site_name: v.site_name, preview: '', last_at: v.last_seen, message_count: 0, mode: 'bot', lead: null, assignedTo: null }
  }, [sessions, visitors, openId])

  const loadMessages = useCallback(async (id: string) => {
    const data = await fetch(`/api/admin/messages?sessionId=${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!data) return
    const next: ChatMsg[] = data.messages ?? []
    setMessages((prev) => (prev.length === next.length && prev.length > 0 && prev[prev.length - 1].id === next[next.length - 1].id ? prev : next))
  }, [])

  useEffect(() => {
    if (!openId) return
    const first = setTimeout(() => loadMessages(openId), 0)
    fetch(`/api/admin/visitor?sessionId=${encodeURIComponent(openId)}`).then((r) => (r.ok ? r.json() : null)).then((d) => { const v = d?.detail ?? d; if (v?.contact) setDetail(v) }).catch(() => {})
    const t = setInterval(() => { if (!document.hidden) loadMessages(openId) }, 3000)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [openId, loadMessages])

  useEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight }, [messages])

  // ── Live visitors: polled on every screen, so an arrival always rings ──
  // It used to load only while the Visitors screen was open, so an agent on
  // Chats or Home heard nothing when a customer landed (owner, 2026-11-25).
  // Any BRAND-NEW session gets the doorbell plus, on a hidden tab, a desktop
  // notification. Seeded silently on the first poll so opening the app to two
  // visitors already browsing is not two events. A hidden tab polls on a
  // slower beat (every fourth tick) rather than not at all, so the alert can
  // still reach the agent wherever they are.
  const prevVisitorIds = useRef<Set<string>>(new Set())
  const visitorsSeeded = useRef(false)
  const loadVisitors = useCallback(async () => {
    const d = await fetch('/api/visitor/active').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (!d) return
    const list: LiveVisitor[] = d.visitors ?? []
    const arrivals = list.filter((v) => !prevVisitorIds.current.has(v.session_id))
    if (visitorsSeeded.current && arrivals.length > 0) {
      if (soundRef.current) visitorDing()
      awayAlert(arrivals.length === 1 ? 'Someone is on your site' : `${arrivals.length} visitors are on your sites`, arrivals[0].site_name || 'A visitor just arrived')
    }
    visitorsSeeded.current = true
    prevVisitorIds.current = new Set(list.map((v) => v.session_id))
    setVisitors(list)
  }, [])
  useEffect(() => {
    if (!me) return
    const first = setTimeout(loadVisitors, 0)
    let missed = 0
    const t = setInterval(() => {
      if (!document.hidden) { missed = 0; loadVisitors(); return }
      if (++missed >= 4) { missed = 0; loadVisitors() }
    }, VISITOR_POLL_MS)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [me, loadVisitors])

  useEffect(() => {
    if (!me || section !== 'leads') return
    fetch('/api/admin/leads-list').then((r) => (r.ok ? r.json() : null)).then((d) => setLeads(d?.leads ?? [])).catch(() => setLeads([]))
  }, [me, section])

  // ── Actions ──
  // Opening a chat clears the previous one's thread, draft and customer panel
  // here, in the handler, so the old conversation never shows under a new name.
  const openChat = useCallback((id: string) => {
    if (openRef.current !== id) { setMessages([]); setDetail(null); setNotice(''); setText('') }
    openRef.current = id
    setOpenId(id)
  }, [])
  const openChatFromScreen = useCallback((id: string) => { setView('all'); openChat(id); setSection('chats') }, [openChat, setSection])

  // ── Notifications ──
  // Where this device stands, and the sound switch told to the worker (on
  // load too: a freshly started worker has never been told).
  useEffect(() => {
    if (!me) return
    let alive = true
    readPushState().then((s) => { if (alive) setPush(s) })
    return () => { alive = false }
  }, [me])
  useEffect(() => { mirrorSoundToWorker(sound) }, [sound])
  // A chat notification opens "/?…&session=<id>": land on that chat, then
  // tidy the address so a reload does not reopen it.
  useEffect(() => {
    if (!me) return
    const sid = new URLSearchParams(window.location.search).get('session')
    if (!sid) return
    const first = setTimeout(() => {
      window.history.replaceState(null, '', window.location.pathname)
      openChatFromScreen(sid)
    }, 0)
    return () => clearTimeout(first)
  }, [me, openChatFromScreen])
  const patch = useCallback((id: string, change: Partial<Session>) => setSessions((prev) => prev.map((s) => (s.session_id === id ? { ...s, ...change } : s))), [])

  async function assign(action: 'claim' | 'release') {
    if (!open || !me) return
    patch(open.session_id, { assignedTo: action === 'claim' ? me.email : null })
    const res = await fetch('/api/admin/assign', json({ sessionId: open.session_id, siteId: open.site_id, action })).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (res) patch(open.session_id, { assignedTo: res.assignedTo ?? null })
  }

  async function setMode(mode: 'human' | 'bot') {
    if (!open) return
    patch(open.session_id, { mode })
    await fetch('/api/admin/mode', json({ sessionId: open.session_id, mode })).catch(() => {})
  }

  async function send() {
    if (!open || !me || busy) return
    const body = text.trim()
    if (!body) return
    setBusy(true); setNotice('')
    // Replying means a person has joined: the assistant steps back first.
    if (open.mode === 'bot') await setMode('human')
    const resp = await fetch('/api/admin/reply', json({ sessionId: open.session_id, siteId: open.site_id, message: body })).catch(() => null)
    const res = resp ? await resp.json().catch(() => null) : null
    if (!resp || !resp.ok) {
      setNotice(resp?.status === 409 ? `${short(res?.assignedTo) || 'Another agent'} is handling this chat. Take it over to reply.` : (res?.error || 'That did not send. Try again.'))
      if (res?.assignedTo) patch(open.session_id, { assignedTo: res.assignedTo })
      setBusy(false)
      return
    }
    if (res?.assignedTo) patch(open.session_id, { assignedTo: res.assignedTo })
    setText('')
    await loadMessages(open.session_id)
    setBusy(false)
  }

  async function upload(file: File) {
    if (!open || busy) return
    if (file.size > 10 * 1024 * 1024) { setNotice('That file is over 10 MB.'); return }
    setBusy(true); setNotice('')
    const fd = new FormData()
    fd.append('file', file); fd.append('siteId', open.site_id); fd.append('sessionId', open.session_id)
    const resp = await fetch('/api/upload', { method: 'POST', body: fd }).catch(() => null)
    const res = resp ? await resp.json().catch(() => null) : null
    if (!resp || !resp.ok) setNotice(resp?.status === 409 ? `${short(res?.assignedTo) || 'Another agent'} is handling this chat.` : (res?.error || 'The upload failed.'))
    else await loadMessages(open.session_id)
    setBusy(false)
  }

  function typing(value: string) {
    setText(value)
    if (!open || !value.trim()) return
    const now = Date.now()
    if (now - typingPing.current < 3000) return
    typingPing.current = now
    fetch('/api/admin/typing', json({ sessionId: open.session_id })).catch(() => {})
  }

  function toggleSound() {
    const next = !sound
    setSound(next); soundRef.current = next
    try { localStorage.setItem('zd-sound', next ? 'on' : 'off') } catch { /* ignore */ }
    if (next) { unlockSound(); replyDing() }
  }

  async function togglePush() {
    if (pushBusy) return
    setPushBusy(true)
    const r = push === 'on' ? await disablePush() : await enablePush()
    setPush(r.state); setPushNote(r.note); setPushBusy(false)
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    window.location.href = '/login'
  }

  // ── Derived queue ──
  const waiting = useMemo(() => sessions.filter((s) => s.last_role === 'user' && !s.assignedTo), [sessions])
  // The Chats badge counts every chat that is LIVE — any message in the last
  // 30 minutes (the widget's own session gap), whoever wrote last, plus any
  // older chat still waiting unassigned. It used to count only the waiting
  // ones, so an agent saw "2" on Visitors and nothing on Chats while two
  // conversations were in progress (owner, 2026-11-25). Recomputed on every
  // 10 s poll, so a chat drops off the count on its own as it goes quiet.
  // Counted inside the poll (not during render): the clock is read once per
  // fetch, so the number is stable between renders.
  const mine = useMemo(() => sessions.filter((s) => me && s.assignedTo === me.email), [sessions, me])
  const queue = useMemo(() => {
    const base = view === 'unassigned' ? waiting : view === 'mine' ? mine : sessions
    const q = query.trim().toLowerCase()
    const rows = q ? base.filter((s) => `${visitorName(s)} ${s.site_name} ${s.preview} ${s.lead?.email ?? ''}`.toLowerCase().includes(q)) : base
    return [...rows].sort((a, b) => b.last_at.localeCompare(a.last_at))
  }, [view, waiting, mine, sessions, query])

  if (!me) return <div className="h-screen flex items-center justify-center text-sm text-[#68737d]">Loading your workspace…</div>

  const ws = me.workspace as Parameters<typeof hasFeature>[0]
  const screen = { me, openLead, openChat: openChatFromScreen }
  const realLeads = (leads ?? []).filter((l) => !l.notALead)
  const lq = leadQuery.trim().toLowerCase()
  const shownLeads = lq ? realLeads.filter((l) => `${l.name ?? ''} ${l.email ?? ''} ${l.phone ?? ''} ${l.product ?? ''} ${l.message ?? ''} ${l.site_id}`.toLowerCase().includes(lq)) : realLeads
  const lockedByOther = !!open?.assignedTo && open.assignedTo !== me.email
  const VIEWS: { key: View; label: string; count: number }[] = [
    { key: 'unassigned', label: 'Waiting', count: waiting.length },
    { key: 'mine', label: 'Your chats', count: mine.length },
    { key: 'all', label: 'All chats', count: sessions.length },
  ]

  return (
    <div className="relative h-screen flex bg-white text-[#2f3941] text-[14px] overflow-hidden" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' }}>
      {/* ── Rail ── */}
      <nav aria-label="Sections" className="w-[84px] shrink-0 flex flex-col items-center py-3 gap-0.5 overflow-y-auto [scrollbar-width:none]" style={{ backgroundColor: KALE }}>
        <div className="w-9 h-9 mb-3 rounded-lg bg-white/95 flex items-center justify-center" title="ZeeDesk">
          <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden><path d="M4 5h16L8 19h12" fill="none" stroke={KALE} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </div>
        <RailButton icon={<LayoutDashboard size={20} />} label="Dashboard" text="Home" active={section === 'home'} onClick={() => setSection('home')} />
        <RailButton icon={<MessageSquare size={20} />} label="Chats" text="Chats" active={section === 'chats'} badge={liveChatCount} onClick={() => setSection('chats')} />
        <RailButton icon={<Users size={20} />} label="Visitors on your sites" text="Visitors" active={section === 'visitors'} badge={visitors.length} onClick={() => setSection('visitors')} />
        <RailButton icon={<Contact size={20} />} label="Leads" text="Leads" active={section === 'leads' || section === 'lead'} onClick={() => setSection('leads')} />
        {hasFeature(ws, 'email') && <RailButton icon={<Inbox size={20} />} label="Inbox" text="Inbox" active={section === 'inbox'} onClick={() => setSection('inbox')} />}
        {hasFeature(ws, 'pipeline') && <RailButton icon={<KanbanSquare size={20} />} label="Pipeline" text="Pipeline" active={section === 'pipeline'} onClick={() => setSection('pipeline')} />}
        {hasFeature(ws, 'tasks') && <RailButton icon={<CheckSquare size={20} />} label="Tasks" text="Tasks" active={section === 'tasks'} onClick={() => setSection('tasks')} />}
        {hasFeature(ws, 'reports') && <RailButton icon={<BarChart3 size={20} />} label="Reports" text="Reports" active={section === 'reports'} onClick={() => setSection('reports')} />}
        {me.role === 'admin' && <RailButton icon={<CircleDollarSign size={20} />} label="Sales" text="Sales" active={section === 'sales'} onClick={() => setSection('sales')} />}
        <div className="flex-1" />
        <RailButton icon={<UserCog size={20} />} label={me.role === 'admin' ? 'Team and settings' : 'Your profile'} text={me.role === 'admin' ? 'Team' : 'Profile'} active={section === 'team'} onClick={() => setSection('team')} />
        <RailButton icon={sound ? <Volume2 size={20} /> : <VolumeX size={20} />} label={sound ? 'Sound is on' : 'Sound is off'} text={sound ? 'Sound on' : 'Muted'} onClick={toggleSound} />
        <RailButton icon={push === 'on' ? <Bell size={20} /> : <BellOff size={20} />}
          label={push === 'on' ? 'Notifications are on for this device. Click to switch them off.' : push === 'blocked' ? 'Notifications are blocked in this browser. Click for how to allow them.' : 'Get notified on this device when ZeeDesk is closed'}
          text={push === 'on' ? 'Alerts on' : 'Alerts off'} onClick={() => void togglePush()} />
        <RailButton icon={<LogOut size={20} />} label="Sign out" text="Sign out" onClick={logout} />
        <div className="mt-1" title={me.email}><Avatar label={short(me.email)} tone="agent" size={34} /></div>
      </nav>
      {pushNote && (
        <div role="status" className="absolute left-[92px] bottom-4 z-40 max-w-[320px] rounded-lg border border-[#d8dcde] bg-white px-3 py-2.5 shadow-lg text-[13px] text-[#2f3941] flex items-start gap-2">
          <span className="flex-1">{pushNote}</span>
          <button type="button" onClick={() => setPushNote('')} aria-label="Dismiss" className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-[#68737d] hover:bg-[#e9ebed]"><X size={14} /></button>
        </div>
      )}

      {section === 'home' && <Dashboard {...screen} waiting={waiting.map((w) => ({ session_id: w.session_id, site_id: w.site_id, site_name: w.site_name, preview: w.preview, last_at: w.last_at, name: visitorName(w) }))} />}

      {section === 'chats' && (
        <>
          {/* ── Queue ── */}
          <aside className="w-[320px] shrink-0 border-r border-[#d8dcde] flex flex-col bg-[#f8f9f9]">
            <div className="px-4 pt-4 pb-2">
              <h1 className="text-[18px] font-semibold text-[#2f3941]">Chats</h1>
              <div className="mt-3 flex gap-1" role="tablist" aria-label="Chat views">
                {VIEWS.map((v) => (
                  <button key={v.key} role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
                    className={`flex-1 h-8 rounded-md text-[12px] font-medium transition-colors ${view === v.key ? 'bg-white text-[#1f73b7] shadow-[0_0_0_1px_#d8dcde]' : 'text-[#68737d] hover:bg-[#e9ebed]'}`}>
                    {v.label} <span className="tabular-nums opacity-80">{loaded ? v.count : ''}</span>
                  </button>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 h-9 px-2.5 rounded-md bg-white border border-[#d8dcde] focus-within:border-[#1f73b7]">
                <Search size={15} className="text-[#87929d]" aria-hidden />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, site or message" aria-label="Search chats"
                  className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-[#87929d]" />
              </label>
            </div>
            <div className="flex-1 overflow-y-auto [scrollbar-width:thin]">
              {!loaded && <p className="px-4 py-6 text-[13px] text-[#68737d]">Loading chats…</p>}
              {loaded && queue.length === 0 && (
                <p className="px-4 py-6 text-[13px] text-[#68737d]">
                  {query ? 'No chat matches that search.' : view === 'unassigned' ? 'Nobody is waiting. New chats appear here the moment a visitor writes.' : view === 'mine' ? 'You have no chats assigned to you.' : 'No chats yet.'}
                </p>
              )}
              {queue.map((s) => {
                const isOpen = s.session_id === openId
                const needs = s.last_role === 'user'
                return (
                  <button key={s.session_id} onClick={() => openChat(s.session_id)}
                    className={`w-full text-left px-4 py-3 flex gap-3 border-b border-[#e9ebed] transition-colors ${isOpen ? 'bg-[#edf7ff]' : 'hover:bg-white'}`}>
                    <Avatar label={visitorName(s)} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className={`truncate ${needs ? 'font-semibold text-[#2f3941]' : 'text-[#2f3941]'}`}>{visitorName(s)}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-[#87929d] tabular-nums">{timeAgo(s.last_at)}</span>
                      </span>
                      <span className="block truncate text-[12px] text-[#68737d]">{s.preview || 'No messages yet'}</span>
                      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-[#87929d]">
                        <span className="truncate">{s.site_name}</span>
                        {s.mode === 'bot' && <span className="shrink-0 px-1.5 rounded bg-[#e9ebed] text-[#68737d]">Assistant</span>}
                        {s.assignedTo && <span className="shrink-0 px-1.5 rounded bg-[#dceefb] text-[#144a75]">{s.assignedTo === me.email ? 'You' : short(s.assignedTo)}</span>}
                        {needs && <span className="ml-auto shrink-0 w-2 h-2 rounded-full bg-[#e34f32]" aria-label="Waiting for a reply" />}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>

          {/* ── Conversation ── */}
          <main className="flex-1 min-w-0 flex flex-col">
            {!open ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
                <div className="w-14 h-14 rounded-full bg-[#e9f4f3] flex items-center justify-center mb-4"><MessageSquare size={24} color="#17494d" aria-hidden /></div>
                <p className="text-[16px] font-semibold">Pick a chat to start</p>
                <p className="mt-1 text-[13px] text-[#68737d] max-w-sm">Visitors who are waiting are listed on the left, newest first. Replying to one assigns it to you.</p>
              </div>
            ) : (
              <>
                <header className="h-[60px] shrink-0 px-5 flex items-center gap-3 border-b border-[#d8dcde]">
                  <Avatar label={visitorName(open)} size={36} />
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{visitorName(open)}</p>
                    <p className="text-[12px] text-[#68737d] truncate">{open.site_name}{open.assignedTo ? ` · ${open.assignedTo === me.email ? 'Assigned to you' : `With ${short(open.assignedTo)}`}` : ' · Unassigned'}</p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {open.mode === 'bot'
                      ? <button onClick={() => setMode('human')} className="h-8 px-3 rounded-md bg-[#1f73b7] text-white text-[13px] font-medium hover:bg-[#144a75]">Join chat</button>
                      : <button onClick={() => setMode('bot')} className="h-8 px-3 rounded-md border border-[#d8dcde] text-[13px] hover:bg-[#f8f9f9]" title="Hand this chat back to the assistant">Hand to assistant</button>}
                    {open.assignedTo === me.email
                      ? <button onClick={() => assign('release')} className="h-8 px-3 rounded-md border border-[#d8dcde] text-[13px] hover:bg-[#f8f9f9]">Release</button>
                      : <button onClick={() => assign('claim')} className="h-8 px-3 rounded-md border border-[#1f73b7] text-[#1f73b7] text-[13px] font-medium hover:bg-[#edf7ff]">{open.assignedTo ? 'Take over' : 'Assign to me'}</button>}
                    <button onClick={() => setShowInfo((v) => !v)} aria-pressed={showInfo} title="Customer details" aria-label="Customer details"
                      className={`w-8 h-8 rounded-md flex items-center justify-center border border-[#d8dcde] ${showInfo ? 'bg-[#edf7ff] text-[#1f73b7]' : 'hover:bg-[#f8f9f9]'}`}><UserRound size={16} /></button>
                  </div>
                </header>

                <div ref={scroller} className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-white [scrollbar-width:thin]">
                  {messages.map((m) => {
                    // The one control row this endpoint returns: the moment the
                    // visitor's contact details were captured. A marker, not a
                    // message. Any other unknown role is not shown at all.
                    if (m.role === 'lead_capture') {
                      return <p key={m.id} className="text-center text-[11px] text-[#68737d]"><span className="inline-block px-2.5 py-1 rounded-full bg-[#edf8f4] text-[#038153]">Contact details captured · {formatDateTime(m.created_at)}</span></p>
                    }
                    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'admin') return null
                    const visitor = m.role === 'user'
                    const bot = m.role === 'assistant'
                    const file = parseAttachment(m.message)
                    const who = visitor ? visitorName(open) : bot ? 'Assistant' : short(m.author) || 'Agent'
                    return (
                      <div key={m.id} className={`flex gap-2.5 ${visitor ? '' : 'flex-row-reverse'}`}>
                        <Avatar label={who} tone={visitor ? 'visitor' : bot ? 'bot' : 'agent'} size={28} />
                        <div className={`max-w-[72%] ${visitor ? '' : 'items-end text-right'}`}>
                          <p className="text-[11px] text-[#87929d] mb-0.5">{who} · {formatDateTime(m.created_at)}</p>
                          <div className={`inline-block text-left px-3 py-2 rounded-lg whitespace-pre-wrap break-words ${visitor ? 'bg-[#f8f9f9] border border-[#e9ebed]' : bot ? 'bg-[#e9ebed]' : 'bg-[#1f73b7] text-white'}`}>
                            {file ? (
                              isImageMime(file.mime)
                                // eslint-disable-next-line @next/next/no-img-element
                                ? <a href={file.url} target="_blank" rel="noreferrer"><img src={file.url} alt={file.name} className="max-w-[260px] max-h-[220px] rounded" /></a>
                                : <a href={file.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 underline"><FileText size={16} aria-hidden />{file.name}</a>
                            ) : m.message}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {messages.length === 0 && (open.message_count === 0
                    ? <p className="text-[13px] text-[#68737d]">This visitor is browsing {open.site_name} and has not written yet. Say hello below to start the chat — it opens on their screen.</p>
                    : <p className="text-[13px] text-[#68737d]">Loading the conversation…</p>)}
                </div>

                <footer className="shrink-0 border-t border-[#d8dcde] px-5 py-3 bg-[#f8f9f9]">
                  {notice && <p role="alert" className="mb-2 text-[12px] text-[#cc3340]">{notice}</p>}
                  {lockedByOther && !notice && <p className="mb-2 text-[12px] text-[#68737d]">{short(open.assignedTo)} is handling this chat. Take it over to reply.</p>}
                  <div className="flex items-end gap-2 rounded-lg border border-[#d8dcde] bg-white px-2 py-2 focus-within:border-[#1f73b7]">
                    <input ref={fileInput} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
                    <button onClick={() => fileInput.current?.click()} disabled={busy || lockedByOther} title="Attach a file" aria-label="Attach a file"
                      className="w-9 h-9 rounded-md flex items-center justify-center text-[#68737d] hover:bg-[#f8f9f9] disabled:opacity-40"><Paperclip size={17} /></button>
                    <textarea value={text} onChange={(e) => typing(e.target.value)} rows={2} disabled={lockedByOther}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                      placeholder={lockedByOther ? 'Take the chat over to reply' : open.mode === 'bot' ? 'Write a reply. Sending it joins the chat and pauses the assistant.' : 'Write a reply. Enter sends, Shift+Enter adds a line.'}
                      aria-label="Reply" className="flex-1 resize-none bg-transparent outline-none text-[14px] leading-5 py-1.5 placeholder:text-[#87929d] disabled:cursor-not-allowed" />
                    <button onClick={send} disabled={busy || lockedByOther || !text.trim()}
                      className="h-9 px-4 rounded-md bg-[#1f73b7] text-white text-[13px] font-medium inline-flex items-center gap-1.5 hover:bg-[#144a75] disabled:opacity-40"><Send size={15} aria-hidden />Send</button>
                  </div>
                </footer>
              </>
            )}
          </main>

          {/* ── Customer ── */}
          {open && showInfo && (
            <aside className="hidden lg:flex w-[300px] shrink-0 border-l border-[#d8dcde] flex-col bg-[#f8f9f9] overflow-y-auto [scrollbar-width:thin]">
              <div className="h-[60px] shrink-0 px-4 flex items-center border-b border-[#d8dcde]">
                <p className="font-semibold">Customer</p>
                <button onClick={() => setShowInfo(false)} className="ml-auto w-7 h-7 rounded flex items-center justify-center hover:bg-[#e9ebed]" aria-label="Hide customer details"><X size={15} /></button>
              </div>
              <div className="p-4 space-y-5">
                <section>
                  <p className="text-[15px] font-semibold">{detail?.contact?.name || visitorName(open)}</p>
                  <dl className="mt-2 space-y-1.5 text-[13px]">
                    <Row label="Email" value={detail?.contact?.email || open.lead?.email || 'Not given yet'} />
                    <Row label="Phone" value={detail?.contact?.phone || 'Not given yet'} />
                    <Row label="Site" value={open.site_name} />
                  </dl>
                  {(open.lead?.email || detail?.contact?.email) && (
                    <button type="button" onClick={() => openLead(open.session_id)} className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-[#1f73b7] hover:text-[#144a75]">Open the full record <ChevronRight size={14} aria-hidden /></button>
                  )}
                </section>
                {detail && (
                  <>
                    <section>
                      <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">Visit</h2>
                      <ul className="mt-2 space-y-1.5 text-[13px]">
                        <Fact icon={<MapPin size={14} />} text={[detail.technical.city, detail.technical.country].filter(Boolean).join(', ') || 'Location unknown'} />
                        <Fact icon={<Monitor size={14} />} text={[detail.technical.browser, detail.technical.os, detail.technical.device_type].filter(Boolean).join(' · ') || 'Device unknown'} />
                        <Fact icon={<Clock size={14} />} text={`${detail.stats.visits} visit${detail.stats.visits === 1 ? '' : 's'} · ${detail.stats.chats} chat${detail.stats.chats === 1 ? '' : 's'}`} />
                        {detail.technical.referrer && <Fact icon={<Globe size={14} />} text={`Came from ${detail.technical.referrer.replace(/^https?:\/\//, '').slice(0, 40)}`} />}
                      </ul>
                    </section>
                    {detail.path.length > 0 && (
                      <section>
                        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">Pages viewed</h2>
                        <ol className="mt-2 space-y-1.5 text-[12px]">
                          {detail.path.slice(-8).map((p, i) => (
                            <li key={i} className="truncate text-[#2f3941]" title={p.url ?? ''}>{p.title || (p.url ?? '').replace(/^https?:\/\/[^/]+/, '') || 'Page'}</li>
                          ))}
                        </ol>
                      </section>
                    )}
                    {!!detail.previousChats?.length && (
                      <section>
                        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-[#68737d]">Earlier chats</h2>
                        <ul className="mt-2 space-y-1 text-[13px]">
                          {detail.previousChats.map((c) => (
                            <li key={c.session_id}><button onClick={() => openChat(c.session_id)} className="text-[#1f73b7] hover:text-[#144a75]">{c.messages} messages · {c.last_at ? formatDateTime(c.last_at) : 'earlier'}</button></li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                )}
              </div>
            </aside>
          )}
        </>
      )}

      {section === 'visitors' && (
        <main className="flex-1 min-w-0 overflow-y-auto">
          <PageHead title="Visitors" sub={`${visitors.length} on your sites right now`} />
          <div className="px-6 pb-8">
            {visitors.length === 0 ? <Empty text="Nobody is on your sites at the moment. This list refreshes on its own." /> : (
              <Table head={['Visitor', 'Site', 'Page', 'Location', 'Device', 'Last seen']}>
                {visitors.map((v) => (
                  <tr key={v.session_id} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9] cursor-pointer" onClick={() => openChatFromScreen(v.session_id)}>
                    <Td strong>Visitor {v.session_id.slice(-4).toUpperCase()}{v.visits > 1 ? ` · visit ${v.visits}` : ''}</Td>
                    <Td>{v.site_name}</Td>
                    <Td>{v.page_title || (v.page_url ?? '').replace(/^https?:\/\/[^/]+/, '') || 'Home'}</Td>
                    <Td>{[v.city, v.country].filter(Boolean).join(', ') || 'Unknown'}</Td>
                    <Td>{[v.browser, v.os].filter(Boolean).join(' · ') || 'Unknown'}</Td>
                    <Td>{timeAgo(v.last_seen)}</Td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
        </main>
      )}

      {section === 'leads' && (
        <main className="flex-1 min-w-0 overflow-y-auto">
          <PageHead title="Leads" sub={leads ? `${shownLeads.length}${shownLeads.length !== realLeads.length ? ` of ${realLeads.length}` : ' in total'}` : 'Loading…'}
            actions={<input value={leadQuery} onChange={(e) => setLeadQuery(e.target.value)} placeholder="Search name, email, phone or product" aria-label="Search leads" className={`${INPUT} w-[300px]`} />} />
          <div className="px-6 pb-8">
            {leads && shownLeads.length === 0 ? <Empty text={leadQuery ? 'No lead matches that search.' : 'No leads yet. A lead appears here when a visitor leaves their details in a chat or sends a quote form.'} /> : (
              <Table head={['Name', 'Contact', 'Asked for', 'Site', 'Stage', 'Owner', 'Received']}>
                {shownLeads.slice(0, 300).map((l) => {
                  const recordId = l.session_id || `quote-${l.id}`
                  return (
                    <tr key={l.id} tabIndex={0} className="border-t border-[#e9ebed] hover:bg-[#f8f9f9] cursor-pointer outline-none focus-visible:bg-[#edf7ff]"
                      onClick={() => openLead(recordId)} onKeyDown={(e) => { if (e.key === 'Enter') openLead(recordId) }}>
                      <Td strong>{l.name || 'No name given'}</Td>
                      <Td>{l.email || l.phone || 'No contact'}</Td>
                      <Td>{[l.product, l.quantity].filter(Boolean).join(' · ') || (l.message ?? '').replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').slice(0, 60) || 'Not stated'}</Td>
                      <Td>{l.site_id}</Td>
                      <Td>{(l.stage ?? 'new').replace(/_/g, ' ')}</Td>
                      <Td>{short(l.owner) || 'Unassigned'}</Td>
                      <Td>{formatDateTime(l.created_at)}</Td>
                    </tr>
                  )
                })}
              </Table>
            )}
            {shownLeads.length > 300 && <p className="mt-3 text-[12px] text-[#68737d]">Showing the newest 300. Search to find an older lead.</p>}
          </div>
        </main>
      )}

      {section === 'lead' && leadId && <LeadRecord key={leadId} me={me} recordId={leadId} openLead={openLead} openChat={openChatFromScreen} onBack={() => setSection(backTo.current)} />}
      {section === 'inbox' && hasFeature(ws, 'email') && <InboxScreen {...screen} />}
      {section === 'pipeline' && hasFeature(ws, 'pipeline') && <Pipeline {...screen} />}
      {section === 'tasks' && hasFeature(ws, 'tasks') && <Tasks {...screen} />}
      {section === 'reports' && hasFeature(ws, 'reports') && <Reports {...screen} />}
      {section === 'sales' && <Sales {...screen} fromLead={leadId || undefined} />}
      {section === 'team' && <Team {...screen} />}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex gap-2"><dt className="w-12 shrink-0 text-[#68737d]">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>
}
function Fact({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <li className="flex items-start gap-2"><span className="mt-0.5 text-[#68737d]" aria-hidden>{icon}</span><span className="min-w-0 break-words">{text}</span></li>
}
