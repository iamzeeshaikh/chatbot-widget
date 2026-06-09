'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

interface Site { site_id: string; name: string; bot_name: string; primary_color: string }
interface Lead { id: string; site_id: string; name: string | null; email: string | null; phone: string | null; message: string | null; created_at: string }
interface Session { session_id: string; site_id: string; site_name: string; preview: string; last_at: string; message_count: number; mode: string; lead: { name: string | null; email: string | null } | null }
interface ChatMsg { id: string; session_id: string; site_id: string; role: string; message: string; created_at: string }
interface Visitor { session_id: string; site_id: string; site_name: string; primary_color: string; page_url: string | null; last_seen: string; created_at: string }

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function Dashboard() {
  const [tab, setTab] = useState<'overview' | 'conversations'>('overview')

  // Overview state
  const [sites, setSites] = useState<Site[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  const [overviewLoading, setOverviewLoading] = useState(true)

  // Conversations state
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [togglingMode, setTogglingMode] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Live visitors state
  const [visitors, setVisitors] = useState<Visitor[]>([])
  const prevVisitorIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/sites').then((r) => r.json()).catch(() => ({ sites: [] })),
      fetch('/api/admin/leads-list').then((r) => r.json()).catch(() => ({ leads: [] })),
    ]).then(([s, l]) => {
      setSites(s.sites ?? [])
      setLeads(l.leads ?? [])
      setOverviewLoading(false)
    })
  }, [])

  // ── Sessions polling ───────────────────────────────────────────────────────
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

  // ── Live visitors polling ──────────────────────────────────────────────────
  const fetchVisitors = useCallback(async () => {
    const data = await fetch('/api/visitor/active').then((r) => r.json()).catch(() => ({ visitors: [] }))
    const incoming: Visitor[] = data.visitors ?? []
    const incomingIds = new Set(incoming.map((v) => v.session_id))
    // Beep on new visitor
    const prev = prevVisitorIds.current
    const isNew = incoming.some((v) => !prev.has(v.session_id))
    if (isNew && prev.size > 0) {
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.value = 880; gain.gain.value = 0.1
        osc.start(); osc.stop(ctx.currentTime + 0.12)
      } catch { /* ignore audio errors */ }
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

  // ── Messages polling ───────────────────────────────────────────────────────
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

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Actions ────────────────────────────────────────────────────────────────
  async function sendReply() {
    if (!selectedSession || !replyText.trim() || sending) return
    setSending(true)
    await fetch('/api/admin/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, siteId: selectedSession.site_id, message: replyText.trim() }),
    })
    setReplyText('')
    await fetchMessages(selectedSession.session_id)
    setSending(false)
  }

  async function openVisitorSession(visitor: Visitor) {
    // Set to human mode then open conversation
    await fetch('/api/admin/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: visitor.session_id, mode: 'human' }),
    })
    const session: Session = {
      session_id: visitor.session_id,
      site_id: visitor.site_id,
      site_name: visitor.site_name,
      preview: visitor.page_url ?? '',
      last_at: visitor.last_seen,
      message_count: 0,
      mode: 'human',
      lead: null,
    }
    setSelectedSession(session)
    setSessions((prev) => {
      const exists = prev.some((s) => s.session_id === visitor.session_id)
      return exists
        ? prev.map((s) => s.session_id === visitor.session_id ? { ...s, mode: 'human' } : s)
        : [session, ...prev]
    })
  }

  async function toggleMode() {
    if (!selectedSession || togglingMode) return
    setTogglingMode(true)
    const newMode = selectedSession.mode === 'bot' ? 'human' : 'bot'
    await fetch('/api/admin/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, mode: newMode }),
    })
    setSelectedSession({ ...selectedSession, mode: newMode })
    setSessions((prev) => prev.map((s) => s.session_id === selectedSession.session_id ? { ...s, mode: newMode } : s))
    setTogglingMode(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Chatbot Widget Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">Manage your sites, leads, and conversations</p>
        </div>
        <div className="flex gap-1 bg-gray-900 p-1 rounded-lg border border-gray-800">
          <button onClick={() => setTab('overview')} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'overview' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>Overview</button>
          <button onClick={() => setTab('conversations')} className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${tab === 'conversations' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
            Conversations
            {sessions.length > 0 && <span className="ml-1.5 bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full">{sessions.length}</span>}
            {visitors.length > 0 && <span className="ml-1 bg-green-500 text-white text-xs px-1.5 py-0.5 rounded-full">{visitors.length} live</span>}
          </button>
        </div>
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === 'overview' && (
        <div className="p-6 max-w-6xl mx-auto">
          {overviewLoading ? (
            <p className="text-gray-500 text-sm">Loading...</p>
          ) : (
            <>
              {/* Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
                {[
                  { label: 'Total Sites', value: sites.length },
                  { label: 'Total Leads', value: leads.length },
                  { label: 'Active Bots', value: sites.length },
                  { label: "Today's Leads", value: leads.filter((l) => l.created_at?.startsWith(new Date().toISOString().split('T')[0])).length },
                ].map((s) => (
                  <div key={s.label} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                    <p className="text-gray-400 text-sm">{s.label}</p>
                    <p className="text-3xl font-bold text-white mt-1">{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Sites */}
              <div className="mb-8">
                <h2 className="text-xl font-semibold text-white mb-4">Configured Sites</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {sites.map((site) => (
                    <div key={site.site_id} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold" style={{ backgroundColor: site.primary_color }}>
                          {site.bot_name?.[0] ?? 'B'}
                        </div>
                        <div>
                          <p className="font-semibold text-white text-sm">{site.name}</p>
                          <p className="text-gray-400 text-xs">{site.bot_name}</p>
                        </div>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-500 font-mono bg-gray-800 px-2 py-1 rounded">{site.site_id}</span>
                        <span className="text-xs text-gray-400">{leads.filter((l) => l.site_id === site.site_id).length} leads</span>
                      </div>
                      <div className="mt-3 pt-3 border-t border-gray-800">
                        <p className="text-xs text-gray-500 font-mono break-all">{'?siteId=' + site.site_id}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Leads */}
              <div>
                <h2 className="text-xl font-semibold text-white mb-4">Recent Leads</h2>
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-800 bg-gray-800/50">
                          {['Name', 'Email', 'Phone', 'Site', 'Message', 'Date'].map((h) => (
                            <th key={h} className="text-left px-4 py-3 text-gray-400 font-medium">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {leads.length === 0 ? (
                          <tr><td colSpan={6} className="text-center py-8 text-gray-500">No leads yet</td></tr>
                        ) : leads.map((lead) => (
                          <tr key={lead.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                            <td className="px-4 py-3 text-white">{lead.name ?? '-'}</td>
                            <td className="px-4 py-3 text-blue-400">{lead.email ?? '-'}</td>
                            <td className="px-4 py-3 text-gray-300">{lead.phone ?? '-'}</td>
                            <td className="px-4 py-3"><span className="bg-gray-800 text-gray-300 text-xs px-2 py-1 rounded font-mono">{lead.site_id}</span></td>
                            <td className="px-4 py-3 text-gray-400 max-w-xs truncate">{lead.message ?? '-'}</td>
                            <td className="px-4 py-3 text-gray-500 text-xs">{lead.created_at ? new Date(lead.created_at).toLocaleString() : '-'}</td>
                          </tr>
                        ))}
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
        <div className="flex h-[calc(100vh-73px)]">
          {/* Session list */}
          <div className="w-80 flex-shrink-0 border-r border-gray-800 overflow-y-auto bg-gray-900/50">
            {/* Live Visitors */}
            {visitors.length > 0 && (
              <div className="border-b border-gray-800">
                <div className="px-3 py-2 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  <p className="text-xs text-green-400 font-medium uppercase tracking-wide">{visitors.length} Live Visitor{visitors.length !== 1 ? 's' : ''}</p>
                </div>
                {visitors.map((v) => (
                  <button
                    key={v.session_id}
                    onClick={() => openVisitorSession(v)}
                    className="w-full text-left px-3 py-2.5 border-t border-gray-800/60 hover:bg-green-900/20 transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                      <span className="text-xs font-medium text-gray-200 truncate">{v.site_name}</span>
                      <span className="text-xs text-gray-500 shrink-0 ml-auto">{timeAgo(v.last_seen)}</span>
                    </div>
                    {v.page_url && (
                      <p className="text-xs text-gray-500 truncate pl-3.5">{v.page_url.replace(/^https?:\/\//, '')}</p>
                    )}
                    <p className="text-xs text-green-500 pl-3.5 mt-0.5">Click to take over →</p>
                  </button>
                ))}
              </div>
            )}
            <div className="p-3 border-b border-gray-800">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">All Sessions ({sessions.length})</p>
            </div>
            {sessions.length === 0 ? (
              <p className="text-gray-500 text-sm p-4">No conversations yet</p>
            ) : sessions.map((s) => (
              <button
                key={s.session_id}
                onClick={() => setSelectedSession(s)}
                className={`w-full text-left px-4 py-3 border-b border-gray-800/60 hover:bg-gray-800/60 transition-colors ${selectedSession?.session_id === s.session_id ? 'bg-gray-800' : ''}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-medium text-gray-200 truncate">{s.site_name}</span>
                    <span className="text-xs font-mono text-gray-600 shrink-0">#{s.site_id}</span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    {s.mode === 'human' && <span className="w-1.5 h-1.5 rounded-full bg-orange-400" title="Human Agent mode" />}
                    <span className="text-xs text-gray-500">{timeAgo(s.last_at)}</span>
                  </div>
                </div>
                <p className="text-sm text-gray-200 truncate">{s.preview || '(no messages)'}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-gray-500">{s.message_count} messages</span>
                  {s.lead && <span className="text-xs text-green-400">● Lead captured</span>}
                </div>
              </button>
            ))}
          </div>

          {/* Conversation view */}
          <div className="flex-1 flex flex-col min-w-0">
            {!selectedSession ? (
              <div className="flex-1 flex items-center justify-center text-gray-500">
                <div className="text-center">
                  <p className="text-4xl mb-3">💬</p>
                  <p className="text-sm">Select a conversation to view</p>
                </div>
              </div>
            ) : (
              <>
                {/* Conversation header */}
                <div className="px-5 py-3 border-b border-gray-800 bg-gray-900/50 flex items-center justify-between flex-shrink-0">
                  <div>
                    <p className="font-semibold text-white text-sm">{selectedSession.site_name}</p>
                    <p className="text-xs text-gray-500 font-mono mt-0.5">{selectedSession.session_id}</p>
                  </div>
                  {/* Bot toggle */}
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-medium ${selectedSession.mode === 'bot' ? 'text-blue-400' : 'text-gray-500'}`}>Bot</span>
                    <button
                      onClick={toggleMode}
                      disabled={togglingMode}
                      className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none ${selectedSession.mode === 'human' ? 'bg-orange-500' : 'bg-blue-600'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${selectedSession.mode === 'human' ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                    <span className={`text-xs font-medium ${selectedSession.mode === 'human' ? 'text-orange-400' : 'text-gray-500'}`}>Human Agent</span>
                    {selectedSession.mode === 'human' && (
                      <span className="text-xs bg-orange-500/20 text-orange-300 px-2 py-0.5 rounded-full border border-orange-500/30">Gemini bypassed</span>
                    )}
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-950">
                  {messages.filter((m) => m.message !== '(session started)').map((msg) => {
                    const isUser = msg.role === 'user'
                    const isAdmin = msg.role === 'admin'
                    const isBot = msg.role === 'assistant'
                    return (
                      <div key={msg.id} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                        <div className="flex items-center gap-1.5 mb-1">
                          {!isUser && (
                            <span className={`text-xs font-medium ${isAdmin ? 'text-orange-400' : 'text-blue-400'}`}>
                              {isAdmin ? '👤 Human Agent' : '🤖 Bot'}
                            </span>
                          )}
                          {isUser && <span className="text-xs text-gray-500">User</span>}
                          <span className="text-xs text-gray-600">{new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <div className={`max-w-md px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                          isUser ? 'bg-gray-700 text-gray-100 rounded-tr-sm' :
                          isAdmin ? 'bg-orange-600/30 text-orange-100 border border-orange-500/30 rounded-tl-sm' :
                          'bg-gray-800 text-gray-100 rounded-tl-sm'
                        }`}>
                          {msg.message}
                        </div>
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Reply input */}
                <div className="p-4 border-t border-gray-800 bg-gray-900/80 flex-shrink-0">
                  {selectedSession.mode === 'bot' && (
                    <p className="text-xs text-blue-400 mb-2">Bot is active — switch to Human Agent to send manual replies</p>
                  )}
                  <div className="flex gap-2">
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } }}
                      placeholder={selectedSession.mode === 'human' ? 'Type reply as Human Agent...' : 'Switch to Human Agent to reply manually'}
                      disabled={selectedSession.mode === 'bot' || sending}
                      rows={2}
                      className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-orange-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    />
                    <button
                      onClick={sendReply}
                      disabled={!replyText.trim() || sending || selectedSession.mode === 'bot'}
                      className="px-4 py-2 bg-orange-500 text-white rounded-xl text-sm font-medium hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed self-end"
                    >
                      {sending ? '...' : 'Send'}
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
