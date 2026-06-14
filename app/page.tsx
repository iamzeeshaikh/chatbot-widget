'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

const SITE_URLS: Record<string, string> = {
  texasfootball: 'texasfootballuniforms.com',
  volleyballuniforms: 'thevolleyballuniforms.com',
  californiasoccer: 'californiasoccerjerseys.com',
  floridabasketball: 'floridabasketballjerseys.com',
  baseballjerseys: 'thebaseballjerseys.com',
  zeecustomboxes: 'zeecustomboxes.com.au',
  zeepack: 'zeepack.com.au',
  burgersleeves: 'burgersleeves.com.au',
  leadgen: 'leadgen.zeeops.dev',
  shopcardboardboxes: 'shopcardboardboxes.com',
}

const SITE_ACCENT: Record<string, string> = {
  texasfootball: '#ef4444',
  volleyballuniforms: '#f59e0b',
  californiasoccer: '#3b82f6',
  floridabasketball: '#8b5cf6',
  baseballjerseys: '#10b981',
  zeecustomboxes: '#2563eb',
  zeepack: '#0891b2',
  burgersleeves: '#d97706',
  leadgen: '#6366f1',
  shopcardboardboxes: '#b45309',
}

const FAVICON_PACKAGING = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="12" y="40" width="76" height="52" rx="5" fill="#2563eb"/><polygon points="12,40 50,22 88,40" fill="#1d4ed8"/><rect x="38" y="40" width="24" height="52" fill="#93c5fd" opacity="0.35"/></svg>')}`
const FAVICON_SPORTS = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#16a34a"/><path d="M35 22 Q31 50 38 62 Q44 72 50 74 Q56 72 62 62 Q69 50 65 22Z" fill="white"/><path d="M35 30 Q20 30 20 44 Q20 56 35 56" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M65 30 Q80 30 80 44 Q80 56 65 56" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/><rect x="44" y="74" width="12" height="10" rx="2" fill="white"/><rect x="32" y="84" width="36" height="8" rx="3" fill="white"/></svg>')}`

interface Site { site_id: string; name: string; bot_name: string; primary_color: string }
interface Lead { id: string; site_id: string; name: string | null; email: string | null; phone: string | null; message: string | null; created_at: string; product?: string | null; quantity?: string | null; budget?: string | null; timeline?: string | null; qualification_score?: number | null }
interface Session { session_id: string; site_id: string; site_name: string; preview: string; last_at: string; message_count: number; last_role?: string; mode: string; lead: { name: string | null; email: string | null } | null }
interface ChatMsg { id: string; session_id: string; site_id: string; role: string; message: string; created_at: string }
interface Visitor { session_id: string; site_id: string; site_name: string; primary_color: string; page_url: string | null; last_seen: string; created_at: string; device_type: string | null; browser: string | null; os: string | null; country: string | null; city: string | null }

function cleanLeadMessage(msg: string | null): string {
  if (!msg) return '-'
  if (/^(Product|Quantity|Budget|Timeline):/i.test(msg)) {
    const firstLine = msg.split('\n')[0]
    const val = firstLine.slice(firstLine.indexOf(': ') + 2).trim()
    return val || '-'
  }
  for (const line of msg.split('\n')) {
    if (/^user:\s*/i.test(line)) {
      const text = line.replace(/^user:\s*/i, '').trim()
      if (text && !text.includes('(session started)')) return text.slice(0, 150)
    }
  }
  const plain = msg.split('\n').find(l => l.trim() && !/^(user|assistant|bot):\s*/i.test(l))
  return plain?.trim().slice(0, 150) || '-'
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function timeOnSite(created_at: string) {
  const s = Math.floor((Date.now() - new Date(created_at).getTime()) / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function msgDateLabel(ts: string): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })
}

