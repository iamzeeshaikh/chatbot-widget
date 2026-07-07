'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { parseAttachment, isImageMime } from '@/lib/attachment'
import { LEAD_TRACKED_SITES, WORKSPACE_LABEL } from '@/lib/workspaces'
import { isBotOffBySchedule } from '@/lib/botschedule'
import { isBotEnabled } from '@/lib/botflag'
import { LIVE_MAX_ON_SITE_MS, asUtcIso } from '@/lib/visitor'
import { formatTime, formatDateTime, dateDividerLabel } from '@/lib/datetime'

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
interface Lead { id: string; site_id: string; name: string | null; email: string | null; phone: string | null; message: string | null; created_at: string; product?: string | null; quantity?: string | null; budget?: string | null; timeline?: string | null; qualification_score?: number | null; session_id?: string | null }
interface Session { session_id: string; site_id: string; site_name: string; preview: string; last_at: string; message_count: number; last_role?: string; mode: string; lead: { name: string | null; email: string | null } | null; tags?: string[] }
interface ChatMsg { id: string; session_id: string; site_id: string; role: string; message: string; created_at: string }
interface Visitor { session_id: string; site_id: string; site_name: string; primary_color: string; page_url: string | null; page_title: string | null; referrer: string | null; visits: number; last_seen: string; created_at: string; device_type: string | null; browser: string | null; os: string | null; country: string | null; city: string | null }
interface AnalyticsPoint { label: string; visitors: number; chats: number }
interface BillingLead { session_id: string; site_id: string; site_name: string; email: string; name: string | null; phone: string | null; captured_at: string }
interface BillingData { from: string; to: string; total: number; leads: BillingLead[]; bySite: { site_id: string; site_name: string; count: number }[] }
interface PerfAgent { id: string; email: string; builtin: boolean; former: boolean; handled: number; replies: number; avgResponseMs: number | null; slowReplies: number }
interface PerfData { from: string; to: string; summary: { totalConversations: number; totalLeads: number; totalMissed: number; totalUnanswered: number; totalReplies: number; attributedReplies: number; avgResponseMs: number | null }; agents: PerfAgent[]; unattributedReplies: number }
interface VisitorContact { name: string; email: string; phone: string; notes: string }
interface VisitorDetail {
  session_id: string
  site_id: string
  contact: VisitorContact
  tags: string[]
  stats: { visits: number; chats: number; first_seen: string | null; last_seen: string | null }
  path: { url: string | null; title: string | null; at: string | null }[]
  technical: {
    country: string | null; city: string | null; browser: string | null; os: string | null
    device_type: string | null; ip: string | null; referrer: string | null
    screen_width: number | null; user_agent: string | null
  }
}

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

// ── Month helpers ("YYYY-MM") ────────────────────────────────────────────────
// Do month math on integers (not Date→toISOString, which mixes local and UTC and
// breaks month navigation in any timezone ahead of UTC). Year rollover is handled
// by Date normalising an out-of-range month index, read back with LOCAL getters
// so construction and read stay in the same timezone.
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, (m - 1) + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
function currentMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// Human-readable duration for response times: "—" / "42s" / "3m 7s" / "1h 4m".
function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// Device type → icon.
function deviceIcon(d: string | null): string {
  return d === 'Mobile' ? '📱' : d === 'Tablet' ? '📟' : '💻'
}

// Duration between two ISO timestamps as a compact human string ("3m 12s").
function formatDuration(from: string | null, to: string | null): string {
  if (!from || !to) return '—'
  const s = Math.max(0, Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// A page entry → readable label (title if known, else a tidy path).
function pageLabel(p: { url: string | null; title: string | null }): string {
  if (p.title && p.title.trim()) return p.title.trim()
  if (!p.url) return '—'
  try {
    const u = new URL(p.url)
    return (u.pathname === '/' ? u.hostname : u.pathname) + (u.search || '')
  } catch { return p.url }
}

// Short, clean referrer source (e.g. "google.com", "chatgpt.com", "Direct").
function cleanReferrer(r: string | null): string {
  if (!r || !r.trim()) return 'Direct'
  try { return new URL(r).hostname.replace(/^www\./, '') || 'Direct' } catch { return 'Direct' }
}

// What the visitor is currently viewing: page title if known, else a tidy path.
function viewingLabel(v: { page_title: string | null; page_url: string | null }): string {
  if (v.page_title && v.page_title.trim()) return v.page_title.trim()
  if (!v.page_url) return '—'
  try {
    const u = new URL(v.page_url)
    return (u.pathname === '/' ? u.hostname : u.pathname) + (u.search || '')
  } catch { return v.page_url }
}

// Date-divider label for the message view, in Pakistan time (Asia/Karachi).
// Keeps Today/Yesterday but appends the real date; older days show the full date.
function msgDateLabel(ts: string): string {
  return dateDividerLabel(ts)
}

const RANGES: { key: 'hourly' | 'daily' | 'weekly' | 'monthly'; label: string }[] = [
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
]

// A single shimmering placeholder block — composed into loading skeletons so the
// dashboard fades in smoothly instead of flashing blank or jumping layout.
function Skel({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-gray-800/70 ${className}`} />
}

// Overview skeleton: mirrors the real layout (stat cards + chart) so nothing
// shifts when data arrives.
function OverviewSkeleton() {
  return (
    <div className="animate-in">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-2xl p-5 border border-gray-800 bg-gray-900">
            <Skel className="h-3 w-16 mb-4" />
            <Skel className="h-9 w-12" />
          </div>
        ))}
      </div>
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 mb-6">
        <Skel className="h-4 w-44 mb-4" />
        <Skel className="h-[200px] w-full" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5"><Skel className="h-4 w-32 mb-4" /><Skel className="h-24 w-full" /></div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5"><Skel className="h-4 w-28 mb-4" /><div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skel key={i} className="h-3 w-full" />)}</div></div>
      </div>
    </div>
  )
}

// Lightweight dependency-free SVG line chart: Visitors vs Chats over time.
function AnalyticsChart({ points, accent }: { points: AnalyticsPoint[]; accent: string }) {
  const W = 760, H = 220, padL = 30, padR = 14, padT = 14, padB = 26
  const n = points.length
  const maxV = Math.max(1, ...points.map((p) => Math.max(p.visitors, p.chats)))
  const x = (i: number) => padL + (n <= 1 ? 0 : (i * (W - padL - padR)) / (n - 1))
  const y = (val: number) => padT + (H - padT - padB) * (1 - val / maxV)

  // Catmull-Rom → cubic bezier for a gently smoothed line (k tunes the curve).
  const smooth = (key: 'visitors' | 'chats'): string => {
    const pts = points.map((p, i) => ({ x: x(i), y: y(p[key]) }))
    if (pts.length === 0) return ''
    if (pts.length < 3) return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
    const k = 0.8
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] || p2
      const c1x = p1.x + ((p2.x - p0.x) / 6) * k
      const c1y = p1.y + ((p2.y - p0.y) / 6) * k
      const c2x = p2.x - ((p3.x - p1.x) / 6) * k
      const c2y = p2.y - ((p3.y - p1.y) / 6) * k
      d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
    }
    return d
  }
  const areaFor = (key: 'visitors' | 'chats') => {
    const line = smooth(key)
    if (!line) return ''
    return `${line} L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`
  }

  const totalVisitors = points.reduce((s, p) => s + p.visitors, 0)
  const totalChats = points.reduce((s, p) => s + p.chats, 0)
  const labelEvery = Math.max(1, Math.ceil(n / 6))
  const gridVals = [0, 0.5, 1].map((f) => Math.round(maxV * f))
  const gid = accent.replace('#', '')

  const [hover, setHover] = useState<number | null>(null)
  const pct = (v: number, total: number) => `${(v / total) * 100}%`
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const vbX = ((e.clientX - rect.left) / rect.width) * W
    if (n <= 1) { setHover(0); return }
    const step = (W - padL - padR) / (n - 1)
    setHover(Math.max(0, Math.min(n - 1, Math.round((vbX - padL) / step))))
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-3 text-[11px]">
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: accent }} /><span className="text-gray-300">Visitors</span><span className="text-gray-400">({totalVisitors})</span></span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full bg-amber-400" /><span className="text-gray-300">Chats</span><span className="text-gray-400">({totalChats})</span></span>
      </div>
      {totalVisitors === 0 && totalChats === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-800/70 flex items-center justify-center mb-2 text-lg">📊</div>
          <p className="text-xs text-gray-400">No activity in this period yet</p>
        </div>
      ) : (
        <div className="relative" style={{ height: 220 }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 220 }} preserveAspectRatio="none">
            <defs>
              <linearGradient id={`grad-v-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.22} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="grad-c-amber" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.16} />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            {gridVals.map((gv, i) => (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={y(gv)} y2={y(gv)} stroke="#ffffff" strokeOpacity={0.05} strokeWidth={1} strokeDasharray="3 4" />
                <text x={4} y={y(gv) + 3} fill="#6b7280" fontSize={9}>{gv}</text>
              </g>
            ))}
            {points.map((p, i) => (i % labelEvery === 0 || i === n - 1) ? (
              <text key={i} x={x(i)} y={H - 8} fill="#6b7280" fontSize={9} textAnchor="middle">{p.label}</text>
            ) : null)}
            <path d={areaFor('visitors')} fill={`url(#grad-v-${gid})`} stroke="none" />
            <path d={smooth('chats')} fill="none" stroke="#f59e0b" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <path d={smooth('visitors')} fill="none" stroke={accent} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          {/* Hover overlay: guide line, point dots, and an exact-value tooltip. */}
          {hover !== null && points[hover] && (
            <>
              <div className="absolute top-0 bottom-0 w-px bg-white/10 pointer-events-none" style={{ left: pct(x(hover), W) }} />
              <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-gray-950 pointer-events-none" style={{ left: pct(x(hover), W), top: pct(y(points[hover].visitors), H), transform: 'translate(-50%,-50%)', backgroundColor: accent }} />
              <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-gray-950 bg-amber-400 pointer-events-none" style={{ left: pct(x(hover), W), top: pct(y(points[hover].chats), H), transform: 'translate(-50%,-50%)' }} />
              <div className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full mb-2"
                style={{ left: `min(max(${pct(x(hover), W)}, 56px), calc(100% - 56px))`, top: pct(Math.min(y(points[hover].visitors), y(points[hover].chats)), H) }}>
                <div className="mb-2 rounded-lg border border-gray-700 bg-gray-900/95 shadow-xl px-2.5 py-1.5 backdrop-blur">
                  <p className="text-[10px] text-gray-400 mb-0.5 whitespace-nowrap">{points[hover].label}</p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} /><span className="text-gray-300">Visitors</span><span className="font-semibold text-white ml-auto pl-2">{points[hover].visitors}</span></p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /><span className="text-gray-300">Chats</span><span className="font-semibold text-white ml-auto pl-2">{points[hover].chats}</span></p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const [tab, setTab] = useState<'overview' | 'conversations' | 'billing' | 'performance'>('overview')

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
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  // Global bot kill switch (lib/botflag.ts). Initialised from the code default;
  // every conversations poll refreshes it with the server's view (which also
  // honours a BOT_ENABLED env override the client bundle can't see).
  const [botGlobalOff, setBotGlobalOff] = useState(() => !isBotEnabled())
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [togglingMode, setTogglingMode] = useState(false)
  const replyFileRef = useRef<HTMLInputElement>(null)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [uploadError, setUploadError] = useState('')
  // Scroll handling for the message panel. We track whether the agent is parked
  // at the bottom so polling refreshes never yank them away while they read
  // history. lastSessionRef / lastMsgIdRef let us tell "conversation opened" and
  // "a new message arrived" apart from a plain re-render.
  const messagesScrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const lastSessionRef = useRef<string | null>(null)
  const lastMsgIdRef = useRef<string>('')
  const [filterSite, setFilterSite] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterTag, setFilterTag] = useState('')
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
  // Visitor detail side-panel state for the currently selected conversation.
  const [visitorDetail, setVisitorDetail] = useState<VisitorDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [contactForm, setContactForm] = useState<VisitorContact>({ name: '', email: '', phone: '', notes: '' })
  const [savingContact, setSavingContact] = useState(false)
  const [contactSaved, setContactSaved] = useState(false)
  // Tags for the open conversation (locally editable; persisted on each change).
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  // Translation (per-conversation, off by default). msgAnalysis caches each
  // visitor message's detected language + English translation, keyed by msg id.
  const [translateOn, setTranslateOn] = useState(false)
  const [translateOut, setTranslateOut] = useState(false)
  const [msgAnalysis, setMsgAnalysis] = useState<Record<string, { langName: string; isEnglish: boolean; english: string }>>({})
  const analyzingRef = useRef(false)
  const [analyticsRange, setAnalyticsRange] = useState<'hourly' | 'daily' | 'weekly' | 'monthly'>('daily')
  const [analytics, setAnalytics] = useState<AnalyticsPoint[]>([])
  // Billing report (lead-tracked sites). Month string "YYYY-MM"; default current.
  const [billingMonth, setBillingMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [billing, setBilling] = useState<BillingData | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  // Agent performance report (admin-only). Month string "YYYY-MM"; default current.
  const [perfMonth, setPerfMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [perf, setPerf] = useState<PerfData | null>(null)
  const [perfLoading, setPerfLoading] = useState(false)
  const prevVisitorIds = useRef<Set<string>>(new Set())
  // Track the latest visitor-message time per session to detect new incoming
  // messages and chime for the agent. Seeded on first load so we don't alert
  // for history.
  const lastUserMsgAt = useRef<Record<string, string>>({})
  const dashSoundReady = useRef(false)
  // One shared AudioContext, created once and resumed on the agent's first
  // interaction (browsers block audio until then). Reusing it — instead of
  // creating a fresh, suspended context per alert — is what makes the chime
  // actually fire on later polls.
  const dashCtxRef = useRef<AudioContext | null>(null)
  const getDashCtx = useCallback((): AudioContext | null => {
    if (dashCtxRef.current) return dashCtxRef.current
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) return null
      dashCtxRef.current = new AudioCtx()
    } catch { return null }
    return dashCtxRef.current
  }, [])

  // Sound on/off, persisted; default ON. Read lazily so SSR doesn't touch window.
  const [soundOn, setSoundOn] = useState(true)
  useEffect(() => {
    try { if (localStorage.getItem('zee-dash-sound') === 'off') setSoundOn(false) } catch { /* ignore */ }
  }, [])
  const toggleSound = useCallback(() => {
    setSoundOn((on) => {
      const next = !on
      try { localStorage.setItem('zee-dash-sound', next ? 'on' : 'off') } catch { /* ignore */ }
      // On enable, resume the context (this click is a user gesture) and play a
      // short confirmation chime so the agent hears it's working.
      if (next) {
        const ctx = getDashCtx()
        if (ctx) {
          if (ctx.state === 'suspended' && ctx.resume) ctx.resume()
          try {
            const t = ctx.currentTime
            const osc = ctx.createOscillator(); const gain = ctx.createGain()
            osc.connect(gain); gain.connect(ctx.destination)
            osc.type = 'sine'; osc.frequency.value = 988
            gain.gain.setValueAtTime(0, t)
            gain.gain.linearRampToValueAtTime(0.5, t + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
            osc.start(t); osc.stop(t + 0.32)
          } catch { /* ignore */ }
        }
      }
      return next
    })
  }, [getDashCtx])

  // Resume the shared context on the agent's first interaction anywhere in the
  // dashboard, so chimes work for the rest of the session.
  useEffect(() => {
    const unlock = () => {
      const ctx = getDashCtx()
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume()
      ;['pointerdown', 'keydown', 'click'].forEach((ev) => window.removeEventListener(ev, unlock, true))
    }
    ;['pointerdown', 'keydown', 'click'].forEach((ev) => window.addEventListener(ev, unlock, true))
    return () => { ['pointerdown', 'keydown', 'click'].forEach((ev) => window.removeEventListener(ev, unlock, true)) }
  }, [getDashCtx])

  // LOUD, piercing alert for the agent on a new visitor message. Three layered
  // oscillators per note (sine + bright triangle + sharp sawtooth) at max gain,
  // driven through a soft limiter so it cuts through a noisy room without harsh
  // digital clipping. Reuses the shared, already-unlocked context.
  const playDashSound = useCallback(() => {
    if (!soundOn) return
    const ctx = getDashCtx()
    if (!ctx) return
    try {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume()

      const master = ctx.createGain()
      master.gain.value = 1.0
      const shaper = ctx.createWaveShaper()
      const curve = new Float32Array(1024)
      for (let c = 0; c < 1024; c++) {
        const x = (c / 1023) * 2 - 1
        curve[c] = Math.tanh(x * 1.8)
      }
      shaper.curve = curve
      master.connect(shaper); shaper.connect(ctx.destination)

      ;[[784, 0], [1047, 0.13], [1319, 0.26]].forEach(([freq, delay]) => {
        const t = ctx.currentTime + delay
        ;([['sine', freq, 1.0], ['triangle', freq * 2, 0.6], ['sawtooth', freq, 0.35]] as [OscillatorType, number, number][]).forEach(([type, f, peak]) => {
          const osc = ctx.createOscillator(); const gain = ctx.createGain()
          osc.connect(gain); gain.connect(master)
          osc.type = type; osc.frequency.value = f
          gain.gain.setValueAtTime(0, t)
          gain.gain.linearRampToValueAtTime(peak, t + 0.012)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
          osc.start(t); osc.stop(t + 0.55)
        })
      })
    } catch { /* ignore */ }
  }, [soundOn, getDashCtx])

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/sites').then((r) => r.json()).catch(() => ({ sites: [] })),
      fetch('/api/admin/leads-list').then((r) => r.json()).catch(() => ({ leads: [] })),
    ]).then(([s, l]) => { setSites(s.sites ?? []); setLeads(l.leads ?? []); setOverviewLoading(false) })
  }, [])

  // Analytics (visitors + chats over time), scoped server-side to the workspace.
  useEffect(() => {
    if (tab !== 'overview' || !authReady) return
    fetch(`/api/admin/analytics?range=${analyticsRange}`)
      .then((r) => r.json()).catch(() => ({ points: [] }))
      .then((d) => setAnalytics(d.points ?? []))
  }, [tab, authReady, analyticsRange])

  // Billing leads for the selected month, scoped server-side to the member.
  useEffect(() => {
    if (tab !== 'billing' || !authReady) return
    const [y, m] = billingMonth.split('-').map(Number)
    if (!y || !m) return
    const from = new Date(y, m - 1, 1).toISOString()
    const to = new Date(y, m, 1).toISOString()
    setBillingLoading(true)
    fetch(`/api/admin/leads-billing?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => { setBilling(d); setBillingLoading(false) })
  }, [tab, authReady, billingMonth])

  // Agent performance for the selected month, scoped server-side to the admin's
  // workspace (the endpoint also enforces admin-only access).
  useEffect(() => {
    if (tab !== 'performance' || !authReady) return
    const [y, m] = perfMonth.split('-').map(Number)
    if (!y || !m) return
    const from = new Date(y, m - 1, 1).toISOString()
    const to = new Date(y, m, 1).toISOString()
    setPerfLoading(true)
    fetch(`/api/admin/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => { setPerf(d); setPerfLoading(false) })
  }, [tab, authReady, perfMonth])

  const fetchSessions = useCallback(async () => {
    const data = await fetch('/api/admin/conversations').then((r) => r.json()).catch(() => ({ sessions: [] }))
    const incoming: Session[] = data.sessions ?? []

    // Detect new incoming visitor messages (a session whose latest message is
    // from the visitor, with a newer timestamp than we last saw) and chime.
    let hasNew = false
    const nextMap: Record<string, string> = {}
    for (const s of incoming) {
      if (s.last_role === 'user') {
        nextMap[s.session_id] = s.last_at
        const prev = lastUserMsgAt.current[s.session_id]
        if (dashSoundReady.current && prev !== s.last_at) hasNew = true
      }
    }
    lastUserMsgAt.current = nextMap
    if (hasNew) playDashSound()
    dashSoundReady.current = true

    setSessions(incoming)
    setSessionsLoaded(true)
    if (typeof data.bot_enabled === 'boolean') setBotGlobalOff(!data.bot_enabled)
  }, [playDashSound])

  // Poll sessions whenever signed in (not only on the Conversations tab) so the
  // new-visitor-message alert fires even while the agent is on Overview.
  useEffect(() => {
    if (!authReady) return
    fetchSessions()
    const iv = setInterval(fetchSessions, 6000)
    return () => clearInterval(iv)
  }, [authReady, fetchSessions])

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

  // Record whether the agent is at (or near) the bottom of the message panel,
  // so we know whether it's safe to auto-scroll on the next update.
  const handleMessagesScroll = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Auto-scroll the message panel ONLY when (a) the conversation was just opened
  // or (b) a new message arrived while the agent was already at the bottom. If
  // they've scrolled up to read history, their position is preserved across the
  // 3s polling refreshes. We set the panel's own scrollTop (never scrollIntoView)
  // so the page itself never jumps.
  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el || !selectedSession) return
    const lastId = messages.length ? messages[messages.length - 1].id : ''
    const sessionChanged = lastSessionRef.current !== selectedSession.session_id
    const newMessage = lastId !== lastMsgIdRef.current

    if (sessionChanged) {
      // Conversation opened: jump to the latest message and reset bottom state.
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    } else if (newMessage && atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
    // Otherwise (plain refresh, or new message while scrolled up): leave as-is.

    lastSessionRef.current = selectedSession.session_id
    lastMsgIdRef.current = lastId
  }, [messages, selectedSession])

  // Load the rich visitor detail whenever a conversation is opened. Refreshed on
  // a slow interval so stats/path stay current without competing with messages.
  const fetchVisitorDetail = useCallback(async (sessionId: string, withSpinner: boolean) => {
    if (withSpinner) setDetailLoading(true)
    const data = await fetch(`/api/admin/visitor?sessionId=${encodeURIComponent(sessionId)}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (data?.detail) {
      setVisitorDetail(data.detail)
      // Only (re)seed the editable fields on the initial load so we never clobber
      // what the agent is typing/editing during a background refresh.
      if (withSpinner) { setContactForm(data.detail.contact); setTags(data.detail.tags ?? []) }
    }
    if (withSpinner) setDetailLoading(false)
  }, [])

  useEffect(() => {
    if (!selectedSession) { setVisitorDetail(null); return }
    setContactSaved(false)
    setTags(selectedSession.tags ?? []); setTagInput('')
    // Translation is per-conversation and off by default.
    setTranslateOn(false); setTranslateOut(false); setMsgAnalysis({})
    fetchVisitorDetail(selectedSession.session_id, true)
    const iv = setInterval(() => fetchVisitorDetail(selectedSession.session_id, false), 15000)
    return () => clearInterval(iv)
  }, [selectedSession, fetchVisitorDetail])

  // Detect language + fetch English translation for any visitor text messages we
  // haven't analysed yet (batched, cached by id). Runs on message updates so new
  // incoming messages get a "Detected" indicator and an on-demand translation.
  useEffect(() => {
    if (!selectedSession) return
    const pending = messages.filter((m) =>
      m.role === 'user' &&
      m.message !== '(session started)' &&
      !parseAttachment(m.message) &&
      !(m.id in msgAnalysis),
    )
    if (pending.length === 0 || analyzingRef.current) return
    analyzingRef.current = true
    const items = pending.slice(0, 25).map((m) => ({ id: m.id, text: m.message }))
    fetch('/api/admin/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'incoming', sessionId: selectedSession.session_id, items }),
    })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((data) => {
        if (data?.results) {
          setMsgAnalysis((prev) => {
            const next = { ...prev }
            for (const r of data.results) next[r.id] = { langName: r.langName, isEnglish: r.isEnglish, english: r.english }
            return next
          })
        }
      })
      .finally(() => { analyzingRef.current = false })
  }, [messages, selectedSession, msgAnalysis])

  // The visitor's current language for outgoing replies: the most recent
  // non-English visitor message's detected language, if any.
  const visitorLang = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const a = msgAnalysis[messages[i].id]
      if (messages[i].role === 'user' && a && !a.isEnglish && a.langName) return a.langName
    }
    return ''
  }, [messages, msgAnalysis])

  async function saveContact() {
    if (!selectedSession || savingContact) return
    setSavingContact(true); setContactSaved(false)
    const res = await fetch('/api/admin/visitor', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, ...contactForm }),
    })
    setSavingContact(false)
    if (res.ok) {
      setContactSaved(true)
      setVisitorDetail((d) => (d ? { ...d, contact: { ...contactForm } } : d))
      setTimeout(() => setContactSaved(false), 2500)
    }
  }

  // Persist the full tag set for the open conversation, and reflect it on the
  // session in the list so the tag filter/chips stay in sync without a refetch.
  async function persistTags(next: string[]) {
    if (!selectedSession) return
    setTags(next)
    setVisitorDetail((d) => (d ? { ...d, tags: next } : d))
    setSessions((prev) => prev.map((s) => s.session_id === selectedSession.session_id ? { ...s, tags: next } : s))
    await fetch('/api/admin/visitor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, tags: next }),
    }).catch(() => {})
  }

  function addTag(raw: string) {
    const tag = raw.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!tag) return
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) { setTagInput(''); return }
    persistTags([...tags, tag])
    setTagInput('')
  }

  function removeTag(tag: string) {
    persistTags(tags.filter((t) => t !== tag))
  }

  async function sendReply() {
    if (!selectedSession || !replyText.trim() || sending) return
    setSending(true)
    let outgoing = replyText.trim()
    // Optionally translate the agent's English reply into the visitor's language
    // so they read it natively. Falls back to the original on any failure.
    if (translateOut && visitorLang) {
      const t = await fetch('/api/admin/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'outgoing', sessionId: selectedSession.session_id, text: outgoing, targetLang: visitorLang }),
      }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      if (t?.translation) outgoing = t.translation
    }
    await fetch('/api/admin/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, siteId: selectedSession.site_id, message: outgoing }),
    })
    setReplyText('')
    await fetchMessages(selectedSession.session_id)
    setSending(false)
  }

  // Agent sends a file to the visitor. Uploads via the same endpoint as the
  // widget (authenticated here), which saves it as an 'admin' message and flips
  // the conversation to human mode — so we mirror that locally too.
  async function uploadReplyFile(file: File) {
    if (!selectedSession || uploadingFile) return
    setUploadError('')
    if (file.size > 10 * 1024 * 1024) { setUploadError('File too large (max 10MB)'); return }
    setUploadingFile(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('siteId', selectedSession.site_id)
    fd.append('sessionId', selectedSession.session_id)
    const res = await fetch('/api/upload', { method: 'POST', body: fd })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d }))).catch(() => ({ ok: false, d: null }))
    setUploadingFile(false)
    if (!res.ok) { setUploadError(res.d?.error || 'Upload failed'); return }
    setSelectedSession((s) => s ? { ...s, mode: 'human' } : s)
    setSessions((prev) => prev.map((s) => s.session_id === selectedSession.session_id ? { ...s, mode: 'human' } : s))
    await fetchMessages(selectedSession.session_id)
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

  // Open a specific conversation by sessionId: prefer the already-loaded session
  // (full data), otherwise synthesise a minimal one so the chat + visitor-detail
  // panel can load, then switch to the Conversations tab.
  function openConversationBySession(opts: { sessionId: string; siteId: string; siteName?: string; preview?: string; lastAt?: string }) {
    const existing = sessions.find((s) => s.session_id === opts.sessionId)
    const session: Session = existing ?? {
      session_id: opts.sessionId, site_id: opts.siteId,
      site_name: opts.siteName ?? sites.find((s) => s.site_id === opts.siteId)?.name ?? opts.siteId,
      preview: opts.preview ?? '', last_at: opts.lastAt ?? new Date().toISOString(),
      message_count: 0, mode: 'bot', lead: null,
    }
    if (!existing) setSessions((prev) => [session, ...prev])
    setSelectedSession(session)
    setTab('conversations')
  }

  function openConversation(lead: BillingLead) {
    openConversationBySession({ sessionId: lead.session_id, siteId: lead.site_id, siteName: lead.site_name, preview: lead.email, lastAt: lead.captured_at })
  }

  // Recent-Leads row → open the matched conversation (server resolves session_id
  // by email). If no conversation could be matched, just go to the Conversations
  // tab so the agent can find it manually.
  function openLeadConversation(lead: Lead) {
    if (lead.session_id) {
      openConversationBySession({ sessionId: lead.session_id, siteId: lead.site_id, preview: lead.email ?? '', lastAt: lead.created_at })
    } else {
      setTab('conversations')
    }
  }

  // Export the current billing list as CSV for the client invoice.
  function downloadBillingCsv() {
    if (!billing) return
    const esc = (v: string | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['Email', 'Name', 'Phone', 'Site', 'Date Captured']
    const rows = billing.leads.map((l) => [
      esc(l.email), esc(l.name), esc(l.phone), esc(l.site_name),
      esc(new Date(l.captured_at).toISOString()),
    ].join(','))
    const csv = [header.join(','), ...rows].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `leads-${billingMonth}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
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
  // Only count a visitor as "live" if their session is recent. A multi-hour
  // on-site time means a stale/carried-over session (e.g. an old open tab still
  // pinging) — never show those as live, mirroring the server cap.
  const roleVisitors = visitors.filter((v) => {
    if (!inScope(v.site_id)) return false
    const created = asUtcIso(v.created_at)
    if (created && Date.now() - new Date(created).getTime() > LIVE_MAX_ON_SITE_MS) return false
    return true
  })
  // Show the Billing tab only when the member can access a lead-tracked site.
  const hasTrackedSite = userSites.some((id) => LEAD_TRACKED_SITES.includes(id))
  const dashTitle = brand === 'sports' ? '🏆 Sports Dashboard' : '📦 Packaging Dashboard'
  const accentColor = brand === 'sports' ? '#16a34a' : '#2563eb'

  // Effective bot state for the open conversation. The packaging schedule can put
  // the bot OFF even when the conversation's stored mode is still 'bot', so the
  // header/reply UI must reflect that the bot won't actually reply right now —
  // matching /api/chat. Sports is never schedule-gated. (Recomputed each render,
  // which happens on every poll, so it flips within seconds of a window boundary.)
  const scheduledBotOff = !!selectedSession && isBotOffBySchedule(selectedSession.site_id)
  const botEffectivelyActive = !botGlobalOff && !!selectedSession && selectedSession.mode === 'bot' && !scheduledBotOff

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

  // All distinct tags in scope (workspace-isolated — roleSessions is already
  // filtered to the member's sites), case-insensitively de-duped, for the filter.
  const sessionTags = useMemo(() => {
    const seen = new Map<string, string>()
    for (const s of roleSessions) for (const t of s.tags ?? []) {
      const key = t.toLowerCase()
      if (!seen.has(key)) seen.set(key, t)
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b))
  }, [roleSessions])

  const filteredSessions = roleSessions.filter(s => {
    if (filterSite && s.site_id !== filterSite) return false
    if (filterStatus === 'bot' && s.mode !== 'bot') return false
    if (filterStatus === 'human' && s.mode !== 'human') return false
    if (filterStatus === 'lead' && !s.lead) return false
    if (filterStatus === 'no-response' && s.last_role !== 'user') return false
    if (filterTag && !(s.tags ?? []).some((t) => t.toLowerCase() === filterTag.toLowerCase())) return false
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
      <div className="min-h-screen bg-gray-950 flex items-center justify-center gap-3 text-gray-400 text-sm">
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
            <p className="text-gray-400 text-[11px] flex items-center gap-1.5">
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
            {hasTrackedSite && (
              <button onClick={() => setTab('billing')} className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all ${tab === 'billing' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}>
                Billing
              </button>
            )}
            {userRole === 'admin' && (
              <button onClick={() => setTab('performance')} className={`px-3.5 py-1.5 rounded-md text-xs font-medium transition-all ${tab === 'performance' ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}>
                Performance
              </button>
            )}
          </div>
          <button onClick={toggleSound} title={soundOn ? 'Sound on — click to mute new-message alerts' : 'Sound off — click to unmute'}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${soundOn ? 'bg-gray-900 text-gray-200 border-gray-800 hover:bg-gray-800' : 'bg-gray-900 text-gray-400 border-gray-800 hover:text-gray-300'}`}>
            {soundOn ? '🔔' : '🔕'}
          </button>
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
        <div className="p-6 max-w-6xl mx-auto animate-in">
          {overviewLoading ? (
            <OverviewSkeleton />
          ) : (
            <>
              {/* Stats row */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                {[
                  { label: 'Total Sites', value: roleSites.length, icon: '🏆', color: 'from-blue-500/10 to-blue-600/5', border: 'border-blue-500/20' },
                  { label: 'Total Leads', value: roleLeads.length, icon: '👥', color: 'from-green-500/10 to-green-600/5', border: 'border-green-500/20' },
                  { label: botGlobalOff ? 'Active Sites' : 'Active Bots', value: roleSites.length, icon: botGlobalOff ? '🌐' : '🤖', color: 'from-purple-500/10 to-purple-600/5', border: 'border-purple-500/20' },
                  { label: "Today's Leads", value: todayLeads, icon: '📅', color: 'from-orange-500/10 to-orange-600/5', border: 'border-orange-500/20' },
                  { label: "This Week", value: thisWeekLeads, icon: '📈', color: 'from-cyan-500/10 to-cyan-600/5', border: 'border-cyan-500/20' },
                ].map((s) => (
                  <div key={s.label} className={`group bg-gradient-to-br ${s.color} rounded-2xl p-5 border ${s.border} bg-gray-900 transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-600/60 hover:shadow-lg hover:shadow-black/20`}>
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide">{s.label}</p>
                      <span className="text-lg opacity-80 group-hover:opacity-100 transition-opacity">{s.icon}</span>
                    </div>
                    <p className="text-[2.5rem] leading-none font-extrabold text-white tracking-tight tabular-nums">{s.value}</p>
                  </div>
                ))}
              </div>

              {/* Analytics over time */}
              <div className="bg-gray-900 rounded-xl border border-gray-800 p-5 mb-6">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <h2 className="text-sm font-semibold text-white">Visitors &amp; Chats Over Time</h2>
                  <div className="flex gap-0.5 bg-gray-800/60 p-1 rounded-lg border border-gray-700/60">
                    {RANGES.map((r) => (
                      <button key={r.key} onClick={() => setAnalyticsRange(r.key)}
                        className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all ${analyticsRange === r.key ? 'bg-gray-700 text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'}`}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <AnalyticsChart points={analytics} accent={accentColor} />
              </div>

              {/* Chart + Sites row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                {/* Bar chart */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-white">Leads — Last 7 Days</h2>
                    <span className="text-xs text-gray-400">{roleLeads.length} total</span>
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
                          <span className={`text-[10px] ${isToday ? 'text-white font-semibold' : 'text-gray-400'}`}>{day.label}</span>
                        </div>
                      )
                    })}
                  </div>
                  {roleLeads.length === 0 && (
                    <p className="text-xs text-gray-400 text-center mt-2">No leads captured yet</p>
                  )}
                </div>

                {/* Quick stats per site */}
                <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
                  <h2 className="text-sm font-semibold text-white mb-4">Leads by Site</h2>
                  <div className="space-y-2.5">
                    {roleSites.length === 0 ? (
                      <p className="text-xs text-gray-400">No sites configured</p>
                    ) : roleSites.map((site) => {
                      const count = roleLeads.filter(l => l.site_id === site.site_id).length
                      const pct = roleLeads.length > 0 ? Math.round((count / roleLeads.length) * 100) : 0
                      const accent = SITE_ACCENT[site.site_id] ?? accentColor
                      return (
                        <div key={site.site_id}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-gray-300 truncate">{site.name}</span>
                            <span className="text-xs text-gray-400 shrink-0 ml-2">{count} leads</span>
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
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {roleSites.map((site) => {
                    const accent = SITE_ACCENT[site.site_id] ?? site.primary_color
                    const url = SITE_URLS[site.site_id]
                    const count = roleLeads.filter((l) => l.site_id === site.site_id).length
                    return (
                      <div key={site.site_id} className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-700 hover:shadow-lg hover:shadow-black/20 group">
                        <div className="h-1" style={{ backgroundColor: accent }} />
                        <div className="p-4">
                          <div className="flex items-center gap-2.5 mb-3">
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0 shadow-sm" style={{ backgroundColor: accent }}>
                              {site.bot_name?.[0]?.toUpperCase() ?? 'B'}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-white text-sm truncate">{site.name}</p>
                              <p className="text-gray-400 text-[11px] truncate">{site.bot_name}</p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t border-gray-800/60">
                            <span className="text-xs font-medium" style={{ color: accent }}>{count} lead{count !== 1 ? 's' : ''}</span>
                            {url ? (
                              <a href={`https://${url}`} target="_blank" rel="noopener noreferrer"
                                className="text-[11px] text-gray-400 hover:text-blue-400 transition-colors truncate max-w-[120px]" title={url}>
                                {url}
                              </a>
                            ) : (
                              <span className="text-[11px] text-gray-400 font-mono">{site.site_id}</span>
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
                            <th key={h} className="text-left px-3 py-2.5 text-[11px] text-gray-400 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {roleLeads.length === 0 ? (
                          <tr>
                            <td colSpan={12} className="text-center py-8">
                              <div className="flex flex-col items-center">
                                <div className="w-10 h-10 rounded-full bg-gray-800/70 flex items-center justify-center text-lg mb-2">📭</div>
                                <p className="text-gray-300 text-sm font-medium">No leads captured yet</p>
                                <p className="text-gray-400 text-xs mt-0.5">Leads appear here when the bot qualifies a visitor</p>
                              </div>
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
                              <td className="px-3 py-2">{score !== null ? <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${score >= 7 ? 'bg-green-500/20 text-green-400 border border-green-500/30' : score >= 4 ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-gray-700 text-gray-400'}`}>{score}/7</span> : <span className="text-gray-400 text-xs">-</span>}</td>
                              <td className="px-3 py-2"><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-white w-full min-w-[80px] focus:outline-none focus:border-blue-500" placeholder="Name" /></td>
                              <td className="px-3 py-2"><input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-blue-300 w-full min-w-[140px] focus:outline-none focus:border-blue-500" placeholder="Email" /></td>
                              <td className="px-3 py-2"><input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 w-full min-w-[100px] focus:outline-none focus:border-blue-500" placeholder="Phone" /></td>
                              <td className="px-3 py-2" colSpan={5}><input value={editForm.message} onChange={(e) => setEditForm({ ...editForm, message: e.target.value })} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 w-full focus:outline-none focus:border-blue-500" placeholder="Message" /></td>
                              <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{siteName}</td>
                              <td className="px-3 py-2 text-gray-400 text-xs whitespace-nowrap">{lead.created_at ? formatDateTime(lead.created_at) : '-'}</td>
                              <td className="px-3 py-2"><div className="flex gap-1"><button onClick={() => saveEditLead(lead.id)} disabled={savingEdit} className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded transition-colors disabled:opacity-50">{savingEdit ? '…' : 'Save'}</button><button onClick={() => setEditingLeadId(null)} className="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-2 py-1 rounded transition-colors">Cancel</button></div></td>
                            </tr>
                          )

                          return (
                            <tr key={lead.id} onClick={() => openLeadConversation(lead)} title="Open this lead's conversation"
                              className="group border-b border-gray-800/40 hover:bg-gray-800/40 transition-colors cursor-pointer">
                              <td className="px-3 py-3">{score !== null ? <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${score >= 7 ? 'bg-green-500/20 text-green-400 border border-green-500/30' : score >= 4 ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-gray-700 text-gray-400'}`}>{score}/7</span> : <span className="text-gray-400 text-xs">-</span>}</td>
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
                              <td className="px-3 py-3 text-gray-400 text-xs whitespace-nowrap">{lead.created_at ? formatDateTime(lead.created_at) : '-'}</td>
                              <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                {isConfirmingDelete ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-300">Delete?</span>
                                    <button onClick={() => deleteLead(lead.id)} disabled={deletingLead} className="text-xs text-red-400 hover:text-red-300 font-semibold">Yes</button>
                                    <span className="text-xs text-gray-400 mx-0.5">·</span>
                                    <button onClick={() => setConfirmLeadDeleteId(null)} className="text-xs text-gray-400 hover:text-gray-300">No</button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onClick={() => startEditLead(lead)} className="p-1.5 text-gray-400 hover:text-blue-400 hover:bg-gray-700/60 rounded-lg transition-colors" title="Edit">✏️</button>
                                    <button onClick={() => setConfirmLeadDeleteId(lead.id)} className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700/60 rounded-lg transition-colors" title="Delete">🗑</button>
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
        <div className="flex animate-in" style={{ height: 'calc(100vh - 57px)' }}>

          {/* ── Left sidebar ── */}
          <div className="w-[300px] flex-shrink-0 border-r border-gray-800/80 flex flex-col bg-gray-900/30">

            {/* Live visitors */}
            {roleVisitors.length > 0 && (
              <div className="border-b border-gray-800 flex flex-col min-h-0 max-h-[38vh]">
                <div className="px-3 py-2 flex items-center gap-2 bg-green-950/30 flex-shrink-0">
                  <span className="w-2 h-2 rounded-full bg-green-400 shrink-0 ring-2 ring-green-400/30 animate-pulse" />
                  <p className="text-[11px] text-green-400 font-semibold uppercase tracking-wider">{roleVisitors.length} Live {roleVisitors.length === 1 ? 'Visitor' : 'Visitors'}</p>
                </div>
                <div className="overflow-y-auto min-h-0">
                {roleVisitors.map((v) => {
                  const accent = SITE_ACCENT[v.site_id] ?? '#16a34a'
                  return (
                    <button key={v.session_id} onClick={() => openVisitorSession(v)}
                      className="w-full text-left px-3 py-1.5 border-t border-gray-800/40 hover:bg-green-900/15 transition-colors flex items-start gap-2.5"
                      style={{ borderLeft: `3px solid ${accent}` }}>
                      <span className="text-base shrink-0 mt-0.5" title={[v.device_type, v.browser, v.os].filter(Boolean).join(' · ')}>{deviceIcon(v.device_type)}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-semibold text-gray-100 truncate">{v.site_name}</span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {v.visits > 1 && (
                              <span className="text-[9px] font-semibold text-amber-300 bg-amber-500/15 border border-amber-500/25 rounded-full px-1.5 py-px" title={`${v.visits} visits — returning visitor`}>🔁 {v.visits}</span>
                            )}
                            {/* The live list only ever contains visitors active within the
                                last 60s (server-filtered), so these are genuinely live. */}
                            <span className="text-[10px] text-green-400 font-medium flex items-center gap-1 shrink-0" title={`Last activity ${timeAgo(v.last_seen)}`}>
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />active now
                            </span>
                          </div>
                        </div>
                        {/* Currently viewing */}
                        <div className="text-[11px] text-gray-300 truncate mt-0.5" title={v.page_url ?? undefined}>
                          <span className="text-gray-400">Viewing:</span> {viewingLabel(v)}
                        </div>
                        {/* Location · referrer */}
                        <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                          {v.country && <span className="text-[11px] text-gray-400 truncate">{v.country}</span>}
                          {v.country && <span className="text-[10px] text-gray-400 shrink-0">·</span>}
                          <span className="text-[10px] text-gray-400 truncate" title={v.referrer ?? 'Direct'}>via {cleanReferrer(v.referrer)}</span>
                        </div>
                        <div className="text-[10px] text-green-600 mt-0.5">on site {timeOnSite(v.created_at)}</div>
                      </div>
                    </button>
                  )
                })}
                </div>
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
                  {/* With the bot globally off, mode 'bot' just means "no agent
                      has replied yet", so label the filter accordingly. */}
                  <option value="bot">{botGlobalOff ? 'Waiting' : 'Bot'}</option>
                  <option value="human">Human</option>
                  <option value="lead">Lead</option>
                  <option value="no-response">No reply</option>
                </select>
              </div>
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search…"
                className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-400 focus:outline-none focus:border-gray-500" />
              {sessionTags.length > 0 && (
                <select value={filterTag} onChange={e => setFilterTag(e.target.value)} className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-500">
                  <option value="">🏷 All Tags</option>
                  {sessionTags.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              {(filterSite || filterStatus !== 'all' || filterTag || searchQuery) && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-gray-400">{filteredSessions.length} result{filteredSessions.length !== 1 ? 's' : ''}</span>
                  <button onClick={() => { setFilterSite(''); setFilterStatus('all'); setFilterTag(''); setSearchQuery('') }} className="text-[11px] text-blue-400 hover:text-blue-300">Clear</button>
                </div>
              )}
            </div>

            {/* Bulk select bar */}
            <div className="px-3 py-1.5 border-b border-gray-800/60 flex items-center gap-2 flex-shrink-0">
              <input type="checkbox"
                checked={filteredSessions.length > 0 && filteredSessions.every(s => selectedSessions.has(s.session_id))}
                onChange={e => { if (e.target.checked) setSelectedSessions(new Set(filteredSessions.map(s => s.session_id))); else setSelectedSessions(new Set()) }}
                className="rounded accent-blue-500 cursor-pointer" />
              <span className="text-[11px] text-gray-400 flex-1">{selectedSessions.size > 0 ? `${selectedSessions.size} selected` : `${filteredSessions.length} sessions`}</span>
              {selectedSessions.size > 0 && (
                confirmBulkDelete ? (
                  <div className="flex items-center gap-1">
                    <span className="text-[11px] text-red-400">Delete {selectedSessions.size}?</span>
                    <button onClick={deleteBulk} disabled={deleting} className="text-[11px] text-red-400 font-semibold ml-1">Yes</button>
                    <span className="text-[11px] text-gray-400 mx-0.5">·</span>
                    <button onClick={() => setConfirmBulkDelete(false)} className="text-[11px] text-gray-400">No</button>
                  </div>
                ) : (
                  <button onClick={() => setConfirmBulkDelete(true)} className="text-[11px] text-red-400 hover:text-red-300">Delete</button>
                )
              )}
            </div>

            {/* Session list */}
            <div className="flex-1 overflow-y-auto">
              {!sessionsLoaded ? (
                <div className="p-1">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <div key={i} className="flex gap-2 px-3 py-3 border-b border-gray-800/40">
                      <Skel className="w-2 h-2 rounded-full mt-1" />
                      <div className="flex-1 space-y-1.5">
                        <Skel className="h-3 w-24" />
                        <Skel className="h-3 w-40" />
                        <Skel className="h-2.5 w-16" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredSessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4 py-12 animate-in">
                  <div className="w-10 h-10 rounded-full bg-gray-800/70 flex items-center justify-center text-lg mb-2">🗂️</div>
                  <p className="text-sm text-gray-300 font-medium">{roleSessions.length === 0 ? 'No conversations yet' : 'No results match'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{roleSessions.length === 0 ? 'Conversations appear here in real time' : 'Try adjusting your filters'}</p>
                </div>
              ) : filteredSessions.map((s) => {
                const isSelected = selectedSessions.has(s.session_id)
                const isActive = selectedSession?.session_id === s.session_id
                const isConfirming = confirmDeleteId === s.session_id
                const accent = SITE_ACCENT[s.site_id] ?? '#6b7280'
                const hasUnread = s.last_role === 'user'
                return (
                  <div key={s.session_id}
                    className={`group relative flex border-b border-gray-800/40 transition-colors duration-150 ${isActive ? 'bg-gray-800/70' : 'hover:bg-gray-800/40'} ${isSelected ? 'ring-1 ring-inset ring-blue-500/20 bg-blue-950/20' : ''}`}
                    style={{ borderLeft: `3px solid ${isActive ? accent : 'transparent'}` }}>
                    <div className="flex items-center px-2 py-2.5 shrink-0" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={isSelected}
                        onChange={e => { const n = new Set(selectedSessions); if (e.target.checked) n.add(s.session_id); else n.delete(s.session_id); setSelectedSessions(n) }}
                        className="rounded accent-blue-500 cursor-pointer" />
                    </div>
                    <div className="flex-1 min-w-0 py-2 pr-7 cursor-pointer" onClick={() => setSelectedSession(s)}>
                      <div className="flex items-center justify-between mb-0.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {hasUnread && <span className="w-2 h-2 rounded-full bg-green-400 shrink-0 ring-2 ring-green-400/25" title="New visitor message" />}
                          <span className={`text-xs truncate ${hasUnread ? 'font-semibold text-white' : 'font-medium text-gray-300'}`}>{s.site_name}</span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-1">
                          {s.mode === 'human' && <span className="text-[9px] font-semibold text-orange-300 bg-orange-500/15 border border-orange-500/30 rounded-full px-1.5 py-px leading-none" title="Human takeover active">LIVE</span>}
                          <span className="text-[10px] text-gray-400">{timeAgo(s.last_at)}</span>
                        </div>
                      </div>
                      <p className={`text-xs truncate mb-1 ${hasUnread ? 'text-gray-200' : 'text-gray-400'}`}>{s.preview || '(no messages)'}</p>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-gray-400">{s.message_count} msgs</span>
                        {s.lead && <span className="text-[10px] text-green-400 font-medium">● Lead</span>}
                      </div>
                      {(s.tags ?? []).length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(s.tags ?? []).map((t) => (
                            <span key={t} className="text-[9px] px-1.5 py-px rounded-full bg-gray-700/70 border border-gray-600/50 text-gray-300 truncate max-w-[110px]">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2" onClick={e => e.stopPropagation()}>
                      {isConfirming ? (
                        <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-1.5 py-1 shadow-lg">
                          <button onClick={() => deleteSession(s.session_id)} disabled={deleting} className="text-[11px] text-red-400 font-semibold">Yes</button>
                          <span className="text-[11px] text-gray-400">·</span>
                          <button onClick={() => setConfirmDeleteId(null)} className="text-[11px] text-gray-400">No</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(s.session_id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700/60 rounded-lg transition-all text-xs">
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
                <div className="text-center px-8 max-w-xs animate-in">
                  <div className="w-12 h-12 rounded-xl bg-gray-800/80 flex items-center justify-center mx-auto mb-3 border border-gray-700/80">
                    <svg viewBox="0 0 24 24" className="w-6 h-6 fill-gray-600"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                  </div>
                  <p className="text-gray-300 font-medium text-sm mb-1">Select a conversation</p>
                  <p className="text-gray-400 text-xs leading-relaxed">Pick a session on the left to view messages and manage the chat.</p>
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
                      <p className="text-[10px] text-gray-400 font-mono truncate">{selectedSession.session_id}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button onClick={() => setTranslateOn((v) => !v)}
                      title="Show English translations of non-English visitor messages"
                      className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors flex items-center gap-1.5 ${
                        translateOn ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40' : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-gray-200'
                      }`}>
                      🌐 Translate{translateOn ? ' on' : ''}
                    </button>
                    <span className="w-px h-5 bg-gray-800" />
                    {botGlobalOff ? (
                      // Global kill switch on: there is no bot to toggle — every
                      // conversation is human-handled, so show one static badge.
                      <span className="text-[10px] bg-orange-500/15 text-orange-300 px-2 py-0.5 rounded-full border border-orange-500/25" title="The AI bot is disabled globally (lib/botflag.ts) — human agents are the only reply path">👤 Human only — AI disabled</span>
                    ) : (
                      <>
                        <span className={`text-xs font-medium ${botEffectivelyActive ? 'text-blue-400' : 'text-gray-400'}`}>Bot</span>
                        <button onClick={toggleMode} disabled={togglingMode}
                          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${botEffectivelyActive ? 'bg-blue-600' : 'bg-orange-500'}`}>
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${botEffectivelyActive ? 'translate-x-0' : 'translate-x-5'}`} />
                        </button>
                        <span className={`text-xs font-medium ${!botEffectivelyActive ? 'text-orange-400' : 'text-gray-400'}`}>Human</span>
                        {scheduledBotOff && selectedSession.mode === 'bot' ? (
                          <span className="text-[10px] bg-indigo-500/15 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-500/25" title="The packaging bot is off on this schedule — replies are human-only right now">🌙 Bot off (scheduled)</span>
                        ) : selectedSession.mode === 'human' ? (
                          <span className="text-[10px] bg-orange-500/15 text-orange-300 px-2 py-0.5 rounded-full border border-orange-500/25">AI off</span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>

                {/* Messages area */}
                <div ref={messagesScrollRef} onScroll={handleMessagesScroll}
                  className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 bg-gray-950/50 space-y-1">
                  {messageDates.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      <p className="text-gray-400 text-sm">No messages yet</p>
                    </div>
                  ) : messageDates.map((msg) => {
                    const isUser = msg.role === 'user'
                    const isAdmin = msg.role === 'admin'
                    const showDate = (msg as typeof msg & { showDate?: boolean; dateLabel?: string }).showDate
                    const dateLabel = (msg as typeof msg & { dateLabel?: string }).dateLabel
                    const file = parseAttachment(msg.message)
                    return (
                      <div key={msg.id}>
                        {showDate && (
                          <div className="flex items-center gap-3 my-4">
                            <div className="flex-1 h-px bg-gray-800" />
                            <span className="text-[11px] text-gray-400 font-medium px-2">{dateLabel}</span>
                            <div className="flex-1 h-px bg-gray-800" />
                          </div>
                        )}
                        <div className={`flex flex-col mb-2 ${isUser ? 'items-end' : 'items-start'}`}>
                          <div className="flex items-center gap-1.5 mb-1 px-1">
                            {!isUser && <span className={`text-[11px] font-semibold ${isAdmin ? 'text-orange-400' : 'text-blue-400'}`}>{isAdmin ? '👤 Agent' : '🤖 Bot'}</span>}
                            {isUser && <span className="text-[11px] text-gray-400">Visitor</span>}
                            <span className="text-[10px] text-gray-400">{formatTime(msg.created_at)}</span>
                          </div>
                          {file ? (
                            <div className={`max-w-sm lg:max-w-md xl:max-w-lg rounded-2xl overflow-hidden shadow-sm border ${
                              isUser ? 'border-gray-600/30 rounded-tr-sm' : isAdmin ? 'border-amber-700/30 rounded-tl-sm' : 'border-slate-700/30 rounded-tl-sm'
                            }`}>
                              {isImageMime(file.mime) ? (
                                <a href={file.url} target="_blank" rel="noopener noreferrer" title={file.name}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={file.url} alt={file.name} className="block max-h-64 w-auto object-contain bg-gray-900" />
                                </a>
                              ) : (
                                <a href={file.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-2.5 px-4 py-3 bg-slate-800/80 hover:bg-slate-700/80 transition-colors">
                                  <span className="text-2xl shrink-0">📄</span>
                                  <span className="min-w-0">
                                    <span className="block text-sm text-blue-300 underline truncate max-w-[200px]">{file.name}</span>
                                    <span className="block text-[10px] text-gray-400">{file.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ` : ''}Download</span>
                                  </span>
                                </a>
                              )}
                            </div>
                          ) : (
                            <div className={`max-w-sm lg:max-w-md xl:max-w-lg px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                              isUser
                                ? 'bg-gray-700/80 text-gray-100 rounded-tr-sm border border-gray-600/30'
                                : isAdmin
                                ? 'bg-amber-900/40 text-amber-100 rounded-tl-sm border border-amber-700/30'
                                : 'bg-slate-800/80 text-gray-100 rounded-tl-sm border border-slate-700/30'
                            }`}>
                              {msg.message}
                            </div>
                          )}
                          {/* Language detection + translation (visitor text messages only) */}
                          {isUser && !file && (() => {
                            const a = msgAnalysis[msg.id]
                            if (!a || a.isEnglish) return null
                            return (
                              <div className="mt-1 flex flex-col items-end gap-1 max-w-sm lg:max-w-md xl:max-w-lg">
                                <span className="text-[10px] text-indigo-300/90 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-2 py-0.5">
                                  Detected: {a.langName}
                                </span>
                                {translateOn && (
                                  <div className="px-3 py-2 rounded-2xl rounded-tr-sm text-sm leading-relaxed whitespace-pre-wrap bg-indigo-950/40 border border-indigo-500/20 text-indigo-50">
                                    <span className="block text-[10px] uppercase tracking-wide text-indigo-300 mb-0.5">English</span>
                                    {a.english}
                                  </div>
                                )}
                              </div>
                            )
                          })()}
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
                </div>

                {/* Reply input */}
                <div className="px-4 py-3 border-t border-gray-800/80 bg-gray-900/60 flex-shrink-0">
                  {botEffectivelyActive ? (
                    <p className="text-[11px] text-blue-300 mb-2 flex items-center gap-1.5">
                      <span>🤖</span> Bot is active — toggle to Human to reply, or send a file to take over
                    </p>
                  ) : !botGlobalOff && scheduledBotOff && selectedSession.mode === 'bot' ? (
                    <p className="text-[11px] text-indigo-300 mb-2 flex items-center gap-1.5">
                      <span>🌙</span> Bot is off (scheduled) — human only. The bot won&apos;t reply right now; type to respond.
                    </p>
                  ) : null}
                  {uploadError && (
                    <p className="text-[11px] text-red-400 mb-2">{uploadError}</p>
                  )}
                  {visitorLang && (
                    <label className="flex items-center gap-1.5 mb-2 text-[11px] text-indigo-300 cursor-pointer select-none w-fit">
                      <input type="checkbox" checked={translateOut} onChange={(e) => setTranslateOut(e.target.checked)}
                        className="rounded accent-indigo-500 cursor-pointer" />
                      🌐 Translate my reply to {visitorLang} before sending
                    </label>
                  )}
                  <div className="flex gap-2">
                    <input ref={replyFileRef} type="file" className="hidden"
                      accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadReplyFile(f); e.target.value = '' }} />
                    <button
                      onClick={() => replyFileRef.current?.click()}
                      disabled={uploadingFile}
                      title="Attach a file"
                      className="px-3 py-2 bg-gray-800 border border-gray-700 text-gray-300 rounded-xl text-sm hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-40 self-end"
                    >
                      {uploadingFile ? '…' : '📎'}
                    </button>
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } }}
                      placeholder={botEffectivelyActive ? 'Switch to Human to reply' : 'Type a reply…'}
                      disabled={botEffectivelyActive || sending}
                      rows={2}
                      className="flex-1 bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5 text-sm text-gray-100 placeholder-gray-400 resize-none focus:outline-none focus:border-orange-500/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    />
                    <button
                      onClick={sendReply}
                      disabled={!replyText.trim() || sending || botEffectivelyActive}
                      className="px-4 py-2 bg-orange-500 text-white rounded-xl text-sm font-medium hover:bg-orange-600 active:bg-orange-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed self-end"
                    >
                      Send
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* ── Visitor detail panel ── */}
          {selectedSession && (
            <aside className="w-[320px] xl:w-[360px] flex-shrink-0 border-l border-gray-800/80 bg-gray-900/30 overflow-y-auto">
              <div className="px-4 py-3 border-b border-gray-800/80 bg-gray-900/40 sticky top-0 backdrop-blur z-10 flex items-center gap-2">
                <span className="text-base">{deviceIcon(visitorDetail?.technical.device_type ?? null)}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white leading-tight">Visitor details</p>
                  <p className="text-[10px] text-gray-400 font-mono truncate">{selectedSession.session_id}</p>
                </div>
              </div>

              {detailLoading && !visitorDetail ? (
                <div className="flex items-center gap-2 px-4 py-8 text-gray-400 text-xs">
                  <div className="w-3.5 h-3.5 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
                  Loading visitor…
                </div>
              ) : (
                <div className="p-4 space-y-5">

                  {/* Tags */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-300 mb-2">Tags</h3>
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {tags.map((t) => (
                          <span key={t} className="group/tag inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full text-white"
                            style={{ backgroundColor: `${accentColor}cc` }}>
                            {t}
                            <button onClick={() => removeTag(t)} title="Remove tag"
                              className="w-3.5 h-3.5 inline-flex items-center justify-center rounded-full hover:bg-black/30 text-white/80 hover:text-white leading-none">×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    <input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput) }
                        else if (e.key === 'Backspace' && !tagInput && tags.length) removeTag(tags[tags.length - 1])
                      }}
                      placeholder="Add a tag, press Enter…"
                      className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-2 text-xs text-gray-100 placeholder-gray-400 focus:outline-none focus:border-gray-500" />
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {['hot lead', 'got email', 'follow up', 'spam'].filter((q) => !tags.some((t) => t.toLowerCase() === q)).map((q) => (
                        <button key={q} onClick={() => addTag(q)}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800/60 border border-gray-700/60 text-gray-400 hover:text-gray-200 hover:border-gray-600 transition-colors">
                          + {q}
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* Contact (editable) */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-300 mb-2">Contact</h3>
                    <div className="space-y-2">
                      <input value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                        placeholder="Name"
                        className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-2 text-xs text-gray-100 placeholder-gray-400 focus:outline-none focus:border-gray-500" />
                      <input value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                        placeholder="Email" type="email"
                        className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-2 text-xs text-gray-100 placeholder-gray-400 focus:outline-none focus:border-gray-500" />
                      <input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                        placeholder="Phone"
                        className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-2 text-xs text-gray-100 placeholder-gray-400 focus:outline-none focus:border-gray-500" />
                      <textarea value={contactForm.notes} onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })}
                        placeholder="Notes…" rows={3}
                        className="w-full bg-gray-800/60 border border-gray-700/60 rounded-lg px-2.5 py-2 text-xs text-gray-100 placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
                      <div className="flex items-center gap-2">
                        <button onClick={saveContact} disabled={savingContact}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 transition-colors"
                          style={{ backgroundColor: accentColor }}>
                          {savingContact ? 'Saving…' : 'Save contact'}
                        </button>
                        {contactSaved && <span className="text-[11px] text-green-400">✓ Saved</span>}
                      </div>
                    </div>
                  </section>

                  {/* Stats row */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-300 mb-2">Activity</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'Visits', value: visitorDetail?.stats.visits ?? '—' },
                        { label: 'Chats', value: visitorDetail?.stats.chats ?? '—' },
                        { label: 'On site', value: formatDuration(visitorDetail?.stats.first_seen ?? null, visitorDetail?.stats.last_seen ?? null) },
                      ].map((s) => (
                        <div key={s.label} className="bg-gray-800/40 border border-gray-700/40 rounded-lg px-2 py-2.5 text-center">
                          <p className="text-base font-bold text-white leading-tight">{s.value}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{s.label}</p>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Visitor path */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-300 mb-2">
                      Visitor path {visitorDetail && visitorDetail.path.length > 0 && <span className="text-gray-400 normal-case font-normal">· {visitorDetail.path.length} page{visitorDetail.path.length !== 1 ? 's' : ''}</span>}
                    </h3>
                    {!visitorDetail || visitorDetail.path.length === 0 ? (
                      <p className="text-xs text-gray-400">No page history captured yet</p>
                    ) : (
                      <ol className="relative border-l border-gray-700/60 ml-1.5 space-y-3">
                        {visitorDetail.path.map((p, i) => (
                          <li key={i} className="ml-3.5 relative">
                            <span className="absolute -left-[1.18rem] top-1 w-2 h-2 rounded-full" style={{ backgroundColor: accentColor }} />
                            <p className="text-xs text-gray-200 leading-snug break-words" title={p.url ?? undefined}>{pageLabel(p)}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[10px] text-gray-400">{i + 1}.</span>
                              {p.at && <span className="text-[10px] text-gray-400">{formatDateTime(p.at)}</span>}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  {/* Technical info */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-300 mb-2">Technical</h3>
                    <dl className="space-y-1.5">
                      {[
                        { label: 'Location', value: [visitorDetail?.technical.country, visitorDetail?.technical.city].filter(Boolean).join(' · ') },
                        { label: 'Browser', value: visitorDetail?.technical.browser },
                        { label: 'Platform', value: visitorDetail?.technical.os },
                        { label: 'Device', value: visitorDetail?.technical.device_type },
                        { label: 'IP', value: visitorDetail?.technical.ip },
                        { label: 'Referrer', value: visitorDetail ? cleanReferrer(visitorDetail.technical.referrer) : null },
                      ].map((row) => (
                        <div key={row.label} className="flex items-start justify-between gap-3">
                          <dt className="text-[11px] text-gray-400 shrink-0">{row.label}</dt>
                          <dd className="text-[11px] text-gray-200 text-right break-all">{row.value || '—'}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {/* ── BILLING TAB ── */}
      {tab === 'billing' && (
        <div className="p-6 max-w-5xl mx-auto animate-in">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
            <div>
              <h2 className="text-base font-bold text-white">Leads &amp; Billing</h2>
              <p className="text-gray-400 text-xs mt-0.5">Auto-captured leads (email provided) for tracked sites — for monthly client billing.</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setBillingMonth(shiftMonth(billingMonth, -1))}
                className="px-2.5 py-1.5 text-xs text-gray-300 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition-colors" title="Previous month">◀</button>
              <input type="month" value={billingMonth} max={currentMonth()} onChange={(e) => e.target.value && setBillingMonth(e.target.value)}
                className="bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-600 [color-scheme:dark]" />
              <button onClick={() => { const next = shiftMonth(billingMonth, 1); if (next <= currentMonth()) setBillingMonth(next) }}
                disabled={billingMonth >= currentMonth()}
                className="px-2.5 py-1.5 text-xs text-gray-300 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title="Next month">▶</button>
              <button onClick={downloadBillingCsv} disabled={!billing || billing.leads.length === 0}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors disabled:opacity-40" style={{ backgroundColor: accentColor }}>
                ⬇ Download CSV
              </button>
            </div>
          </div>

          {billingLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 3 }).map((_, i) => <Skel key={i} className="h-20" />)}</div>
              <Skel className="h-64 w-full" />
            </div>
          ) : (
            <>
              {/* Totals + per-site breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-5">
                <div className="bg-gradient-to-br from-indigo-500/10 to-indigo-600/5 rounded-2xl p-5 border border-indigo-500/20">
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-2">Total leads this period</p>
                  <p className="text-[2.5rem] leading-none font-extrabold text-white tabular-nums">{billing?.total ?? 0}</p>
                </div>
                <div className="md:col-span-2 bg-gray-900 rounded-2xl p-5 border border-gray-800">
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-3">By site</p>
                  {(billing?.bySite ?? []).length === 0 ? (
                    <p className="text-xs text-gray-400">No leads in this period.</p>
                  ) : (
                    <div className="space-y-2">
                      {billing!.bySite.map((b) => (
                        <div key={b.site_id} className="flex items-center justify-between">
                          <span className="text-sm text-gray-200 truncate">{b.site_name}</span>
                          <span className="text-sm font-semibold text-white tabular-nums">{b.count}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Detail table */}
              <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[760px]">
                    <thead>
                      <tr className="border-b border-gray-800 bg-gray-800/40">
                        {['Email', 'Name', 'Phone', 'Site', 'Date Captured', ''].map((h) => (
                          <th key={h} className="text-left px-4 py-2.5 text-[11px] text-gray-400 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(billing?.leads ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center py-10">
                            <div className="flex flex-col items-center">
                              <div className="w-10 h-10 rounded-full bg-gray-800/70 flex items-center justify-center text-lg mb-2">🧾</div>
                              <p className="text-gray-300 text-sm font-medium">No leads captured this period</p>
                              <p className="text-gray-400 text-xs mt-0.5">A lead is recorded when a visitor shares an email on a tracked site.</p>
                            </div>
                          </td>
                        </tr>
                      ) : billing!.leads.map((l) => (
                        <tr key={l.session_id} onClick={() => openConversation(l)} title="Open this lead's conversation"
                          className="border-b border-gray-800/40 hover:bg-gray-800/40 transition-colors cursor-pointer">
                          <td className="px-4 py-3 text-blue-300 whitespace-nowrap">{l.email}</td>
                          <td className="px-4 py-3 text-gray-200 whitespace-nowrap">{l.name || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3 text-gray-300 whitespace-nowrap">{l.phone || <span className="text-gray-400">—</span>}</td>
                          <td className="px-4 py-3 whitespace-nowrap"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-300">{l.site_name}</span></td>
                          <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{formatDateTime(l.captured_at)}</td>
                          <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                            <button onClick={() => openConversation(l)} className="text-xs text-indigo-300 hover:text-indigo-200 hover:underline">View chat →</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'performance' && (
        <div className="p-6 max-w-6xl mx-auto animate-in">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
            <div>
              <h2 className="text-base font-bold text-white">Agent Performance</h2>
              <p className="text-gray-400 text-xs mt-0.5">Per-agent responsiveness &amp; accountability for {WORKSPACE_LABEL[workspace]} — who&apos;s replying, who&apos;s slow, who&apos;s missing chats.</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setPerfMonth(shiftMonth(perfMonth, -1))}
                className="px-2.5 py-1.5 text-xs text-gray-300 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition-colors" title="Previous month">◀</button>
              <input type="month" value={perfMonth} max={currentMonth()} onChange={(e) => e.target.value && setPerfMonth(e.target.value)}
                className="bg-gray-900 border border-gray-800 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-gray-600 [color-scheme:dark]" />
              <button onClick={() => { const next = shiftMonth(perfMonth, 1); if (next <= currentMonth()) setPerfMonth(next) }}
                disabled={perfMonth >= currentMonth()}
                className="px-2.5 py-1.5 text-xs text-gray-300 bg-gray-900 border border-gray-800 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title="Next month">▶</button>
            </div>
          </div>

          {perfLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">{Array.from({ length: 5 }).map((_, i) => <Skel key={i} className="h-20" />)}</div>
              <Skel className="h-64 w-full" />
            </div>
          ) : (
            <>
              {/* Workspace-level summary */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
                <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-1.5">Conversations</p>
                  <p className="text-3xl leading-none font-extrabold text-white tabular-nums">{perf?.summary.totalConversations ?? 0}</p>
                </div>
                <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-1.5">Leads</p>
                  <p className="text-3xl leading-none font-extrabold text-emerald-300 tabular-nums">{perf?.summary.totalLeads ?? 0}</p>
                </div>
                <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-1.5">Avg response</p>
                  <p className="text-3xl leading-none font-extrabold text-white tabular-nums">{formatMs(perf?.summary.avgResponseMs)}</p>
                </div>
                <div className={`rounded-2xl p-4 border ${(perf?.summary.totalMissed ?? 0) > 0 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-gray-900 border-gray-800'}`}>
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-1.5">Missed (slow)</p>
                  <p className={`text-3xl leading-none font-extrabold tabular-nums ${(perf?.summary.totalMissed ?? 0) > 0 ? 'text-amber-300' : 'text-white'}`}>{perf?.summary.totalMissed ?? 0}</p>
                </div>
                <div className={`rounded-2xl p-4 border ${(perf?.summary.totalUnanswered ?? 0) > 0 ? 'bg-red-500/10 border-red-500/30' : 'bg-gray-900 border-gray-800'}`}>
                  <p className="text-gray-400 text-[11px] font-medium uppercase tracking-wide mb-1.5">Unanswered</p>
                  <p className={`text-3xl leading-none font-extrabold tabular-nums ${(perf?.summary.totalUnanswered ?? 0) > 0 ? 'text-red-300' : 'text-white'}`}>{perf?.summary.totalUnanswered ?? 0}</p>
                </div>
              </div>

              {/* Attribution status — historical-estimate vs accurate-going-forward */}
              {perf && perf.summary.totalReplies > 0 && perf.unattributedReplies > 0 && (
                <div className="mb-4 rounded-xl border border-gray-800 bg-gray-900/60 px-4 py-2.5 text-[11px] text-gray-400 flex items-start gap-2">
                  <span className="text-gray-400">ℹ️</span>
                  <span>
                    <span className="text-gray-300 font-medium">{perf.summary.attributedReplies}</span> of <span className="text-gray-300 font-medium">{perf.summary.totalReplies}</span> agent replies this period are attributed to a specific agent.
                    The remaining <span className="text-gray-300 font-medium">{perf.unattributedReplies}</span> were sent before per-agent tracking was added, so they aren&apos;t counted in the per-agent rows below (the workspace totals above include everything). Attribution is exact going forward.
                  </span>
                </div>
              )}

              {/* Per-agent table */}
              <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[720px]">
                    <thead>
                      <tr className="border-b border-gray-800 bg-gray-800/40">
                        {['Agent', 'Conversations', 'Replies', 'Avg response', 'Slow replies'].map((h, i) => (
                          <th key={h} className={`px-4 py-2.5 text-[11px] text-gray-400 font-semibold uppercase tracking-wide whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(perf?.agents ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={5} className="text-center py-10">
                            <div className="flex flex-col items-center">
                              <div className="w-10 h-10 rounded-full bg-gray-800/70 flex items-center justify-center text-lg mb-2">👥</div>
                              <p className="text-gray-300 text-sm font-medium">No agents in this workspace</p>
                              <p className="text-gray-400 text-xs mt-0.5">Add members to see per-agent performance.</p>
                            </div>
                          </td>
                        </tr>
                      ) : perf!.agents.map((a) => {
                        const idle = a.replies === 0
                        const slowAvg = a.avgResponseMs !== null && a.avgResponseMs > 120000
                        return (
                          <tr key={a.id} className={`border-b border-gray-800/40 transition-colors ${idle ? 'opacity-60' : 'hover:bg-gray-800/40'}`}>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                <span className="text-gray-200">{a.email}</span>
                                {a.builtin && <span className="text-[9px] px-1.5 py-px rounded-full bg-purple-500/20 text-purple-300 font-semibold uppercase tracking-wide">admin</span>}
                                {a.former && <span className="text-[9px] px-1.5 py-px rounded-full bg-gray-700 text-gray-400 font-semibold uppercase tracking-wide">former</span>}
                                {idle && <span className="text-[9px] px-1.5 py-px rounded-full bg-amber-500/15 text-amber-300/90 font-semibold uppercase tracking-wide">no replies</span>}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-gray-200 tabular-nums">{a.handled}</td>
                            <td className="px-4 py-3 text-right text-gray-200 tabular-nums">{a.replies}</td>
                            <td className={`px-4 py-3 text-right tabular-nums font-medium ${slowAvg ? 'text-red-300' : idle ? 'text-gray-400' : 'text-emerald-300'}`}>{formatMs(a.avgResponseMs)}</td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {a.slowReplies > 0
                                ? <span className="inline-block px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 font-semibold">{a.slowReplies}</span>
                                : <span className="text-gray-400">0</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-gray-400 text-[11px] mt-3 leading-relaxed">
                <span className="text-gray-400 font-medium">How to read this:</span> Avg response is the time between a visitor&apos;s message and the agent&apos;s reply.
                A reply is &quot;slow&quot; if it took longer than 2 minutes. <span className="text-amber-300/90">Missed</span> = a visitor messaged while the bot was off (human takeover or off-hours) and no agent replied within 2 minutes.
                <span className="text-red-300/90"> Unanswered</span> = a conversation still waiting on its first agent reply. Missed &amp; unanswered are workspace-wide (no single agent owns them).
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