export default function Dashboard() {
  const [tab, setTab] = useState<'overview' | 'conversations'>('overview')

  const [userRole, setUserRole] = useState<'admin' | 'standard'>('standard')
  const [userEmail, setUserEmail] = useState('')
  const [userSites, setUserSites] = useState<string[]>([])
  // Each member belongs to exactly one dashboard ("workspace"), which drives the
  // whole theme — sports admins never see packaging and vice versa.
  const [workspace, setWorkspace] = useState<'sports' | 'packaging'>('packaging')
  const [authReady, setAuthReady] = useState(false)
  // Identity comes from the server (validated session), never the readable
  // cookie — so a stale cookie can't show the wrong workspace/role.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => { if (!r.ok) throw new Error('unauth'); return r.json() })
      .then((m) => {
        setUserRole(m.role); setUserEmail(m.email); setUserSites(m.sites ?? []); setWorkspace(m.workspace)
        setAuthReady(true)
      })
      .catch(() => { window.location.href = '/login' })
  }, [])
  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  const brand = workspace

  useEffect(() => {
    document.title = brand === 'sports' ? 'Sports Dashboard | ZeeOps' : 'Packaging Dashboard | ZeeOps'
    document.querySelectorAll("link[rel='icon'], link[rel='shortcut icon'], link[rel='apple-touch-icon']").forEach((l) => l.remove())
    const link = document.createElement('link')
    link.rel = 'icon'; link.type = 'image/svg+xml'
    link.href = brand === 'sports' ? FAVICON_SPORTS : FAVICON_PACKAGING
    document.head.appendChild(link)
  }, [brand])

  const [sites, setSites] = useState<Site[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [togglingMode, setTogglingMode] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [filterSite, setFilterSite] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmLeadDeleteId, setConfirmLeadDeleteId] = useState<string | null>(null)
  const [deletingLead, setDeletingLead] = useState(false)
  const [editingLeadId, setEditingLeadId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', email: '', phone: '', message: '' })
  const [savingEdit, setSavingEdit] = useState(false)
  const [visitors, setVisitors] = useState<Visitor[]>([])
  const prevVisitorIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/sites').then((r) => r.json()).catch(() => ({ sites: [] })),
      fetch('/api/admin/leads-list').then((r) => r.json()).catch(() => ({ leads: [] })),
    ]).then(([s, l]) => { setSites(s.sites ?? []); setLeads(l.leads ?? []); setOverviewLoading(false) })
  }, [])

  const fetchSessions = useCallback(async () => {
    const data = await fetch('/api/admin/conversations').then((r) => r.json()).catch(() => ({ sessions: [] }))
    setSessions(data.sessions ?? [])
  }, [])

  useEffect(() => {
    if (tab !== 'conversations') return
    fetchSessions()
    const iv = setInterval(fetchSessions, 6000)
    return () => clearInterval(iv)
  }, [tab, fetchSessions])

  const fetchVisitors = useCallback(async () => {
    const data = await fetch('/api/visitor/active').then((r) => r.json()).catch(() => ({ visitors: [] }))
    const incoming: Visitor[] = data.visitors ?? []
    const incomingIds = new Set(incoming.map((v) => v.session_id))
    const prev = prevVisitorIds.current
    if (incoming.some((v) => !prev.has(v.session_id)) && prev.size > 0) {
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
        const osc = ctx.createOscillator(); const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.value = 880; gain.gain.value = 0.1
        osc.start(); osc.stop(ctx.currentTime + 0.12)
      } catch { /* ignore */ }
    }
    prevVisitorIds.current = incomingIds
    setVisitors(incoming)
  }, [])

  useEffect(() => {
    if (tab !== 'conversations') return
    fetchVisitors()
    const iv = setInterval(fetchVisitors, 5000)
    return () => clearInterval(iv)
  }, [tab, fetchVisitors])

  const fetchMessages = useCallback(async (sessionId: string) => {
    const data = await fetch(`/api/admin/messages?sessionId=${sessionId}`).then((r) => r.json()).catch(() => ({ messages: [] }))
    setMessages(data.messages ?? [])
  }, [])

  useEffect(() => {
    if (!selectedSession) return
    fetchMessages(selectedSession.session_id)
    const iv = setInterval(() => fetchMessages(selectedSession.session_id), 3000)
    return () => clearInterval(iv)
  }, [selectedSession, fetchMessages])

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function sendReply() {
    if (!selectedSession || !replyText.trim() || sending) return
    setSending(true)
    await fetch('/api/admin/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, siteId: selectedSession.site_id, message: replyText.trim() }),
    })
    setReplyText('')
    await fetchMessages(selectedSession.session_id)
    setSending(false)
  }

  async function openVisitorSession(visitor: Visitor) {
    const session: Session = {
      session_id: visitor.session_id, site_id: visitor.site_id,
      site_name: visitor.site_name, preview: visitor.page_url ?? '',
      last_at: visitor.last_seen, message_count: 0, mode: 'bot', lead: null,
    }
    setSelectedSession(session)
    setSessions((prev) => prev.some((s) => s.session_id === visitor.session_id) ? prev : [session, ...prev])
  }

  async function toggleMode() {
    if (!selectedSession || togglingMode) return
    setTogglingMode(true)
    const newMode = selectedSession.mode === 'bot' ? 'human' : 'bot'
    await fetch('/api/admin/mode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, mode: newMode }),
    })
    setSelectedSession({ ...selectedSession, mode: newMode })
    setSessions((prev) => prev.map((s) => s.session_id === selectedSession.session_id ? { ...s, mode: newMode } : s))
    setTogglingMode(false)
  }

  async function deleteLead(id: string) {
    setDeletingLead(true)
    await fetch('/api/admin/delete-lead', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    setLeads((prev) => prev.filter((l) => l.id !== id))
    setConfirmLeadDeleteId(null); setDeletingLead(false)
  }

  function startEditLead(lead: Lead) {
    setEditingLeadId(lead.id)
    setEditForm({ name: lead.name ?? '', email: lead.email ?? '', phone: lead.phone ?? '', message: cleanLeadMessage(lead.message) })
  }

  async function saveEditLead(id: string) {
    setSavingEdit(true)
    await fetch('/api/admin/edit-lead', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...editForm }) })
    setLeads((prev) => prev.map((l) => l.id === id ? { ...l, name: editForm.name || null, email: editForm.email || null, phone: editForm.phone || null, message: editForm.message || null } : l))
    setEditingLeadId(null); setSavingEdit(false)
  }

  async function deleteSession(sessionId: string) {
    setDeleting(true)
    await fetch('/api/admin/delete-session', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds: [sessionId] }) })
    setSessions(prev => prev.filter(s => s.session_id !== sessionId))
    if (selectedSession?.session_id === sessionId) setSelectedSession(null)
    setConfirmDeleteId(null); setDeleting(false)
  }

  async function deleteBulk() {
    const ids = Array.from(selectedSessions)
    setDeleting(true)
    await fetch('/api/admin/delete-session', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionIds: ids }) })
    setSessions(prev => prev.filter(s => !ids.includes(s.session_id)))
    if (selectedSession && ids.includes(selectedSession.session_id)) setSelectedSession(null)
    setSelectedSessions(new Set()); setConfirmBulkDelete(false); setDeleting(false)
  }

  // ── Workspace/role filtering ───────────────────────────────────────────────
  // The API already scopes data to the member's sites (workspace + role); this
  // client-side filter against the cookie's site list is a redundant guard.
  const visibleSiteIds = new Set(userSites)
  const inScope = (id: string) => visibleSiteIds.has(id)
  const roleSites = sites.filter((s) => inScope(s.site_id))
  const roleLeads = leads.filter((l) => inScope(l.site_id))
  const roleSessions = sessions.filter((s) => inScope(s.site_id))
  const roleVisitors = visitors.filter((v) => inScope(v.site_id))
  const dashTitle = brand === 'sports' ? '🏆 Sports Dashboard' : '📦 Packaging Dashboard'
  const accentColor = brand === 'sports' ? '#16a34a' : '#2563eb'

  // ── Stats derived ──────────────────────────────────────────────────────────
  const todayStr = new Date().toISOString().split('T')[0]
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const startOfWeek = new Date(today)
  startOfWeek.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1))
  const todayLeads = roleLeads.filter(l => l.created_at?.startsWith(todayStr)).length
  const thisWeekLeads = roleLeads.filter(l => new Date(l.created_at) >= startOfWeek).length

  // ── Bar chart: leads per day last 7 days ──────────────────────────────────
  const chartDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (6 - i))
      const key = d.toISOString().split('T')[0]
      return { key, label: d.toLocaleDateString('en', { weekday: 'short' }), count: 0 }
    }).map(day => ({ ...day, count: roleLeads.filter(l => l.created_at?.startsWith(day.key)).length }))
  }, [roleLeads])
  const chartMax = Math.max(...chartDays.map(d => d.count), 1)

  // ── Session filters ────────────────────────────────────────────────────────
  const sessionSites = Array.from(new Map(roleSessions.map(s => [s.site_id, s.site_name])).entries())
    .map(([id, name]) => ({ site_id: id, site_name: name }))

  const filteredSessions = roleSessions.filter(s => {
    if (filterSite && s.site_id !== filterSite) return false
    if (filterStatus === 'bot' && s.mode !== 'bot') return false
    if (filterStatus === 'human' && s.mode !== 'human') return false
    if (filterStatus === 'lead' && !s.lead) return false
    if (filterStatus === 'no-response' && s.last_role !== 'user') return false
    if (searchQuery && !s.preview.toLowerCase().includes(searchQuery.toLowerCase())) return false
    return true
  })

  // ── Message date grouping ──────────────────────────────────────────────────
  const visibleMessages = messages.filter(m => m.message !== '(session started)')
  const messageDates = useMemo(() => {
    const seen = new Set<string>()
    return visibleMessages.map(m => {
      const label = msgDateLabel(m.created_at)
      if (seen.has(label)) return { ...m, showDate: false }
      seen.add(label)
      return { ...m, showDate: true, dateLabel: label }
    })
  }, [visibleMessages])

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!authReady) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center gap-3 text-gray-500 text-sm">
        <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
        Loading dashboard…
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">

      {/* ── Header ── */}
      <div className="border-b border-gray-800/80 bg-gray-950/95 backdrop-blur px-5 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-lg" style={{ backgroundColor: accentColor }}>
            <svg viewBox="0 0 24 24" className="w-4.5 h-4.5 fill-white w-5 h-5"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <div>
            <h1 className="text-base font-bold text-white leading-tight">{dashTitle}</h1>
            <p className="text-gray-500 text-[11px] flex items-center gap-1.5">
              {userEmail}
              <span className={`px-1.5 py-px rounded-full text-[9px] font-semibold uppercase tracking-wide ${userRole === 'admin' ? 'bg-purple-500/20 text-purple-300' : 'bg-gray-700 text-gray-400'}`}>{userRole}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 bg-gray-900 p-1 rounded-lg border border-gray-800">
            <button onClick={() => setTab('overview')} className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all ${tab === 'overview' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}>Overview</button>
            <button onClick={() => setTab('conversations')} className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 ${tab === 'conversations' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}>
              Conversations
              {roleSessions.length > 0 && <span className="bg-blue-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-semibold">{roleSessions.length}</span>}
              {roleVisitors.length > 0 && <span className="bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-semibold">{roleVisitors.length} live</span>}
            </button>
          </div>
          {userRole === 'admin' && (
            <a href="/members" className="px-3 py-1.5 text-xs text-gray-300 hover:text-white bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg transition-colors flex items-center gap-1.5">
              👥 Members
            </a>
          )}
          <button onClick={handleLogout} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-lg transition-colors">
            Sign out
          </button>
        </div>
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === 'overview' && (
        <div className="p-6 max-w-6xl mx-auto">
          {overviewLoading ? (
            <div className="flex items-center gap-3 py-12 text-gray-500">
              <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
              <span className="text-sm">Loading dashboard...</span>
            </div>
          ) : (
            <>
              {/* Stats row */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                {[
                  { label: 'Total Sites', value: roleSites.length, icon: '🏆', color: 'from-blue-500/10 to-blue-600/5', border: 'border-blue-500/20' },
                  { label: 'Total Leads', value: roleLeads.length, icon: '👥', color: 'from-green-500/10 to-green-600/5', border: 'border-green-500/20' },
                  { label: 'Active Bots', value: roleSites.length, icon: '🤖', color: 'from-purple-500/10 to-purple-600/5', border: 'border-purple-500/20' },
                  { label: "Today's Leads", value: todayLeads, icon: '📅', color: 'from-orange-500/10 to-orange-600/5', border: 'border-orange-500/20' },
                  { label: "This Week", value: thisWeekLeads, icon: '📈', color: 'from-cyan-500/10 to-cyan-600/5', border: 'border-cyan-500/20' },
                ].map((s) => (
                  <div key={s.label} className={`bg-gradient-to-br ${s.color} rounded-xl p-4 border ${s.border} bg-gray-900`}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-gray-400 text-xs font-medium">{s.label}</p>
                      <span className="text-lg">{s.icon}</span>
                    </div>
                    <p className="text-3xl font-bold text-white">{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Chart + Sites row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                {/* Bar chart */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-white">Leads — Last 7 Days</h2>
                    <span className="text-xs text-gray-500">{roleLeads.length} total</span>
                  </div>
                  <div className="flex items-end gap-2 h-24">
                    {chartDays.map((day) => {
                      const pct = chartMax > 0 ? (day.count / chartMax) * 100 : 0
                      const isToday = day.key === todayStr
                      return (
                        <div key={day.key} className="flex-1 flex flex-col items-center gap-1">
                          {day.count > 0 && <span className="text-[10px] text-gray-400">{day.count}</span>}
                          <div className="w-full flex items-end" style={{ height: '72px' }}>
                            <div
                              className={`w-full rounded-t-md transition-all ${isToday ? 'opacity-100' : 'opacity-60'}`}
                              style={{
                                height: `${Math.max(pct, day.count > 0 ? 8 : 2)}%`,
                                minHeight: day.count > 0 ? '6px' : '2px',
                                backgroundColor: isToday ? accentColor : '#374151',
                              }}
                            />
                          </div>
                          <span className={`text-[10px] ${isToday ? 'text-white font-semibold' : 'text-gray-500'}`}>{day.label}</span>
                        </div>
                      )
                    })}
                  </div>
                  {roleLeads.length === 0 && (
                    <p className="text-xs text-gray-600 text-center mt-2">No leads captured yet</p>
                  )}
                </div>

                {/* Quick stats per site */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <h2 className="text-sm font-semibold text-white mb-4">Leads by Site</h2>
                  <div className="space-y-2.5">
                    {roleSites.length === 0 ? (
                      <p className="text-xs text-gray-500">No sites configured</p>
                    ) : roleSites.map((site) => {
                      const count = roleLeads.filter(l => l.site_id === site.site_id).length
                      const pct = roleLeads.length > 0 ? Math.round((count / roleLeads.length) * 100) : 0
                      const accent = SITE_ACCENT[site.site_id] ?? accentColor
                      return (
                        <div key={site.site_id}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-gray-300 truncate">{site.name}</span>
                            <span className="text-xs text-gray-500 shrink-0 ml-2">{count} leads</span>
                          </div>
                          <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: accent }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* Site cards */}
              <div className="mb-6">
                <h2 className="text-sm font-semibold text-white mb-3">Configured Sites</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
                  {roleSites.map((site) => {
                    const accent = SITE_ACCENT[site.site_id] ?? site.primary_color
                    const url = SITE_URLS[site.site_id]
                    const count = roleLeads.filter((l) => l.site_id === site.site_id).length
                    return (
                      <div key={site.site_id} className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden hover:border-gray-700 transition-colors group">
                        <div className="h-1" style={{ backgroundColor: accent }} />
                        <div className="p-4">
                          <div className="flex items-center gap-2.5 mb-3">
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm" style={{ backgroundColor: accent }}>
                              {site.bot_name?.[0]?.toUpperCase() ?? 'B'}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-white text-sm truncate">{site.name}</p>
                              <p className="text-gray-500 text-[11px] truncate">{site.bot_name}</p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t border-gray-800/60">
                            <span className="text-xs font-medium" style={{ color: accent }}>{count} lead{count !== 1 ? 's' : ''}</span>
                            {url ? (
                              <a href={`https://${url}`} target="_blank" rel="noopener noreferrer"
                                className="text-[11px] text-gray-500 hover:text-blue-400 transition-colors truncate max-w-[120px]" title={url}>
                                {url}
                              </a>
                            ) : (
                              <span className="text-[11px] text-gray-600 font-mono">{site.site_id}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Leads table */}
              <div>
                <h2 className="text-sm font-semibold text-white mb-3">Recent Leads</h2>
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[1100px]">
                      <thead>
                        <tr className="border-b border-gray-800 bg-gray-800/40">
                          {['Score', 'Name', 'Email', 'Phone', 'Message', 'Product', 'Qty', 'Budget', 'Timeline', 'Site', 'Date', ''].map((h) => (
                            <th key={h} className="text-left px-3 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {roleLeads.length === 0 ? (
                          <tr>
                            <td colSpan={12} className="text-center py-12">
                              <p className="text-2xl mb-2">📭</p>
                              <p className="text-gray-500 text-sm">No leads captured yet</p>
                              <p className="text-gray-600 text-xs mt-1">Leads appear here when the bot qualifies a visitor</p>
                            </td>
                          </tr>
                        ) : roleLeads.map((lead) => {
                          const msgLines: Record<string, string> = {}
                          for (const line of (lead.message ?? '').split('\n')) {
                            const colon = line.indexOf(': ')
                            if (colon > 0) msgLines[line.slice(0, colon).toLowerCase()] = line.slice(colon + 2)
                          }
                          const product = lead.product ?? msgLines['product'] ?? '-'
                          const quantity = lead.quantity ?? msgLines['quantity'] ?? '-'
                          const budget = lead.budget ?? msgLines['budget'] ?? '-'
                          const timeline = lead.timeline ?? msgLines['timeline'] ?? '-'
                          const score = lead.qualification_score ?? null
                          const siteName = roleSites.find((s) => s.site_id === lead.site_id)?.name ?? sites.find((s) => s.site_id === lead.site_id)?.name ?? lead.site_id
                          const isEditing = editingLeadId === lead.id
                          const isConfirmingDelete = confirmLeadDeleteId === lead.id
                          const accent = SITE_ACCENT[lead.site_id] ?? '#6b7280'

                          if (isEditing) return (
                            <tr key={lead.id} className="border-b border-gray-800/50 bg-gray-800/40">
                              <td className="px-3 py-2">{score !== null ? <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${score >= 7 ? 'bg-green-500/20 text-green-400 border border-green-500/30' : score >= 4 ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-gray-700 text-gray-400'}`}>{score}/7</span> : <span className="text-gray-600 text-xs">-</span>}</td>
                              <td className="px-3 py-2"><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white w-full min-w-[80px] focus:outline-none focus:border-blue-500" placeholder="Name" /></td>
                              <td className="px-3 py-2"><input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-blue-300 w-full min-w-[140px] focus:outline-none focus:border-blue-500" placeholder="Email" /></td>
                              <td className="px-3 py-2"><input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 w-full min-w-[100px] focus:outline-none focus:border-blue-500" placeholder="Phone" /></td>
                              <td className="px-3 py-2" colSpan={5}><input value={editForm.message} onChange={(e) => setEditForm({ ...editForm, message: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 w-full focus:outline-none focus:border-blue-500" placeholder="Message" /></td>
                              <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{siteName}</td>
                              <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{lead.created_at ? new Date(lead.created_at).toLocaleString() : '-'}</td>
                              <td className="px-3 py-2"><div className="flex gap-1"><button onClick={() => saveEditLead(lead.id)} disabled={savingEdit} className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded transition-colors disabled:opacity-50">{savingEdit ? '…' : 'Save'}</button><button onClick={() => setEditingLeadId(null)} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded transition-colors">Cancel</button></div></td>
                            </tr>
                          )

                          return (
                            <tr key={lead.id} className="group border-b border-gray-800/40 hover:bg-gray-800/25 transition-colors">
                              <td className="px-3 py-3">{score !== null ? <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${score >= 7 ? 'bg-green-500/20 text-green-400 border border-green-500/30' : score >= 4 ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-gray-700 text-gray-400'}`}>{score}/7</span> : <span className="text-gray-600 text-xs">-</span>}</td>
                              <td className="px-3 py-3 text-white font-medium whitespace-nowrap">{lead.name || '-'}</td>
                              <td className="px-3 py-3 text-blue-400 whitespace-nowrap">{lead.email || '-'}</td>
                              <td className="px-3 py-3 text-gray-300 whitespace-nowrap">{lead.phone || '-'}</td>
                              <td className="px-3 py-3 text-gray-400 max-w-[150px] truncate" title={cleanLeadMessage(lead.message) !== '-' ? cleanLeadMessage(lead.message) : undefined}>{cleanLeadMessage(lead.message)}</td>
                              <td className="px-3 py-3 text-gray-300 max-w-[120px] truncate" title={product !== '-' ? product : undefined}>{product}</td>
                              <td className="px-3 py-3 text-gray-400 whitespace-nowrap">{quantity}</td>
                              <td className="px-3 py-3 text-gray-400 whitespace-nowrap">{budget}</td>
                              <td className="px-3 py-3 text-gray-400 whitespace-nowrap">{timeline}</td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${accent}20`, color: accent }}>{siteName}</span>
                              </td>
                              <td className="px-3 py-3 text-gray-500 text-xs whitespace-nowrap">{lead.created_at ? new Date(lead.created_at).toLocaleString() : '-'}</td>
                              <td className="px-3 py-3">
                                {isConfirmingDelete ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-300">Delete?</span>
                                    <button onClick={() => deleteLead(lead.id)} disabled={deletingLead} className="text-xs text-red-400 hover:text-red-300 font-semibold">Yes</button>
                                    <span className="text-xs text-gray-600 mx-0.5">·</span>
                                    <button onClick={() => setConfirmLeadDeleteId(null)} className="text-xs text-gray-400 hover:text-gray-300">No</button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onClick={() => startEditLead(lead)} className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-gray-700/60 rounded-lg transition-colors" title="Edit">✏️</button>
                                    <button onClick={() => setConfirmLeadDeleteId(lead.id)} className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-700/60 rounded-lg transition-colors" title="Delete">🗑</button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CONVERSATIONS TAB ── */}
      {tab === 'conversations' && (
        <div className="flex" style={{ height: 'calc(100vh - 57px)' }}>

          {/* ── Left sidebar ── */}
          <div className="w-[300px] flex-shrink-0 border-r border-gray-800/80 flex flex-col bg-gray-900/30">

            {/* Live visitors */}
            {roleVisitors.length > 0 && (
              <div className="border-b border-gray-800">
                <div className="px-3 py-2 flex items-center gap-2 bg-green-950/30">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse shrink-0" />
                  <p className="text-[11px] text-green-400 font-semibold uppercase tracking-wider">{roleVisitors.length} Live {roleVisitors.length === 1 ? 'Visitor' : 'Visitors'}</p>
                </div>
                {roleVisitors.map((v) => {
                  const accent = SITE_ACCENT[v.site_id] ?? '#16a34a'
                  return (
                    <button key={v.session_id} onClick={() => openVisitorSession(v)}
                      className="w-full text-left px-3 py-2 border-t border-gray-800/40 hover:bg-green-900/15 transition-colors flex items-center gap-2.5"
                      style={{ borderLeft: `3px solid ${accent}` }}>
                      <span className="text-base shrink-0">{v.device_type === 'Mobile' ? '📱' : v.device_type === 'Tablet' ? '📟' : '💻'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-semibold text-gray-100 truncate">{v.site_name}</span>
                          <span className="text-[10px] text-gray-500 shrink-0">{timeAgo(v.last_seen)}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {v.country && <span className="text-[11px] text-gray-400 truncate">{v.country.split(' ').slice(-1)[0]}</span>}
                          <span className="text-[10px] text-gray-600">·</span>
                          <span className="text-[10px] text-green-600">on site {timeOnSite(v.created_at)}</span>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Filters */}
            <div className="p-2.5 border-b border-gray-800 space-y-2 flex-shrink-0">
              <div className="flex gap-1.5">
                <select value={filterSite} onChange={e => setFilterSite(e.target.value)} className="flex-1 bg-gray-800/60 border border-gray-700/60 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500">
                  <option value="">All Sites</option>
                  {sessionSites.map(s => <option key={s.site_id} value={s.site_id}>{s.site_name}</option>)}
                </select>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="flex-1 bg-gray-800/60 border border-gray-700/60 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500">
                  <option value="all">All</option>
                  <option value="bot">Bot</option>
                  <option value="human">Human</option>
                  <option value="lead">Lead</option>
                  <option value="no-response">No reply</option>
                </select>
              </div>
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search…"
                className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500" />
              {(filterSite || filterStatus !== 'all' || searchQuery) && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">{filteredSessions.length} result{filteredSessions.length !== 1 ? 's' : ''}</span>
                  <button onClick={() => { setFilterSite(''); setFilterStatus('all'); setSearchQuery('') }} className="text-[11px] text-blue-400 hover:text-blue-300">Clear</button>
                </div>
              )}
            </div>

            {/* Bulk select bar */}
            <div className="px-3 py-1.5 border-b border-gray-800/60 flex items-center gap-2 flex-shrink-0">
              <input type="checkbox"
                checked={filteredSessions.length > 0 && filteredSessions.every(s => selectedSessions.has(s.session_id))}
                onChange={e => { if (e.target.checked) setSelectedSessions(new Set(filteredSessions.map(s => s.session_id))); else setSelectedSessions(new Set()) }}
                className="rounded accent-blue-500 cursor-pointer" />
              <span className="text-[11px] text-gray-500 flex-1">{selectedSessions.size > 0 ? `${selectedSessions.size} selected` : `${filteredSessions.length} sessions`}</span>
              {selectedSessions.size > 0 && (
                confirmBulkDelete ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-red-400">Delete {selectedSessions.size}?</span>
                    <button onClick={deleteBulk} disabled={deleting} className="text-[11px] text-red-400 font-semibold ml-1">Yes</button>
                    <span className="text-[11px] text-gray-600 mx-0.5">·</span>
                    <button onClick={() => setConfirmBulkDelete(false)} className="text-[11px] text-gray-400">No</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmBulkDelete(true)} className="text-[11px] text-red-400 hover:text-red-300">Delete</button>
                )
              )}
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto">
              {filteredSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4 py-12">
                  <p className="text-3xl mb-3">🗂️</p>
                  <p className="text-sm text-gray-400">{roleSessions.length === 0 ? 'No conversations yet' : 'No results match'}</p>
                  <p className="text-xs text-gray-600 mt-1">{roleSessions.length === 0 ? 'Conversations appear here in real time' : 'Try adjusting your filters'}</p>
                </div>
              ) : filteredSessions.map((s) => {
                const isSelected = selectedSessions.has(s.session_id)
                const isActive = selectedSession?.session_id === s.session_id
                const isConfirming = confirmDeleteId === s.session_id
                const accent = SITE_ACCENT[s.site_id] ?? '#6b7280'
                const hasUnread = s.last_role === 'user'
                return (
                  <div key={s.session_id}
                    className={`group relative flex border-b border-gray-800/40 transition-all ${isActive ? 'bg-gray-800/70' : 'hover:bg-gray-800/40'} ${isSelected ? 'ring-1 ring-inset ring-blue-500/20 bg-blue-950/20' : ''}`}
                    style={{ borderLeft: `3px solid ${isActive ? accent : 'transparent'}` }}>
                    <div className="flex items-center px-2 py-3 shrink-0" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={isSelected}
                        onChange={e => { const n = new Set(selectedSessions); if (e.target.checked) n.add(s.session_id); else n.delete(s.session_id); setSelectedSessions(n) }}
                        className="rounded accent-blue-500 cursor-pointer" />
                    </div>
                    <div className="flex-1 min-w-0 py-2.5 pr-7 cursor-pointer" onClick={() => setSelectedSession(s)}>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
                          <span className={`text-xs truncate ${hasUnread ? 'font-semibold text-white' : 'font-medium text-gray-300'}`}>{s.site_name}</span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0 ml-1">
                          {s.mode === 'human' && <span className="w-1.5 h-1.5 rounded-full bg-orange-400" title="Human mode" />}
                          <span className="text-[10px] text-gray-600">{timeAgo(s.last_at)}</span>
                        </div>
                      </div>
                      <p className={`text-xs truncate mb-1 ${hasUnread ? 'text-gray-200' : 'text-gray-500'}`}>{s.preview || '(no messages)'}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-600">{s.message_count} msgs</span>
                        {s.lead && <span className="text-[10px] text-green-400 font-medium">● Lead</span>}
                      </div>
                    </div>
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2" onClick={e => e.stopPropagation()}>
                      {isConfirming ? (
                        <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-1.5 py-1 shadow-lg">
                          <button onClick={() => deleteSession(s.session_id)} disabled={deleting} className="text-[11px] text-red-400 font-semibold">Yes</button>
                          <span className="text-[11px] text-gray-600">·</span>
                          <button onClick={() => setConfirmDeleteId(null)} className="text-[11px] text-gray-400">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(s.session_id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-600 hover:text-red-400 hover:bg-gray-700/60 rounded-lg transition-all text-xs">
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Right panel ── */}
          <div className="flex-1 flex flex-col min-w-0">
            {!selectedSession ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center px-8">
                  <div className="w-16 h-16 rounded-2xl bg-gray-800 flex items-center justify-center mx-auto mb-4 border border-gray-700">
                    <svg viewBox="0 0 24 24" className="w-8 h-8 fill-gray-600"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                  </div>
                  <p className="text-gray-300 font-medium text-sm mb-1">Select a conversation</p>
                  <p className="text-gray-600 text-xs">Click any session on the left to view messages and manage the conversation</p>
                </div>
              </div>
            ) : (
              <>
                {/* Conversation header */}
                <div className="px-5 py-3 border-b border-gray-800/80 bg-gray-900/40 flex items-center justify-between flex-shrink-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
                      style={{ backgroundColor: SITE_ACCENT[selectedSession.site_id] ?? accentColor }}>
                      {selectedSession.site_name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-white text-sm">{selectedSession.site_name}</p>
                      <p className="text-[10px] text-gray-600 font-mono truncate">{selectedSession.session_id}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-medium ${selectedSession.mode === 'bot' ? 'text-blue-400' : 'text-gray-600'}`}>Bot</span>
                    <button onClick={toggleMode} disabled={togglingMode}
                      className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${selectedSession.mode === 'human' ? 'bg-orange-500' : 'bg-blue-600'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${selectedSession.mode === 'human' ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                    <span className={`text-xs font-medium ${selectedSession.mode === 'human' ? 'text-orange-400' : 'text-gray-600'}`}>Human</span>
                    {selectedSession.mode === 'human' && (
                      <span className="text-[10px] bg-orange-500/15 text-orange-300 px-2 py-0.5 rounded-full border border-orange-500/25">AI off</span>
                    )}
                  </div>
                </div>

                {/* Messages area */}
                <div className="flex-1 overflow-y-auto px-5 py-4 bg-gray-950/50 space-y-1">
                  {messageDates.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <p className="text-gray-600 text-sm">No messages yet</p>
                    </div>
                  ) : messageDates.map((msg) => {
                    const isUser = msg.role === 'user'
                    const isAdmin = msg.role === 'admin'
                    const showDate = (msg as typeof msg & { showDate?: boolean; dateLabel?: string }).showDate
                    const dateLabel = (msg as typeof msg & { dateLabel?: string }).dateLabel
                    return (
                      <div key={msg.id}>
                        {showDate && (
                          <div className="flex items-center gap-3 my-4">
                            <div className="flex-1 h-px bg-gray-800" />
                            <span className="text-[11px] text-gray-600 font-medium px-2">{dateLabel}</span>
                            <div className="flex-1 h-px bg-gray-800" />
                          </div>
                        )}
                        <div className={`flex flex-col mb-2 ${isUser ? 'items-end' : 'items-start'}`}>
                          <div className="flex items-center gap-1.5 mb-1 px-1">
                            {!isUser && <span className={`text-[11px] font-semibold ${isAdmin ? 'text-orange-400' : 'text-blue-400'}`}>{isAdmin ? '👤 Agent' : '🤖 Bot'}</span>}
                            {isUser && <span className="text-[11px] text-gray-600">Visitor</span>}
                            <span className="text-[10px] text-gray-700">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          <div className={`max-w-sm lg:max-w-md xl:max-w-lg px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                            isUser
                              ? 'bg-gray-700/80 text-gray-100 rounded-tr-sm border border-gray-600/30'
                              : isAdmin
                              ? 'bg-amber-900/40 text-amber-100 rounded-tl-sm border border-amber-700/30'
                              : 'bg-slate-800/80 text-gray-100 rounded-tl-sm border border-slate-700/30'
                          }`}>
                            {msg.message}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {sending && (
                    <div className="flex items-start gap-2 mb-2">
                      <div className="bg-slate-800/80 border border-slate-700/30 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Reply input */}
                <div className="px-4 py-3 border-t border-gray-800/80 bg-gray-900/60 flex-shrink-0">
                  {selectedSession.mode === 'bot' && (
                    <p className="text-[11px] text-blue-400/70 mb-2 flex items-center gap-1.5">
                      <span>🤖</span> Bot is active — toggle to Human to send replies
                    </p>
                  )}
                  <div className="flex gap-2">
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } }}
                      placeholder={selectedSession.mode === 'human' ? 'Type a reply…' : 'Switch to Human to reply'}
                      disabled={selectedSession.mode === 'bot' || sending}
                      rows={2}
                      className="flex-1 bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 resize-none focus:outline-none focus:border-orange-500/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    />
                    <button
                      onClick={sendReply}
                      disabled={!replyText.trim() || sending || selectedSession.mode === 'bot'}
                      className="px-4 py-2 bg-orange-500 text-white rounded-xl text-sm font-medium hover:bg-orange-600 active:bg-orange-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed self-end"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
