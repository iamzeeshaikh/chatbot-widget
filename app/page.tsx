'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import GlobalSearch from '@/app/components/GlobalSearch'
// Same icon set, stroke weight and sizing the CRM pages use, so the dashboard
// and /tasks · /pipeline · /leads read as one product. Emoji rendered at the
// mercy of each OS's font; these follow currentColor and the type scale.
import {
  Smartphone, Tablet, Monitor, Circle, UserCheck, UserRound, Mail, ShoppingCart,
  MessageSquare, BarChart3, Lock, Vibrate, Sun, Moon, Bell, BellOff, Users,
  Trophy, Globe, Bot, BotOff, TrendingUp, Inbox, Pencil, Trash2, ChevronLeft,
  ChevronRight, Repeat, Eye, Contact, UserPlus, Languages, Pin, User, FileText,
  Paperclip, Ban, Flame, AlertTriangle, ChevronUp, ChevronDown, Download,
  CreditCard, Info, Check, X, TrendingDown, LogOut, type LucideIcon,
} from 'lucide-react'
import { parseAttachment, isImageMime } from '@/lib/attachment'
import { LEAD_TRACKED_SITES, WORKSPACE_LABEL } from '@/lib/workspaces'
import { isBotOffBySchedule } from '@/lib/botschedule'
import { isBotEnabled } from '@/lib/botflag'
import { LEAD_STATUSES, LEAD_STATUS_STYLE, type LeadStatus } from '@/lib/leadstatus'
import { isClosingMessage } from '@/lib/closing'
import { LIVE_MAX_ON_SITE_MS, asUtcIso } from '@/lib/visitor'
import { formatTime, formatDateTime, dateDividerLabel } from '@/lib/datetime'
import { isQuoteLeadMessage, stripQuoteTag, cleanQuoteSubject, leadSource, type LeadSource } from '@/lib/quoteintake'

const SITE_URLS: Record<string, string> = {
  texasfootball: 'texasfootballuniforms.com',
  volleyballuniforms: 'thevolleyballuniforms.com',
  californiasoccer: 'californiasoccerjerseys.com',
  floridabasketball: 'floridabasketballjerseys.com',
  baseballjerseys: 'thebaseballjerseys.com',
  zeecustomboxes: 'zeecustomboxes.com.au',
  burgersleeves: 'burgersleeves.com.au',
  leadgen: 'leadgen.zeeops.dev',
  shopcardboardboxes: 'shopcardboardboxes.com',
  thetubepackaging: 'thetubepackaging.com',
  kraftboxpack: 'kraftboxpack.com',
  thecandlepackaging: 'thecandlepackaging.com',
  theburgerboxes: 'theburgerboxes.com',
  smallfoodboxes: 'smallfoodboxes.com',
  thepapercups: 'thepapercups.com',
  thewaxpapers: 'thewaxpapers.co',
  thecustomstickers: 'thecustomstickers.co',
  zeepack: 'zeepack.co',
  thecerealboxes: 'thecerealboxes.com',
  hotdogtrays: 'hotdogtrays.com',
  theburgersleeves: 'theburgersleeves.com',
  thecandlesleeves: 'thecandlesleeves.com',
  cardboardcups: 'cardboardcups.com',
  thecoffeesleeves: 'thecoffeesleeves.com',
  shopbubblemailers: 'shopbubblemailers.com',
  insertshub: 'insertshub.com',
  thediecutstickers: 'thediecutstickers.com',
  customperfumeboxes: 'customperfumeboxes.com',
  shopdisplayboxes: 'shopdisplayboxes.com',
  peptidesboxes: 'peptidesboxes.com',
}

// Each site's favicon via Google's favicon service (falls back to a coloured
// letter tile in <SiteIcon> when the domain is unknown or the icon fails).
function siteFaviconUrl(siteId: string): string {
  const d = SITE_URLS[siteId]
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=64` : ''
}

const SITE_ACCENT: Record<string, string> = {
  texasfootball: '#ef4444',
  volleyballuniforms: '#f59e0b',
  californiasoccer: '#3b82f6',
  floridabasketball: '#8b5cf6',
  baseballjerseys: '#10b981',
  zeecustomboxes: '#2563eb',
  burgersleeves: '#d97706',
  leadgen: '#6366f1',
  shopcardboardboxes: '#b45309',
  thetubepackaging: '#0f766e',
  kraftboxpack: '#855f35',
  thecandlepackaging: '#ff5e14',
  theburgerboxes: '#c0392b',
  smallfoodboxes: '#2e7d32',
  thepapercups: '#6d4c2f',
  thewaxpapers: '#ca8a04',
  thecustomstickers: '#ec4899',
  zeepack: '#16a34a',
  thecerealboxes: '#ea580c',
  hotdogtrays: '#b91c1c',
  theburgersleeves: '#d97706',
  thecandlesleeves: '#9333ea',
  cardboardcups: '#a16207',
  thecoffeesleeves: '#6f4e37',
  shopbubblemailers: '#0ea5e9',
  insertshub: '#475569',
  thediecutstickers: '#7c3aed',
  customperfumeboxes: '#be185d',
  shopdisplayboxes: '#0f766e',
  peptidesboxes: '#0284c7',
}

const FAVICON_PACKAGING = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="12" y="40" width="76" height="52" rx="5" fill="#2563eb"/><polygon points="12,40 50,22 88,40" fill="#1d4ed8"/><rect x="38" y="40" width="24" height="52" fill="#93c5fd" opacity="0.35"/></svg>')}`
const FAVICON_SPORTS = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#16a34a"/><path d="M35 22 Q31 50 38 62 Q44 72 50 74 Q56 72 62 62 Q69 50 65 22Z" fill="white"/><path d="M35 30 Q20 30 20 44 Q20 56 35 56" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M65 30 Q80 30 80 44 Q80 56 65 56" stroke="white" stroke-width="7" fill="none" stroke-linecap="round"/><rect x="44" y="74" width="12" height="10" rx="2" fill="white"/><rect x="32" y="84" width="36" height="8" rx="3" fill="white"/></svg>')}`

interface Site { site_id: string; name: string; bot_name: string; primary_color: string }
interface Lead { id: string; site_id: string; name: string | null; email: string | null; phone: string | null; message: string | null; created_at: string; product?: string | null; quantity?: string | null; budget?: string | null; timeline?: string | null; qualification_score?: number | null; session_id?: string | null }
interface Session { session_id: string; site_id: string; site_name: string; preview: string; last_at: string; message_count: number; last_role?: string; mode: string; lead: { name: string | null; email: string | null } | null; tags?: string[]; assignedTo?: string | null }
interface ChatMsg { id: string; session_id: string; site_id: string; role: string; message: string; created_at: string; author?: string | null }
interface Visitor { session_id: string; site_id: string; site_name: string; primary_color: string; page_url: string | null; page_title: string | null; referrer: string | null; visits: number; last_seen: string; created_at: string; device_type: string | null; browser: string | null; os: string | null; country: string | null; city: string | null }
// Visitors-history row (Zendesk-style history): a Visitor plus whether the
// session ever chatted, whether the chat is still waiting on an agent reply
// (accountability), and its final status.
interface HistVisitor extends Visitor { status: string; has_chat: boolean; awaiting_reply?: boolean; pages: number; history: { u: string | null; t: string | null; ts: string }[]; ip: string | null; ip_blocked: boolean }

// Buying-intent score for a visitor: pages browsed + time on site + return
// visits. 3+ points = a "hot" visitor worth proactively messaging first.
function hotPoints(v: { pages: number; visits: number; created_at: string; last_seen: string }): number {
  const durMs = new Date(v.last_seen).getTime() - new Date(v.created_at).getTime()
  return (v.pages >= 6 ? 2 : v.pages >= 3 ? 1 : 0)
    + (durMs >= 8 * 60000 ? 2 : durMs >= 3 * 60000 ? 1 : 0)
    + (v.visits >= 4 ? 2 : v.visits >= 2 ? 1 : 0)
}
const isHotVisitor = (v: { pages: number; visits: number; created_at: string; last_seen: string }) => hotPoints(v) >= 3
interface AnalyticsPoint { label: string; visitors: number; unique: number; chats: number; picked?: number; notPicked?: number }
// `email` is null only for an admin's manual mark (see markLeadManually) —
// every automatic capture and every quote lead has one.
interface BillingLead { session_id: string; site_id: string; site_name: string; email: string | null; name: string | null; phone: string | null; captured_at: string; status: LeadStatus; agent: string | null; country: string | null; referrer: string | null; source: 'chat' | 'quote' | 'checkout'; manual?: boolean; quote_message?: string }
interface BillingData { from: string; to: string; total: number; billable: number; billableBase: number; prevTotal: number; byStatus: Record<string, number>; leads: BillingLead[]; bySite: { site_id: string; site_name: string; count: number }[] }
interface PerfAgent { id: string; email: string; builtin: boolean; former: boolean; handled: number; replies: number; avgResponseMs: number | null; slowReplies: number; measuredReplies: number; leads: number; dropped: number; proactive: number; lastReplyAt: string | null }
interface PerfDaily { date: string; visitors: number; chats: number; picked: number; notPicked: number; chatSessions: { session_id: string; site_id: string }[]; byAgent?: { email: string; picked: number }[] }
interface PerfData { from: string; to: string; summary: { totalConversations: number; answeredConversations: number; totalLeads: number; totalMissed: number; totalUnanswered: number; ignoredVisitors: number; totalReplies: number; attributedReplies: number; avgResponseMs: number | null }; agents: PerfAgent[]; daily: PerfDaily[]; unattributedReplies: number }
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

// Matches lib/leadtracking.ts's LEAD_CAPTURE_ROLE/parseLeadCapture — kept as a
// tiny local copy (not imported) since that module pulls in the server-only
// Supabase client, which must never end up in the client bundle.
const LEAD_CAPTURE_ROLE = 'lead_capture'
function parseLeadCapture(message: string | null): { email: string | null; name: string | null; phone: string | null; manual: boolean } | null {
  if (!message) return null
  try {
    const o = JSON.parse(message)
    if (o && (typeof o.email === 'string' || o.manual === true)) {
      return {
        email: typeof o.email === 'string' && o.email ? o.email : null,
        name: typeof o.name === 'string' && o.name ? o.name : null,
        phone: typeof o.phone === 'string' && o.phone ? o.phone : null,
        manual: o.manual === true,
      }
    }
  } catch { /* not a lead row */ }
  return null
}

function cleanLeadMessage(msg: string | null): string {
  if (!msg) return '-'
  // Quote/checkout leads are an email; their first line is the subject, which
  // can carry Gmail's "[image: 📋]" placeholder and emoji from the customer's
  // own mail client. Cleaned for display only — nothing stored changes.
  if (isQuoteLeadMessage(msg) || msg.startsWith('[Checkout] ')) {
    const subject = cleanQuoteSubject(stripQuoteTag(msg).split('\n')[0])
    if (subject) return subject.slice(0, 150)
  }
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
function DeviceIcon({ d, className = '', size = 15 }: { d: string | null; className?: string; size?: number }) {
  const I = d === 'Mobile' ? Smartphone : d === 'Tablet' ? Tablet : Monitor
  return <I size={size} strokeWidth={2} className={className} aria-hidden />
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

// Short, human name for an agent from their email (ahmed@zeeops.dev → "ahmed").
// Used on the compact assignment badges where the full email won't fit.
// Header vocabulary, defined once so every tab and every utility button is
// literally the same box. The uneven rhythm in the old bar came from each entry
// carrying its own paddings; sharing them is what makes the spacing regular.
//
// NAV_TAB_ON is a background and a shadow ONLY — no border, no extra padding.
// An active state that changes a tab's footprint moves its neighbours, and a
// click already aimed at one of them then lands somewhere else.
const NAV_TAB = 'relative h-8 px-2 xl:px-3 rounded-lg text-xs font-medium transition-colors flex items-center justify-center gap-1.5 min-w-0 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
const NAV_TAB_ON = 'bg-white text-gray-900 shadow-sm'
const NAV_TAB_OFF = 'text-gray-500 hover:text-gray-900 hover:bg-white/60'
// Wide enough for the largest value each badge is allowed to display, which is
// why the values are capped at 999+/99+ below. A reserve narrower than the
// content is not a reserve: this strip moved 5px the moment a 3-digit chat count
// arrived, which is the whole bug again in miniature.
// On a phone the count rides the corner of its tab instead of sitting inside
// it. Four equal cells only have room for a label, and a count in the flow was
// ellipsising every one of them ("Ch…", "V…", "Ta…"); three wider columns fixed
// that but pushed the sticky header to 169px with a lone tab stranded on a
// third row. Absolutely positioned it costs no width at all — which also means
// it can be hidden at zero on mobile without moving anything, while from `sm`
// up it goes back in the flow and is always present.
const NAV_COUNT = 'absolute -top-1 -right-1 sm:static text-[10px] leading-none px-1.5 py-1 rounded-full font-semibold tabular-nums text-center min-w-[1.9rem] shrink-0'
// A stable id for THIS browser profile, minted once and kept forever.
// The server uses it to retire whatever subscription this profile held before,
// so re-subscribing replaces rather than adds. Without it a profile could hold
// several live endpoints at once and get a duplicate of every notification —
// which is exactly what happened. Deliberately not an identifier of the person:
// it says "same browser as last time" and nothing else.
function pushDeviceId(): string {
  try {
    const k = 'zee-push-did'
    let v = localStorage.getItem(k)
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v) }
    return v
  } catch { return '' }
}

// Shape only — no colour. Each utility button supplies its own, because a
// state colour appended after a base string that already sets `text-…` is a
// coin toss on which utility CSS puts last, not an override.
const ICON_BTN = 'shrink-0 inline-flex items-center justify-center h-8 min-w-8 px-1.5 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500'
// The resting look: a switch you set once, not something to be drawn to.
const ICON_BTN_IDLE = 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'

function agentShort(email: string | null | undefined): string {
  if (!email) return ''
  const name = email.split('@')[0] || email
  return name.charAt(0).toUpperCase() + name.slice(1)
}

// A site's favicon, falling back to a coloured letter tile (its accent colour +
// first letter) when the domain is unknown or the icon fails to load.
function SiteIcon({ siteId, name, size = 32, accent }: { siteId: string; name: string; size?: number; accent: string }) {
  const [failed, setFailed] = useState(false)
  const url = siteFaviconUrl(siteId)
  if (url && !failed) {
    return (
      <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)}
        className="rounded-lg object-contain bg-white border border-gray-200 shrink-0" style={{ width: size, height: size, padding: Math.max(2, size * 0.12) }} />
    )
  }
  return (
    <div className="rounded-lg flex items-center justify-center text-white font-bold shrink-0"
      style={{ width: size, height: size, backgroundColor: accent, fontSize: size * 0.4 }}>
      {name[0]?.toUpperCase()}
    </div>
  )
}

// Compact "who's handling this chat" badge, shown on visitor/chat cards so every
// agent can see a chat is already picked up before they start replying to it.
function AssignBadge({ email, me }: { email: string | null | undefined; me: string }) {
  if (!email) {
    return (
      <span className="text-[9px] font-medium text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-1.5 py-px whitespace-nowrap inline-flex items-center gap-1"><Circle size={8} strokeWidth={2.5} aria-hidden /> Unassigned</span>
    )
  }
  const mine = email === me
  return (
    <span
      title={mine ? `Assigned to you (${email})` : `Assigned to ${email}`}
      className={`text-[9px] font-semibold rounded-full px-1.5 py-px whitespace-nowrap border ${mine ? 'text-green-700 bg-green-100 border-green-200' : 'text-amber-700 bg-amber-100 border-amber-200'}`}>
      {mine
        ? <span className="inline-flex items-center gap-1"><UserCheck size={9} strokeWidth={2.5} aria-hidden /> You</span>
        : <span className="inline-flex items-center gap-1"><UserRound size={9} strokeWidth={2.5} aria-hidden /> {agentShort(email)}</span>}
    </span>
  )
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
  return <div className={`animate-pulse rounded-lg bg-gray-200 ${className}`} />
}

// Overview skeleton: mirrors the real layout (stat cards + chart) so nothing
// shifts when data arrives.
function OverviewSkeleton() {
  return (
    <div className="animate-in">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-2xl p-5 border border-gray-200 bg-gray-100">
            <Skel className="h-3 w-16 mb-4" />
            <Skel className="h-9 w-12" />
          </div>
        ))}
      </div>
      <div className="bg-gray-100 rounded-xl border border-gray-200 p-5 mb-6">
        <Skel className="h-4 w-44 mb-4" />
        <Skel className="h-[200px] w-full" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-5"><Skel className="h-4 w-32 mb-4" /><Skel className="h-24 w-full" /></div>
        <div className="bg-gray-100 rounded-xl border border-gray-200 p-5"><Skel className="h-4 w-28 mb-4" /><div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skel key={i} className="h-3 w-full" />)}</div></div>
      </div>
    </div>
  )
}

// Where a lead came from. Checkout leads are cart orders pulled out of Gmail:
// they count everywhere a lead counts EXCEPT the Billing tab, which only ever
// queries QUOTE_TAG rows (see lib/quoteintake.ts).
const LEAD_SOURCE_BADGE: Record<LeadSource, { label: string; Icon: LucideIcon; cls: string }> = {
  quote: { label: 'Quote', Icon: Mail, cls: 'text-amber-700 bg-amber-100 border-amber-200' },
  checkout: { label: 'Checkout', Icon: ShoppingCart, cls: 'text-purple-700 bg-purple-100 border-purple-200' },
  chat: { label: 'Chat', Icon: MessageSquare, cls: 'text-blue-700 bg-blue-100 border-blue-200' },
}

function LeadSourceBadge({ message, className = '' }: { message: string | null | undefined; className?: string }) {
  const { label, Icon, cls } = LEAD_SOURCE_BADGE[leadSource(message)]
  return <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 whitespace-nowrap inline-flex items-center gap-1 ${cls} ${className}`}><Icon size={11} strokeWidth={2} aria-hidden /> {label}</span>
}

// Lightweight dependency-free SVG line chart: Visitors vs Chats over time.
const UNIQUE_COLOR = '#8b5cf6'
// Shared by the legend, the lines and the hover tooltip so a series always
// reads as the same colour wherever it appears.
const PICKED_COLOR = '#22c55e'
const NOTPICKED_COLOR = '#f87171'
const CHATS_COLOR = '#f59e0b'

function AnalyticsChart({ points, accent, totalUnique }: { points: AnalyticsPoint[]; accent: string; totalUnique: number }) {
  const W = 760, H = 220, padL = 30, padR = 14, padT = 14, padB = 26
  const n = points.length
  const maxV = Math.max(1, ...points.map((p) => Math.max(p.visitors, p.chats, p.picked ?? 0, p.notPicked ?? 0)))
  const x = (i: number) => padL + (n <= 1 ? 0 : (i * (W - padL - padR)) / (n - 1))
  const y = (val: number) => padT + (H - padT - padB) * (1 - val / maxV)

  // Catmull-Rom → cubic bezier for a gently smoothed line (k tunes the curve).
  const smooth = (key: 'visitors' | 'chats' | 'unique' | 'picked' | 'notPicked'): string => {
    const pts = points.map((p, i) => ({ x: x(i), y: y(p[key] ?? 0) }))
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
  const totalPicked = points.reduce((s, p) => s + (p.picked ?? 0), 0)
  const totalNotPicked = points.reduce((s, p) => s + (p.notPicked ?? 0), 0)
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
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: accent }} /><span className="text-gray-700">Visits</span><span className="text-gray-500">({totalVisitors})</span></span>
        <span className="flex items-center gap-1.5" title="Distinct people (persistent browser id; a returning person counts once) — the dashed line">
          <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: UNIQUE_COLOR }} /><span className="text-gray-700">Unique visitors</span><span className="text-gray-500">({totalUnique})</span>
        </span>
        <span className="flex items-center gap-1.5" title="Visits where an agent replied">
          <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: PICKED_COLOR }} /><span className="text-gray-700">Picked</span><span className="text-gray-500">({totalPicked})</span>
        </span>
        <span className="flex items-center gap-1.5" title="Visits that never got an agent reply">
          <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: NOTPICKED_COLOR }} /><span className="text-gray-700">Not picked</span><span className="text-gray-500">({totalNotPicked})</span>
        </span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: CHATS_COLOR }} /><span className="text-gray-700">Chats</span><span className="text-gray-500">({totalChats})</span></span>
      </div>
      {totalVisitors === 0 && totalChats === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center mb-2 text-gray-500"><BarChart3 size={18} strokeWidth={2} aria-hidden /></div>
          <p className="text-xs text-gray-500">No activity in this period yet</p>
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
              <line key={i} x1={padL} x2={W - padR} y1={y(gv)} y2={y(gv)} stroke="#111827" strokeOpacity={0.06} strokeWidth={1} strokeDasharray="3 4" />
            ))}
            <path d={areaFor('visitors')} fill={`url(#grad-v-${gid})`} stroke="none" />
            {/* Picked / not picked sit under the headline series: they split the
                same visitor total, so they stay thinner and read as a breakdown
                rather than competing with the Visits line. */}
            <path d={smooth('notPicked')} fill="none" stroke={NOTPICKED_COLOR} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            <path d={smooth('picked')} fill="none" stroke={PICKED_COLOR} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            <path d={smooth('chats')} fill="none" stroke={CHATS_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <path d={smooth('unique')} fill="none" stroke={UNIQUE_COLOR} strokeWidth={1.75} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
            <path d={smooth('visitors')} fill="none" stroke={accent} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          {/* Axis labels live in HTML, not the SVG: the SVG is stretched with
              preserveAspectRatio="none", which horizontally distorts any text
              inside it on wide screens. */}
          {gridVals.map((gv, i) => (
            <span key={`y${i}`} className="absolute text-[10px] text-gray-500 tabular-nums pointer-events-none"
              style={{ left: 2, top: pct(y(gv), H), transform: 'translateY(-50%)' }}>{gv}</span>
          ))}
          {points.map((p, i) => (i % labelEvery === 0 || i === n - 1) ? (
            <span key={`x${i}`} className="absolute bottom-0 text-[10px] text-gray-500 whitespace-nowrap pointer-events-none"
              style={{ left: pct(x(i), W), transform: i === 0 ? 'none' : i === n - 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{p.label}</span>
          ) : null)}
          {/* Hover overlay: guide line, point dots, and an exact-value tooltip. */}
          {hover !== null && points[hover] && (
            <>
              <div className="absolute top-0 bottom-0 w-px bg-gray-900/10 pointer-events-none" style={{ left: pct(x(hover), W) }} />
              <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-white pointer-events-none" style={{ left: pct(x(hover), W), top: pct(y(points[hover].visitors), H), transform: 'translate(-50%,-50%)', backgroundColor: accent }} />
              <div className="absolute w-2.5 h-2.5 rounded-full border-2 border-white bg-amber-400 pointer-events-none" style={{ left: pct(x(hover), W), top: pct(y(points[hover].chats), H), transform: 'translate(-50%,-50%)' }} />
              <div className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full mb-2"
                style={{ left: `min(max(${pct(x(hover), W)}, 56px), calc(100% - 56px))`, top: pct(Math.min(y(points[hover].visitors), y(points[hover].chats)), H) }}>
                <div className="mb-2 rounded-lg border border-gray-300 bg-white/95 shadow-xl px-2.5 py-1.5 backdrop-blur">
                  <p className="text-[10px] text-gray-500 mb-0.5 whitespace-nowrap">{points[hover].label}</p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accent }} /><span className="text-gray-700">Visits</span><span className="font-semibold text-gray-900 ml-auto pl-2">{points[hover].visitors}</span></p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: UNIQUE_COLOR }} /><span className="text-gray-700">Unique</span><span className="font-semibold text-gray-900 ml-auto pl-2">{points[hover].unique ?? 0}</span></p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: PICKED_COLOR }} /><span className="text-gray-700">Picked</span><span className="font-semibold text-gray-900 ml-auto pl-2">{points[hover].picked ?? 0}</span></p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: NOTPICKED_COLOR }} /><span className="text-gray-700">Not picked</span><span className="font-semibold text-gray-900 ml-auto pl-2">{points[hover].notPicked ?? 0}</span></p>
                  <p className="text-[11px] whitespace-nowrap flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: CHATS_COLOR }} /><span className="text-gray-700">Chats</span><span className="font-semibold text-gray-900 ml-auto pl-2">{points[hover].chats}</span></p>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Repeating waiting-chat/visitor alert ──────────────────────────────────────
// A single chime is easy to miss. As long as ANY in-scope conversation is
// still waiting on a human reply (its latest message is the visitor's) or a
// live visitor is unengaged, the dashboard re-chimes at this interval and only
// goes quiet once an agent engages, the sound is muted, or the visitor message
// is older than the freshness window (the visitor has clearly left — matches
// the widget's 30-minute session gap, so ancient unanswered chats can't ring
// forever). The cadence is deliberately aggressive: it rings continuously
// until an agent actually messages the customer.
const WAITING_REPEAT_MS = 3 * 1000
const WAITING_FRESH_MS = 30 * 60 * 1000
// Live-visitor poll: also the worst-case delay between a visitor landing on a
// site and the arrival chime, so it's kept tight.
const VISITOR_POLL_MS = 5 * 1000

// Agents leave this dashboard open all day, and on a background tab it went on
// polling six endpoints regardless — a single forgotten tab is ~24,000 requests
// per 8-hour shift. That volume is what exhausted the database's disk-IO budget
// on 2026-07-24 and took the whole system down, so a poll nobody is looking at
// is not a harmless one.
//
// Skipped, not stopped: the interval keeps ticking so nothing has to be torn
// down and rebuilt, and `visibleTick` re-runs each polling effect the moment the
// tab comes back, which re-fires its initial fetch — so the agent sees fresh
// data immediately rather than waiting out the interval.
//
// Deliberately NOT gated: the 60-second attendance heartbeat (an agent working
// in another tab is still on duty and must not read as offline) and the
// waiting-chat alarm, which touches no network at all.
const whenVisible = (fn: () => void) => () => {
  if (typeof document === 'undefined' || !document.hidden) fn()
}

function useVisibleTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const onChange = () => { if (!document.hidden) setTick((n) => n + 1) }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return tick
}

export default function Dashboard() {
  const router = useRouter() // client-side nav to the CRM record page
  const [tab, setTab] = useState<'overview' | 'conversations' | 'visitors' | 'billing' | 'performance'>('overview')

  const [userRole, setUserRole] = useState<'admin' | 'standard'>('standard')
  const [userEmail, setUserEmail] = useState('')
  const [userSites, setUserSites] = useState<string[]>([])
  // Each member belongs to exactly one dashboard ("workspace"), which drives the
  // whole theme — sports admins never see packaging and vice versa.
  const [workspace, setWorkspace] = useState<'sports' | 'packaging'>('packaging')
  const [authReady, setAuthReady] = useState(false)
  // Navigation badge for /tasks — overdue + due today for this member.
  const [taskBadge, setTaskBadge] = useState(0)
  const [taskBadgeOverdue, setTaskBadgeOverdue] = useState(0)
  // Customer replies nobody has opened, on leads this agent owns.
  const [unreadReplies, setUnreadReplies] = useState(0)
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

  // Keep the active tab across reloads (a hard refresh used to always land on
  // Overview). Restored once auth is ready so the saved tab can be validated
  // against this member's access; saving starts only after the restore so the
  // initial 'overview' can never clobber the stored value. A ?tab=/&session=
  // in the URL (deep link / open-in-new-tab / back-forward) beats the saved tab.
  const tabRestored = useRef(false)
  useEffect(() => {
    if (!authReady || tabRestored.current) return
    tabRestored.current = true
    const params = new URLSearchParams(window.location.search)
    const urlTab = params.get('tab')
    const urlSession = params.get('session')
    const urlSite = params.get('site')
    if (urlSession && urlSite) {
      openConversationBySession({ sessionId: urlSession, siteId: urlSite })
      return
    }
    if (urlTab === 'overview' || urlTab === 'conversations' || urlTab === 'visitors' || urlTab === 'billing' || urlTab === 'performance') {
      setTab(urlTab)
      return
    }
    const saved = localStorage.getItem('zee-dash-tab')
    if (saved === 'overview' || saved === 'conversations' || saved === 'visitors'
      || (saved === 'billing' && userSites.some((id) => LEAD_TRACKED_SITES.includes(id)))
      || (saved === 'performance' && userRole === 'admin')) {
      setTab(saved as typeof tab)
    }
  }, [authReady, userSites, userRole]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tabRestored.current) localStorage.setItem('zee-dash-tab', tab)
  }, [tab])

  const applyingHistory = useRef(false)
  const historySynced = useRef(false)
  const openBySessionRef = useRef<(opts: { sessionId: string; siteId: string }) => void>(() => {})

  const brand = workspace

  useEffect(() => {
    document.title = brand === 'sports' ? 'Sports Dashboard | ZeeOps' : 'Packaging Dashboard | ZeeOps'
    // Swap the TAB icon to the workspace's own mark. Deliberately leaves
    // rel='apple-touch-icon' alone: "Add to Home Screen" reads the live DOM, so
    // removing it here left agents installing the dashboard for task reminders
    // with a blank home-screen icon.
    document.querySelectorAll("link[rel='icon'], link[rel='shortcut icon']").forEach((l) => l.remove())
    const link = document.createElement('link')
    link.rel = 'icon'; link.type = 'image/svg+xml'
    link.href = brand === 'sports' ? FAVICON_SPORTS : FAVICON_PACKAGING
    document.head.appendChild(link)
  }, [brand])

  const [sites, setSites] = useState<Site[]>([])
  const [leads, setLeads] = useState<Lead[]>([])
  // Overview's summary tiles (Total/Today/This Week/by-site/chart) are
  // computed from the SAME merged chat_logs + quote-leads dataset the
  // Billing tab uses (via /api/admin/leads-billing), not the raw `leads`
  // table — that table alone misses chat leads the bot never separately
  // "qualified" into it, and previously produced a different number than
  // Billing's own totals. `leads`/roleLeads below stay as the detailed,
  // browsable Recent Leads list (product/budget/transcript etc.), untouched.
  const [summaryLeads, setSummaryLeads] = useState<BillingLead[]>([])
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  // Global bot kill switch (lib/botflag.ts). Initialised from the code default;
  // every conversations poll refreshes it with the server's view (which also
  // honours a BOT_ENABLED env override the client bundle can't see).
  const [botGlobalOff, setBotGlobalOff] = useState(() => !isBotEnabled())
  // The header wraps to multiple rows on narrow screens, so the Conversations
  // pane must size itself against the MEASURED header height (a fixed 57px
  // pushed the reply box below the fold on phones). dvh (not vh) keeps the
  // composer visible above mobile browser chrome.
  const headerRef = useRef<HTMLDivElement | null>(null)
  const [headerH, setHeaderH] = useState(57)
  useEffect(() => {
    const el = headerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight))
    ro.observe(el)
    setHeaderH(el.offsetHeight)
    return () => ro.disconnect()
  }, [authReady])

  // Overview: clicking a site in "Leads by Site" (or a stat tile) filters the
  // Recent Leads table. Date filter has no 'yesterday' stat tile, so it's a
  // dropdown; 'today'/'week' can also be set by clicking their tiles.
  const [overviewLeadSite, setOverviewLeadSite] = useState('')
  const [overviewLeadDate, setOverviewLeadDate] = useState<'all' | 'today' | 'yesterday' | 'week' | 'month'>('all')
  const [overviewLeadPage, setOverviewLeadPage] = useState(0)
  // Recent Leads mixes two very different kinds of row — a real chat
  // conversation the bot captured, and a quote-request email pulled from
  // Gmail (no chat session at all) — filterable so it's easy to see just one.
  const [overviewLeadType, setOverviewLeadType] = useState<'all' | LeadSource>('all')
  // A Quote-type Recent Lead has no chat session to open — clicking one pops
  // its full details here instead (mirrors the Billing tab's quote modal).
  const [viewOverviewLead, setViewOverviewLead] = useState<Lead | null>(null)
  // Performance tab's Daily performance table: click a day's Chats count to
  // see exactly those sessions, instead of just a number.
  const [viewDayChats, setViewDayChats] = useState<PerfDaily | null>(null)
  // …and click a day's Picked-up count to see which agent took how many.
  const [viewDayAgents, setViewDayAgents] = useState<PerfDaily | null>(null)
  const leadsTableRef = useRef<HTMLDivElement | null>(null)
  const OVERVIEW_LEADS_PER_PAGE = 40
  // Visitors tab (Zendesk-style history of every widget session, last 7 days).
  const [visitorHistory, setVisitorHistory] = useState<HistVisitor[]>([])
  const [visitorHistoryLoaded, setVisitorHistoryLoaded] = useState(false)
  const [blockedIps, setBlockedIps] = useState<string[]>([])
  // Team presence — who's on shift right now (Zendesk-style online list).
  const [teamAgents, setTeamAgents] = useState<{ email: string; online: boolean; lastSeen: string | null }[]>([])
  const [showTeam, setShowTeam] = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [histSiteFilter, setHistSiteFilter] = useState('')
  const [histChatOnly, setHistChatOnly] = useState(false)
  const [histStatusFilter, setHistStatusFilter] = useState<'all' | 'live' | 'left'>('all')
  const [histCountryFilter, setHistCountryFilter] = useState('')
  const [histDeviceFilter, setHistDeviceFilter] = useState('')
  const [histSearch, setHistSearch] = useState('')
  const [histHotOnly, setHistHotOnly] = useState(false)
  const [expandedVisitor, setExpandedVisitor] = useState<string | null>(null)
  const [histPage, setHistPage] = useState(0)
  // Any filter change goes back to page 1.
  const setHistFilter = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setHistPage(0) }
  const [selectedSession, setSelectedSession] = useState<Session | null>(null)

  // ── Browser history integration ─────────────────────────────────────────────
  // Every tab switch / conversation open pushes a URL (?tab=…&session=…), so
  // the browser Back button walks back through the dashboard (e.g. lead →
  // Back → Billing) instead of leaving the app, and any conversation can be
  // opened in a new tab via a real link.
  useEffect(() => {
    if (!authReady || !tabRestored.current) return
    if (applyingHistory.current) { applyingHistory.current = false; return }
    const url = tab === 'conversations' && selectedSession
      ? `/?tab=conversations&session=${encodeURIComponent(selectedSession.session_id)}&site=${encodeURIComponent(selectedSession.site_id)}`
      : `/?tab=${tab}`
    if (`${window.location.pathname}${window.location.search}` === url) return
    if (historySynced.current) window.history.pushState(null, '', url)
    else { window.history.replaceState(null, '', url); historySynced.current = true }
  }, [tab, selectedSession, authReady])
  useEffect(() => {
    const onPop = () => {
      applyingHistory.current = true
      const p = new URLSearchParams(window.location.search)
      const t = p.get('tab')
      const sess = p.get('session')
      const site = p.get('site')
      if (t === 'conversations' && sess && site) {
        openBySessionRef.current({ sessionId: sess, siteId: site })
        return
      }
      setSelectedSession(null)
      if (t === 'overview' || t === 'conversations' || t === 'visitors' || t === 'billing' || t === 'performance') setTab(t)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [visitorTyping, setVisitorTyping] = useState(false)
  const lastAgentTypingPing = useRef(0)
  const [replyText, setReplyText] = useState('')
  const [sending, setSending] = useState(false)
  const [claimingSession, setClaimingSession] = useState(false)
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
  // Session we've already auto-filled contact fields for, so the poll doesn't
  // keep re-filling a field the agent deliberately cleared.
  const [savingContact, setSavingContact] = useState(false)
  const [contactSaved, setContactSaved] = useState(false)
  // Admin-only: manually count this conversation as a lead when the customer
  // clearly became one (e.g. "I emailed you") without ever typing an email
  // into the widget, so the bot's automatic capture never fired.
  const [markingLead, setMarkingLead] = useState(false)
  // null = idle; 'new' = just counted; 'already' = this conversation was
  // already a lead, so the click changed nothing (worth saying, otherwise a
  // a plain tick looks like it counted a second time).
  const [leadMarked, setLeadMarked] = useState<'new' | 'already' | null>(null)
  const [markLeadError, setMarkLeadError] = useState('')
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
  const [analyticsUnique, setAnalyticsUnique] = useState(0)
  // Billing report (lead-tracked sites). Month string "YYYY-MM"; default current.
  const [billingMonth, setBillingMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [billing, setBilling] = useState<BillingData | null>(null)
  const [billingLoading, setBillingLoading] = useState(false)
  // Billing tab: Chat leads (from the widget) and Quote leads (from labeled
  // Gmail quote-request emails) are different enough — different columns,
  // different "what does this mean" — that mixing them in one table read as
  // confusing. Split into two switchable views on the same page.
  const [billingLeadType, setBillingLeadType] = useState<'chat' | 'quote' | 'checkout'>('chat')
  // Click a site in the "By site" breakdown to filter the table below to
  // just that site — null means "all sites" (the default).
  const [billingSiteFilter, setBillingSiteFilter] = useState<string | null>(null)
  // Deleting a quote lead (e.g. bot-spam form submissions) is admin-only — see
  // deleteQuoteLead below and the matching server-side check in
  // /api/admin/delete-lead, which requires admin for anything QUOTE_TAG'd
  // regardless of site access, unlike regular leads where a standard member
  // with site access can also delete.
  const [confirmQuoteDeleteId, setConfirmQuoteDeleteId] = useState<string | null>(null)
  const [deletingQuoteId, setDeletingQuoteId] = useState<string | null>(null)
  // Quote leads have no chat session to open, so clicking a row instead pops
  // the full original email text in a modal (the table only shows a
  // truncated preview).
  const [viewQuote, setViewQuote] = useState<BillingLead | null>(null)
  // Agent performance report (admin-only). Month string "YYYY-MM"; default current.
  const [perfMonth, setPerfMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [perf, setPerf] = useState<PerfData | null>(null)
  const [attendance, setAttendance] = useState<{ date: string; email: string; first: string | null; last: string | null; secs: number }[]>([])
  const [perfLoading, setPerfLoading] = useState(false)
  const prevVisitorIds = useRef<Set<string>>(new Set())
  const visitorsSeeded = useRef(false)
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

  // Dark mode, persisted; default light. Applied as a class on <html> which
  // globals.css remaps the light utilities under.
  const [darkMode, setDarkMode] = useState(false)
  useEffect(() => {
    const dark = localStorage.getItem('zee-dash-theme') === 'dark'
    setDarkMode(dark)
    document.documentElement.classList.toggle('dark', dark)
  }, [])
  const toggleTheme = useCallback(() => {
    setDarkMode((d) => {
      const next = !d
      try { localStorage.setItem('zee-dash-theme', next ? 'dark' : 'light') } catch { /* ignore */ }
      document.documentElement.classList.toggle('dark', next)
      return next
    })
  }, [])

  // Web Push: 'unsupported' | 'off' | 'on'. Subscribing needs a user gesture
  // (required on iOS), so it's driven by the header push button.
  const [pushState, setPushState] = useState<'unsupported' | 'off' | 'on'>('unsupported')
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    navigator.serviceWorker.ready.then(async (reg) => {
      const sub = await reg.pushManager.getSubscription()
      setPushState(sub ? 'on' : 'off')
    }).catch(() => setPushState('off'))
  }, [])
  const togglePush = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      if (existing) {
        await fetch('/api/admin/push-subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remove: true, endpoint: existing.endpoint }),
        }).catch(() => {})
        await existing.unsubscribe()
        setPushState('off')
        return
      }
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') { alert('Notifications are blocked for this site — allow them in your browser settings to get chat alerts.'); return }
      const { publicKey } = await fetch('/api/admin/push-subscribe').then((r) => r.json())
      if (!publicKey) { alert('Push is not configured on the server.'); return }
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey })
      await fetch('/api/admin/push-subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), deviceId: pushDeviceId() }),
      })
      setPushState('on')
    } catch (err) {
      console.error('push subscribe failed:', err)
      alert('Could not enable notifications on this device. On iPhone, install the app to your Home Screen first (Share → Add to Home Screen), then enable from inside the app.')
    }
  }, [])

  // Sound on/off, persisted; default ON. Read lazily so SSR doesn't touch window.
  const [soundOn, setSoundOn] = useState(true)
  // Whether that read has happened yet. Until it has, `soundOn` is the default
  // rather than the agent's actual choice, and mirroring it to the service
  // worker would briefly un-mute a muted dashboard.
  const [soundHydrated, setSoundHydrated] = useState(false)
  useEffect(() => {
    try { if (localStorage.getItem('zee-dash-sound') === 'off') setSoundOn(false) } catch { /* ignore */ }
    setSoundHydrated(true)
  }, [])

  // THE SWITCH HAS TO REACH THE SERVICE WORKER, not just this page.
  // Everything the page itself plays goes through playDashSound, which honours
  // `soundOn`. Push notifications do not: sw.js draws them and the OS plays the
  // sound, outside the tab entirely — which is why muting the tab in Chrome
  // left the dinging untouched. A worker cannot read localStorage, so the value
  // is posted across on every change (and on load, so a worker that was killed
  // and respawned is re-told). See public/sw.js.
  useEffect(() => {
    if (!soundHydrated || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.ready
      .then((reg) => { (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type: 'zee-sound', on: soundOn }) })
      .catch(() => { /* no worker (unsupported / blocked) — nothing to mirror */ })
  }, [soundOn, soundHydrated])
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
      master.gain.value = 0.9
      const shaper = ctx.createWaveShaper()
      const curve = new Float32Array(1024)
      for (let c = 0; c < 1024; c++) {
        const x = (c / 1023) * 2 - 1
        curve[c] = Math.tanh(x * 1.1) // gentler saturation = warm, not harsh
      }
      shaper.curve = curve
      master.connect(shaper); shaper.connect(ctx.destination)

      // Warm, pleasant three-note rising bell (C6→E6→G6) — sine body + a soft
      // triangle overtone, no bright sawtooth. Still cuts through a room, but easy
      // on the ear and repeatable.
      ;[[1047, 0], [1319, 0.14], [1568, 0.28]].forEach(([freq, delay]) => {
        const t = ctx.currentTime + delay
        ;([['sine', freq, 0.95], ['triangle', freq * 2, 0.18]] as [OscillatorType, number, number][]).forEach(([type, f, peak]) => {
          const osc = ctx.createOscillator(); const gain = ctx.createGain()
          osc.connect(gain); gain.connect(master)
          osc.type = type; osc.frequency.value = f
          gain.gain.setValueAtTime(0, t)
          gain.gain.linearRampToValueAtTime(peak, t + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6)
          osc.start(t); osc.stop(t + 0.65)
        })
      })
    } catch { /* ignore */ }
  }, [soundOn, getDashCtx])

  // Re-chime while anything needs a human (see WAITING_REPEAT_MS): a chat whose
  // latest message is the visitor's, OR a live visitor nobody has engaged yet.
  // "Engaged" = the last message in their session is an agent's — so ringing
  // stops when an agent replies (or proactively messages a browsing visitor),
  // resumes when the visitor speaks again, and ends when the visitor leaves the
  // site (they drop off the live list). State is read through refs so the
  // repeat cadence never resets on the poll updates; playDashSound honours the
  // mute toggle.
  const sessionsRef = useRef<Session[]>([])
  const visitorsRef = useRef<Visitor[]>([])
  const visibleTick = useVisibleTick()
  const userSitesRef = useRef<string[]>([])
  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  useEffect(() => { visitorsRef.current = visitors }, [visitors])
  useEffect(() => { userSitesRef.current = userSites }, [userSites])
  useEffect(() => {
    const iv = setInterval(() => {
      const scope = new Set(userSitesRef.current)
      const now = Date.now()
      const waitingChat = sessionsRef.current.some((s) =>
        s.last_role === 'user' && scope.has(s.site_id) &&
        !(s.mode === 'human' && isClosingMessage(s.preview)) &&
        !!s.last_at && now - new Date(s.last_at).getTime() < WAITING_FRESH_MS)
      const lastRoleBySession = new Map(sessionsRef.current.map((s) => [s.session_id, s.last_role]))
      const unengagedVisitor = visitorsRef.current.some((v) => {
        if (!scope.has(v.site_id)) return false
        // Same staleness cap the live list uses — a carried-over old session
        // pinging from a forgotten tab must not ring.
        const created = asUtcIso(v.created_at)
        if (created && now - new Date(created).getTime() > LIVE_MAX_ON_SITE_MS) return false
        return lastRoleBySession.get(v.session_id) !== 'admin'
      })
      if (waitingChat || unengagedVisitor) playDashSound()
    }, WAITING_REPEAT_MS)
    return () => clearInterval(iv)
  }, [playDashSound])

  useEffect(() => {
    // Refetches every time the Overview tab is (re)opened, not just once on
    // first mount — this data used to only ever load once for the whole
    // session, so a tab left open since morning would silently keep showing
    // that morning's counts (found via a real report: "Today's Leads" was
    // stuck one lead behind after a new one arrived later in the day).
    if (tab !== 'overview' || !authReady) return
    // Same tracking-start floor as /api/admin/leads-list's TRACKING_START —
    // quote leads reach back to 2024 (whenever Gmail labeling started), long
    // before the bot went live, and shouldn't count toward Overview totals.
    const trackingStart = '2026-06-01T00:00:00Z'
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    Promise.all([
      fetch('/api/admin/sites').then((r) => r.json()).catch(() => ({ sites: [] })),
      fetch('/api/admin/leads-list').then((r) => r.json()).catch(() => ({ leads: [] })),
      fetch(`/api/admin/leads-billing?from=${encodeURIComponent(trackingStart)}&to=${encodeURIComponent(tomorrow)}`)
        .then((r) => r.json()).catch(() => ({ leads: [] })),
    ]).then(([s, l, b]) => { setSites(s.sites ?? []); setLeads(l.leads ?? []); setSummaryLeads(b.leads ?? []); setOverviewLoading(false) })
  }, [tab, authReady])

  // Analytics (visitors + chats over time), scoped server-side to the workspace.
  // Cached per range: switching Hourly/Daily/Weekly/Monthly shows the cached
  // series instantly and refreshes it in the background.
  const analyticsCache = useRef<Record<string, { points: AnalyticsPoint[]; totalUnique: number }>>({})
  useEffect(() => {
    if (tab !== 'overview' || !authReady) return
    const range = analyticsRange
    const cached = analyticsCache.current[range]
    if (cached) { setAnalytics(cached.points); setAnalyticsUnique(cached.totalUnique) }
    fetch(`/api/admin/analytics?range=${range}`)
      .then((r) => r.json()).catch(() => ({ points: [] }))
      .then((d) => {
        const entry = { points: d.points ?? [], totalUnique: d.totalUnique ?? 0 }
        analyticsCache.current[range] = entry
        setAnalytics(entry.points)
        setAnalyticsUnique(entry.totalUnique)
      })
  }, [tab, authReady, analyticsRange])

  // Billing leads for the selected month, scoped server-side to the member.
  useEffect(() => {
    if (tab !== 'billing' || !authReady) return
    const [y, m] = billingMonth.split('-').map(Number)
    if (!y || !m) return
    // Explicit Pakistan-time month boundary (+05:00), not the browser's local
    // timezone — a lead captured just after midnight PKT on the 1st must land
    // in THIS month, matching how every date on screen is displayed.
    const pad = (n: number) => String(n).padStart(2, '0')
    const from = new Date(`${y}-${pad(m)}-01T00:00:00+05:00`).toISOString()
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const to = new Date(`${nextY}-${pad(nextM)}-01T00:00:00+05:00`).toISOString()
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
    // Explicit Pakistan-time month boundary — see the matching Billing fetch.
    const pad = (n: number) => String(n).padStart(2, '0')
    const from = new Date(`${y}-${pad(m)}-01T00:00:00+05:00`).toISOString()
    const nextY = m === 12 ? y + 1 : y
    const nextM = m === 12 ? 1 : m + 1
    const to = new Date(`${nextY}-${pad(nextM)}-01T00:00:00+05:00`).toISOString()
    setPerfLoading(true)
    fetch(`/api/admin/performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((d) => { setPerf(d); setPerfLoading(false) })
    fetch(`/api/admin/attendance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => (r.ok ? r.json() : { days: [] })).catch(() => ({ days: [] }))
      .then((d) => setAttendance(d.days ?? []))
  }, [tab, authReady, perfMonth])

  // Duty-hours heartbeat: while the dashboard is open, tell the server this
  // member is online (once a minute) — feeds the attendance register.
  useEffect(() => {
    if (!authReady) return
    const beat = () => fetch('/api/admin/presence', { method: 'POST' }).catch(() => {})
    beat()
    const iv = setInterval(beat, 60000)
    return () => clearInterval(iv)
  }, [authReady])

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
    // Keep the OPEN conversation's assignment + mode in sync with the poll, so
    // when another agent claims/releases the chat you're viewing, your header
    // and the reply-box lock update within one poll (without this, selectedSession
    // kept its stale open-time assignment and never locked).
    setSelectedSession((cur) => {
      if (!cur) return cur
      const fresh = incoming.find((s) => s.session_id === cur.session_id)
      if (!fresh) return cur
      const nextAssigned = fresh.assignedTo ?? null
      if (cur.assignedTo === nextAssigned && cur.mode === fresh.mode) return cur
      return { ...cur, assignedTo: nextAssigned, mode: fresh.mode }
    })
    setSessionsLoaded(true)
    if (typeof data.bot_enabled === 'boolean') setBotGlobalOff(!data.bot_enabled)
  }, [playDashSound])

  // Poll sessions whenever signed in (not only on the Conversations tab) so the
  // new-visitor-message alert fires even while the agent is on Overview.
  useEffect(() => {
    if (!authReady) return
    fetchSessions()
    const iv = setInterval(whenVisible(fetchSessions), 13000)
    return () => clearInterval(iv)
  }, [authReady, fetchSessions, visibleTick])

  // Tasks badge: this member's overdue + due-today count, in Pakistan time.
  // Polled at 60s — far slower than the visitor/conversation polls on purpose.
  // A due-date badge does not need to be second-accurate, and chat_logs has no
  // index on `role`, so this query must stay cheap (CLAUDE.md §6).
  useEffect(() => {
    if (!authReady) return
    const pull = () => fetch('/api/tasks/count')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setTaskBadge(typeof d.count === 'number' ? d.count : 0)
        setTaskBadgeOverdue(typeof d.overdue === 'number' ? d.overdue : 0)
        setUnreadReplies(typeof d.unreadReplies === 'number' ? d.unreadReplies : 0)
      })
      .catch(() => {})
    pull()
    const iv = setInterval(whenVisible(pull), 60000)
    return () => clearInterval(iv)
  }, [authReady, visibleTick])

  // Load the IP blocklist once for admins, so the "Ban / Unban" state is correct
  // on the conversation panel too (not just the Visitors tab).
  useEffect(() => {
    if (!authReady || userRole !== 'admin') return
    fetch('/api/admin/block').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.ips) setBlockedIps(d.ips) }).catch(() => {})
  }, [authReady, userRole])

  // Team presence: refresh who's online every 20s while signed in.
  useEffect(() => {
    if (!authReady) return
    const load = () => fetch('/api/admin/presence').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.agents) setTeamAgents(d.agents) }).catch(() => {})
    load()
    const iv = setInterval(whenVisible(load), 20000)
    return () => clearInterval(iv)
  }, [authReady, visibleTick])

  const fetchVisitors = useCallback(async () => {
    const data = await fetch('/api/visitor/active').then((r) => r.json()).catch(() => ({ visitors: [] }))
    const incoming: Visitor[] = data.visitors ?? []
    const incomingIds = new Set(incoming.map((v) => v.session_id))
    // Any BRAND-NEW live visitor gets the full loud chime. (The old inline beep
    // created a fresh AudioContext per beep — browsers keep those suspended, so
    // it was usually silent — and its prev.size>0 guard skipped the 0→1 visitor
    // case entirely.) Seeded silently on the first fetch so a dashboard load
    // doesn't alert for visitors already known.
    if (visitorsSeeded.current && incoming.some((v) => !prevVisitorIds.current.has(v.session_id))) {
      playDashSound()
    }
    visitorsSeeded.current = true
    prevVisitorIds.current = incomingIds
    setVisitors(incoming)
  }, [playDashSound])

  // Poll on EVERY tab (not just Conversations) so visitor alerts always fire.
  useEffect(() => {
    if (!authReady) return
    fetchVisitors()
    const iv = setInterval(whenVisible(fetchVisitors), VISITOR_POLL_MS)
    return () => clearInterval(iv)
  }, [authReady, fetchVisitors, visibleTick])

  // Visitor history: fetched when the Visitors tab opens, refreshed every 30s
  // while it stays open (history is not latency-critical like the live list).
  useEffect(() => {
    if (tab !== 'visitors' || !authReady) return
    const load = async () => {
      const data = await fetch('/api/admin/visitors-history').then((r) => r.json()).catch(() => ({ visitors: [] }))
      setVisitorHistory(data.visitors ?? [])
      setBlockedIps(data.blockedIps ?? [])
      setVisitorHistoryLoaded(true)
    }
    load()
    const iv = setInterval(whenVisible(load), 30000)
    return () => clearInterval(iv)
  }, [tab, authReady, visibleTick])

  const fetchMessages = useCallback(async (sessionId: string) => {
    const data = await fetch(`/api/admin/messages?sessionId=${sessionId}`).then((r) => r.json()).catch(() => ({ messages: [] }))
    const next: ChatMsg[] = data.messages ?? []
    // Skip the state update (and the transcript re-render + scroll work it
    // triggers) when the 3s poll returns the same messages — the common idle
    // case. Keeps an open chat from re-rendering every 3 seconds for nothing.
    setMessages((prev) => {
      if (prev.length === next.length && (prev.length === 0 ||
        (prev[prev.length - 1].id === next[next.length - 1].id &&
         prev[prev.length - 1].message === next[next.length - 1].message))) return prev
      return next
    })
    setVisitorTyping(data.visitorTyping === true)
  }, [])

  // Keyed on the session ID, NOT the whole selectedSession object: assignment
  // updates replace that object (new identity) every poll, and we must not
  // reload/flash the transcript for those — only for a genuine chat switch.
  const selectedSessionId = selectedSession?.session_id
  useEffect(() => {
    if (!selectedSessionId) return
    // Clear immediately so switching chats shows the NEW one loading, not the
    // previous chat's transcript lingering (which read as "my click did nothing"
    // and made agents click repeatedly).
    setMessages([])
    setMessagesLoading(true)
    fetchMessages(selectedSessionId).finally(() => setMessagesLoading(false))
    const iv = setInterval(whenVisible(() => fetchMessages(selectedSessionId)), 3000)
    return () => clearInterval(iv)
  }, [selectedSessionId, fetchMessages])

  // Catch the open conversation up when the tab comes back. Deliberately a
  // separate effect: the two effects above cannot simply take `visibleTick` as a
  // dependency, because their bodies clear the transcript (setMessages([])) and
  // reset per-conversation UI — the translation toggle, the tag input. Re-running
  // them on every focus would blank the chat and undo the agent's own state,
  // which is precisely the flash their comments warn about.
  useEffect(() => {
    if (!visibleTick || !selectedSessionId) return
    fetchMessages(selectedSessionId)
    fetchVisitorDetail(selectedSessionId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTick])

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

  // Keyed on session ID (not the object) so an assignment update — which
  // replaces selectedSession every poll — doesn't reset the contact/tag fields
  // the agent is editing or re-flash the detail spinner. Only a real switch
  // re-seeds and reloads.
  useEffect(() => {
    if (!selectedSessionId) { setVisitorDetail(null); return }
    setContactSaved(false)
    setTags(selectedSession?.tags ?? []); setTagInput('')
    // Translation is per-conversation and off by default.
    setTranslateOn(false); setTranslateOut(false); setMsgAnalysis({})
    fetchVisitorDetail(selectedSessionId, true)
    const iv = setInterval(whenVisible(() => fetchVisitorDetail(selectedSessionId, false)), 20000)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, fetchVisitorDetail])

  // (Contact auto-fill from chat is done server-side in /api/admin/visitor, so
  // the saved-contact seed already arrives pre-filled — no client race here.)

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

  // Counts this conversation as a lead with no contact info attached — the
  // point is the count, not data entry, so it deliberately doesn't read the
  // Contact form above (that's saved separately via "Save contact").
  // Idempotent server-side: a second click reports alreadyMarked rather than
  // double-counting.
  async function markAsLead() {
    if (!selectedSession || markingLead) return
    setMarkingLead(true); setMarkLeadError(''); setLeadMarked(null)
    const res = await fetch('/api/admin/mark-lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id }),
    })
    setMarkingLead(false)
    if (res.ok) {
      const data = await res.json().catch(() => null)
      setLeadMarked(data?.alreadyMarked ? 'already' : 'new')
      setTimeout(() => setLeadMarked(null), 3000)
      // Reflect it immediately in the list so the "lead" filter/chip agrees
      // without waiting for a refetch.
      setTags((prev) => prev.some((t) => t.toLowerCase() === 'lead') ? prev : [...prev, 'lead'])
      setSessions((prev) => prev.map((s) => s.session_id === selectedSession.session_id
        ? { ...s, lead: s.lead ?? { name: null, email: null }, tags: (s.tags ?? []).some((t) => t.toLowerCase() === 'lead') ? s.tags : [...(s.tags ?? []), 'lead'] }
        : s))
    } else {
      const data = await res.json().catch(() => null)
      setMarkLeadError(data?.error || 'Failed to mark as lead.')
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
    const resp = await fetch('/api/admin/reply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, siteId: selectedSession.site_id, message: outgoing }),
    })
    const res = await resp.json().catch(() => null)
    // Locked by another agent (race): don't send. Reflect the real owner so the
    // box locks, and tell the agent to take over.
    if (resp.status === 409) {
      if (res?.assignedTo) applyAssignment(selectedSession.session_id, res.assignedTo)
      setUploadError(`${agentShort(res?.assignedTo)} took this chat — take over to reply.`)
      setSending(false)
      return
    }
    // Replying auto-claims an unassigned chat (server returns the assignee).
    if (res?.assignedTo) applyAssignment(selectedSession.session_id, res.assignedTo)
    setReplyText('')
    await fetchMessages(selectedSession.session_id)
    setSending(false)
  }

  // Reflect a new assignee across both the list and the open conversation, so
  // every card and the header update instantly without waiting for the poll.
  const applyAssignment = useCallback((sessionId: string, email: string | null) => {
    setSessions((prev) => prev.map((s) => s.session_id === sessionId ? { ...s, assignedTo: email } : s))
    setSelectedSession((s) => s && s.session_id === sessionId ? { ...s, assignedTo: email } : s)
  }, [])

  // "Assign to me" / "Release" from the conversation header.
  async function claimSession(claim: boolean) {
    if (!selectedSession || claimingSession) return
    setClaimingSession(true)
    const optimistic = claim ? userEmail : null
    applyAssignment(selectedSession.session_id, optimistic)
    const res = await fetch('/api/admin/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.session_id, siteId: selectedSession.site_id, action: claim ? 'claim' : 'release' }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    // Reconcile with the server's authoritative answer (e.g. a release that was
    // refused because someone else holds the chat).
    if (res) applyAssignment(selectedSession.session_id, res.assignedTo ?? null)
    setClaimingSession(false)
  }

  // Close a chat tab: release (unassign) that specific session so it leaves this
  // agent's tab bar and returns to the unassigned pool. If it's the open chat,
  // deselect it too. Works on any session, not just the selected one.
  async function closeChatTab(sessionId: string, siteId: string) {
    applyAssignment(sessionId, null) // optimistic
    if (selectedSession?.session_id === sessionId) setSelectedSession(null)
    const res = await fetch('/api/admin/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, siteId, action: 'release' }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (res) applyAssignment(sessionId, res.assignedTo ?? null)
  }

  // Auto-pick-up: opening a chat that nobody holds assigns it to you, so the
  // moment you start reading it every other agent sees it's being handled.
  // Claim (lock) an unassigned chat the moment this agent ENGAGES with it (starts
  // typing / sends). Merely opening a chat does NOT claim it, so other agents can
  // still view it. Never steals an already-assigned chat — the server's
  // onlyIfFree guard keeps ownership put, and we reconcile to what it reports.
  const claimIfFree = useCallback(async (session: Session) => {
    if (session.assignedTo) return // already owned (by anyone) — leave it
    applyAssignment(session.session_id, userEmail) // optimistic "You" (also guards repeat keystrokes)
    const res = await fetch('/api/admin/assign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.session_id, siteId: session.site_id, action: 'claim', onlyIfFree: true }),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (res) applyAssignment(session.session_id, res.assignedTo ?? null)
  }, [applyAssignment, userEmail])

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
      .then((r) => r.json().then((d) => ({ ok: r.ok, status: r.status, d }))).catch(() => ({ ok: false, status: 0, d: null }))
    setUploadingFile(false)
    if (res.status === 409) { // locked by another agent
      if (res.d?.assignedTo) applyAssignment(selectedSession.session_id, res.d.assignedTo)
      setUploadError(`${agentShort(res.d?.assignedTo)} is handling this chat — take over to send.`)
      return
    }
    if (!res.ok) { setUploadError(res.d?.error || 'Upload failed'); return }
    setSelectedSession((s) => s ? { ...s, mode: 'human' } : s)
    setSessions((prev) => prev.map((s) => s.session_id === selectedSession.session_id ? { ...s, mode: 'human' } : s))
    await fetchMessages(selectedSession.session_id)
  }

  async function openVisitorSession(visitor: Visitor) {
    // Prefer the already-loaded session (carries real mode/assignedTo/lead) so
    // the header reflects the true assignment instead of a blank synthetic one.
    const existing = sessions.find((s) => s.session_id === visitor.session_id)
    const session: Session = existing ?? {
      session_id: visitor.session_id, site_id: visitor.site_id,
      site_name: visitor.site_name, preview: visitor.page_url ?? '',
      last_at: visitor.last_seen, message_count: 0, mode: 'bot', lead: null,
    }
    setSelectedSession(session)
    if (!existing) setSessions((prev) => [session, ...prev])
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
  // Keep the popstate handler pointed at the latest closure (it's bound once).
  openBySessionRef.current = openConversationBySession

  // Real link target for a conversation — lets rows be middle/right-clicked
  // into a new tab, and gives pushState a canonical URL shape.
  const conversationHref = (sessionId: string, siteId: string) =>
    `/?tab=conversations&session=${encodeURIComponent(sessionId)}&site=${encodeURIComponent(siteId)}`

  // ── CRM record page (app/leads/[id]) ───────────────────────────────────────
  // Relative on purpose: the dashboard may later be served from a second
  // domain alias, and every link has to keep working under that origin.
  const leadRecordHref = (recordId: string) => `/leads/${encodeURIComponent(recordId)}`
  // Opening a lead is a REAL browser navigation, not a client-side route swap.
  // router.push() only moves the URL and then asks the current bundle to render
  // the new segment — so if this tab is running an older build (a dashboard left
  // open across a deploy) or an extension has mutated the DOM out from under
  // React, the URL changes and nothing else happens, with no error anywhere.
  // A full navigation cannot fail silently: the browser either lands on the
  // record or shows its own error. The record page is a separate heavy route,
  // so there is nothing to gain from a soft transition here anyway.
  const openLeadRecord = (recordId: string) => { window.location.assign(leadRecordHref(recordId)) }
  // Nav links keep the soft transition — Pipeline and Tasks are lighter routes
  // and router.push() is measurably quicker — but they get the same guarantee
  // as openLeadRecord: a link must never silently do nothing. If the URL has
  // not moved shortly after the push, the soft navigation did not happen (the
  // stale-bundle failure above) and we fall back to a full load, which cannot
  // fail quietly. The check is deliberately late and only fires while we are
  // still on the dashboard, so a merely slow RSC fetch is never double-handled.
  const navigateTo = (href: string) => {
    router.push(href)
    window.setTimeout(() => {
      if (window.location.pathname === '/') window.location.assign(href)
    }, 1500)
  }
  // A record is keyed by the conversation id where there is one; leads that
  // arrived by email use the same synthetic `quote-<leadId>` id the Billing
  // tab already gives them.
  const leadRecordId = (lead: Lead) => lead.session_id || `quote-${lead.id}`

  // Block / unblock a visitor IP (admin only); optimistic UI update.
  async function toggleIpBlock(ip: string, block: boolean) {
    setBlockedIps((prev) => block ? Array.from(new Set([...prev, ip])).sort() : prev.filter((x) => x !== ip))
    setVisitorHistory((prev) => prev.map((v) => v.ip === ip ? { ...v, ip_blocked: block } : v))
    await fetch('/api/admin/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, block }),
    }).catch(() => {})
  }

  function openConversation(lead: BillingLead) {
    openConversationBySession({ sessionId: lead.session_id, siteId: lead.site_id, siteName: lead.site_name, preview: lead.email ?? 'Marked as lead', lastAt: lead.captured_at })
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

  // Set a lead's pipeline status: optimistic update, then persist.
  async function setLeadStatus(lead: BillingLead, status: LeadStatus) {
    setBilling((prev) => {
      if (!prev) return prev
      const leads = prev.leads.map((l) => l.session_id === lead.session_id ? { ...l, status } : l)
      const byStatus: Record<string, number> = {}
      for (const l of leads) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1
      return { ...prev, leads, byStatus }
    })
    await fetch('/api/admin/lead-status', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: lead.session_id, siteId: lead.site_id, status }),
    }).catch(() => {})
  }

  // Remove a quote lead (e.g. a bot-spam form submission that slipped
  // through) straight from the Billing tab — admin-only, gated both here
  // (button only renders for userRole === 'admin') and on the server.
  async function deleteQuoteLead(sessionId: string) {
    const id = sessionId.replace(/^quote-/, '')
    setDeletingQuoteId(sessionId)
    await fetch('/api/admin/delete-lead', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    setBilling((prev) => {
      if (!prev) return prev
      const leads = prev.leads.filter((l) => l.session_id !== sessionId)
      const byStatus: Record<string, number> = {}
      for (const l of leads) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1
      return { ...prev, leads, total: leads.length, byStatus }
    })
    setConfirmQuoteDeleteId(null); setDeletingQuoteId(null)
  }

  // Export the current billing list as CSV for the client invoice.
  function downloadBillingCsv() {
    if (!billing) return
    const esc = (v: string | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const header = ['Type', 'Email', 'Name', 'Phone', 'Site', 'Status', 'Agent', 'Country', 'Origin', 'Date Captured']
    const rows = billing.leads.map((l) => [
      esc(l.source === 'quote' ? 'Custom Quote' : l.source === 'checkout' ? 'Checkout' : 'Chat'), esc(l.email ?? (l.manual ? 'Marked as lead (no contact info)' : '')), esc(l.name), esc(l.phone), esc(l.site_name),
      esc(l.status), esc(l.agent), esc(l.country), esc(cleanReferrer(l.referrer)),
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
  // Overview's summary tiles use summaryLeads (chat_logs + quote leads, same
  // as Billing) instead of the raw `leads` table — that table missed chat
  // leads the bot never separately "qualified" into it. This is the RAW
  // total (no cross-channel dedup), matching Billing's own "Total leads this
  // period" tile — a customer who shows up in both chat and quote is still
  // two rows here, same as it is in Billing's total. The deduped "one
  // customer, bill once" number lives only on the Billing tab's dedicated
  // "Billable Leads" card, not here.
  const overviewSummaryLeads = summaryLeads.filter((l) => inScope(l.site_id))
  const roleSessions = sessions.filter((s) => inScope(s.site_id))
  // Assignee email per session, from the polled conversations. Lets the live-
  // visitor cards (whose data comes from a separate presence feed) show who has
  // picked up a chat, keyed by the shared session_id.
  const assignmentBySession: Record<string, string> = {}
  for (const s of sessions) if (s.assignedTo) assignmentBySession[s.session_id] = s.assignedTo
  // Only count a visitor as "live" if their session is recent. A multi-hour
  // on-site time means a stale/carried-over session (e.g. an old open tab still
  // pinging) — never show those as live, mirroring the server cap.
  const roleVisitors = visitors.filter((v) => {
    if (!inScope(v.site_id)) return false
    const created = asUtcIso(v.created_at)
    if (created && Date.now() - new Date(created).getTime() > LIVE_MAX_ON_SITE_MS) return false
    return true
  }).sort((a, b) => {
    // STABLE order by first-seen (created_at), tie-broken by session_id. A
    // visitor's created_at never changes, so cards keep a fixed position instead
    // of jumping every poll (the server orders by last_seen, which shuffles as
    // visitors ping). This is what makes a card clickable without it moving out
    // from under the cursor mid-click.
    const ca = asUtcIso(a.created_at) ?? a.created_at ?? ''
    const cb = asUtcIso(b.created_at) ?? b.created_at ?? ''
    if (ca !== cb) return ca < cb ? -1 : 1
    return a.session_id < b.session_id ? -1 : 1
  })
  // Show the Billing tab only when the member can access a lead-tracked site.
  const hasTrackedSite = userSites.some((id) => LEAD_TRACKED_SITES.includes(id))
  // The product is a chat inbox, a pipeline, tasks and email now, so the old
  // "Chat Widget" undersold it. Confirmed with the user before changing.
  // The product's name. Do not change it without asking — it was renamed to
  // "ZeeOps Desk" in a5f0f8c on the strength of a confirmation the user says
  // they never gave, and restored here.
  const dashTitle = 'ZeeOps Chat Widget'
  const accentColor = brand === 'sports' ? '#16a34a' : '#2563eb'

  // Effective bot state for the open conversation. The packaging schedule can put
  // the bot OFF even when the conversation's stored mode is still 'bot', so the
  // header/reply UI must reflect that the bot won't actually reply right now —
  // matching /api/chat. Sports is never schedule-gated. (Recomputed each render,
  // which happens on every poll, so it flips within seconds of a window boundary.)
  const scheduledBotOff = !!selectedSession && isBotOffBySchedule(selectedSession.site_id)
  const botEffectivelyActive = !botGlobalOff && !!selectedSession && selectedSession.mode === 'bot' && !scheduledBotOff
  // Hard lock: this chat belongs to ANOTHER agent — this agent may view it but
  // not message (reply + file are blocked) until they "Take over" or the owner
  // releases it. Enforced on the server too (reply/upload return 409).
  const lockedByOther = !!selectedSession?.assignedTo && selectedSession.assignedTo !== userEmail

  // ── Stats derived ──────────────────────────────────────────────────────────
  // Every timestamp in this app is DISPLAYED in Pakistan time (formatDateTime),
  // but a plain `new Date().toISOString().split('T')[0]` for "today" is a UTC
  // calendar date — PKT is 5h ahead, so anything captured before ~5am PKT is
  // still "yesterday" in UTC. That mismatch made a lead showing "Jul 17, 12:21
  // AM" on screen silently drop out of "Today's Leads" (found via a real
  // report: 6 leads visibly dated Jul 17, only 2 counted as "today"). Bucket
  // by PKT day everywhere here, matching the Performance tab's own PKT_DAY_MS
  // approach, so "today" means the same thing as what's on screen.
  //
  // asUtcIso is essential here, not optional: several of these timestamps
  // come straight from a Postgres "timestamp without time zone" column (no
  // trailing Z), which `new Date(...)` parses as the BROWSER's OWN local
  // time, not UTC. On a browser already set to PKT that silently double-
  // applies the +5h shift below, landing one day early for anything after
  // ~7pm PKT — a second, compounding bug found the same way as the first.
  const PKT_OFFSET_MS = 5 * 60 * 60 * 1000
  const pktDateStr = (iso: string | null | undefined) => {
    const utc = asUtcIso(iso)
    return utc ? new Date(new Date(utc).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10) : ''
  }
  const nowPkt = new Date(Date.now() + PKT_OFFSET_MS)
  const todayStr = nowPkt.toISOString().slice(0, 10)
  const yesterdayPktDate = new Date(nowPkt); yesterdayPktDate.setUTCDate(yesterdayPktDate.getUTCDate() - 1)
  const yesterdayStr = yesterdayPktDate.toISOString().slice(0, 10)
  const dowPkt = nowPkt.getUTCDay()
  const startOfWeekPktDate = new Date(nowPkt); startOfWeekPktDate.setUTCDate(startOfWeekPktDate.getUTCDate() - (dowPkt === 0 ? 6 : dowPkt - 1))
  const startOfWeekStr = startOfWeekPktDate.toISOString().slice(0, 10)
  const startOfMonthStr = `${nowPkt.getUTCFullYear()}-${String(nowPkt.getUTCMonth() + 1).padStart(2, '0')}-01`
  const todayLeads = overviewSummaryLeads.filter(l => pktDateStr(l.captured_at) === todayStr).length
  const thisWeekLeads = overviewSummaryLeads.filter(l => pktDateStr(l.captured_at) >= startOfWeekStr).length

  // Recent Leads table: site chip (from "Leads by Site") + date range, combined.
  const dateFilteredLeads = roleLeads.filter((l) => {
    if (!l.created_at) return overviewLeadDate === 'all'
    const day = pktDateStr(l.created_at)
    if (overviewLeadDate === 'today') return day === todayStr
    if (overviewLeadDate === 'yesterday') return day === yesterdayStr
    if (overviewLeadDate === 'week') return day >= startOfWeekStr
    if (overviewLeadDate === 'month') return day >= startOfMonthStr
    return true
  })
  const siteFilteredLeads = overviewLeadSite ? dateFilteredLeads.filter((l) => l.site_id === overviewLeadSite) : dateFilteredLeads
  const overviewFilteredLeads = overviewLeadType === 'all' ? siteFilteredLeads
    : siteFilteredLeads.filter((l) => leadSource(l.message) === overviewLeadType)
  const overviewLeadPageCount = Math.max(1, Math.ceil(overviewFilteredLeads.length / OVERVIEW_LEADS_PER_PAGE))
  const overviewLeadPageClamped = Math.min(overviewLeadPage, overviewLeadPageCount - 1)
  const overviewLeadsPageRows = overviewFilteredLeads.slice(
    overviewLeadPageClamped * OVERVIEW_LEADS_PER_PAGE, (overviewLeadPageClamped + 1) * OVERVIEW_LEADS_PER_PAGE)

  // ── Bar chart: leads per day last 7 days (PKT days, matching todayStr above) ──
  const chartDays = useMemo(() => {
    const base = new Date(Date.now() + PKT_OFFSET_MS)
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base); d.setUTCDate(d.getUTCDate() - (6 - i))
      const key = d.toISOString().slice(0, 10)
      return { key, label: d.toLocaleDateString('en', { weekday: 'short', timeZone: 'UTC' }), count: 0 }
    }).map(day => ({ ...day, count: overviewSummaryLeads.filter(l => pktDateStr(l.captured_at) === day.key).length }))
  }, [overviewSummaryLeads])
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
      <div className="min-h-screen bg-gray-100 flex items-center justify-center gap-3 text-gray-500 text-sm">
        <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-300 rounded-full animate-spin" />
        Loading dashboard…
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-gray-100 text-gray-900">

      {/* ── Header ────────────────────────────────────────────────────────────
          Three bands, in order of how much authority each carries:

            1. BRAND    — logo and a short label. Identity (email, role) lives in
                          the account menu now; the user knows who they are.
            2. NAV      — the primary control, one segmented group.
            3. CONTROLS — bot state, search, then utilities that recede, then the
                          account menu. Members and Sign out are account-level
                          and belong together behind it, not loose in the bar.

          Everything sits on one row from `lg` up. Below that the nav takes its
          own full-width row (`order-last w-full`) — the SAME element, re-laid
          out, so there is only ever one Pipeline link in the DOM.

          Nothing here may change size after first paint: every count is
          reserved at a fixed width and merely hidden until it has a value, and
          the active tab is a background change only — no border, no extra
          padding — so selecting a tab cannot re-flow the row. See CLAUDE.md. */}
      <div ref={headerRef} className="border-b border-gray-200 bg-white/95 backdrop-blur px-3 sm:px-5 py-2 sm:py-2.5 flex items-center flex-wrap gap-x-2 xl:gap-x-3 sticky top-0 z-10">

        {/* ── 1. Brand ── */}
        <button onClick={() => setTab('overview')} title="Go to Overview"
          className="flex items-center gap-2.5 shrink-0 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 group cursor-pointer">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-md transition-transform group-hover:scale-105" style={{ backgroundColor: accentColor }}>
            <svg viewBox="0 0 24 24" className="w-4.5 h-4.5 fill-white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          {/* Shown from `sm` up, not just `xl`. Hiding it left the logo alone
              against a wide empty gap, and a bare mark does not tell someone
              looking at the screen what they are looking at. Only a phone,
              where the gap does not exist, falls back to the mark alone. */}
          <span className="hidden sm:block text-sm font-bold text-gray-900 whitespace-nowrap group-hover:text-gray-700">{dashTitle}</span>
          <span className="sm:hidden sr-only">{dashTitle}</span>
        </button>

        {/* ── 2. Primary navigation ──
            One element, two layouts: an equal-width grid on a phone, a
            segmented row from `lg` up. A phone gets a tidy block of same-sized
            targets rather than a ragged wrap, and every entry stays one tap
            away — which a "More" menu or a horizontal scroller would both cost.
            Pipeline and Tasks are routes, not tabs, so they keep real hrefs and
            can be middle-clicked into their own window. */}
        <nav aria-label="Sections"
          className="order-last w-full mt-1.5 grid grid-cols-4 gap-1 sm:flex sm:flex-wrap sm:gap-0.5 xl:order-none xl:mt-0 xl:w-auto xl:flex-nowrap bg-gray-100 p-1 pt-2.5 sm:pt-1 rounded-xl border border-gray-200 min-w-0">
          <button onClick={() => setTab('overview')} className={`${NAV_TAB} ${tab === 'overview' ? NAV_TAB_ON : NAV_TAB_OFF}`}>Overview</button>
          <button onClick={() => setTab('conversations')} className={`${NAV_TAB} ${tab === 'conversations' ? NAV_TAB_ON : NAV_TAB_OFF}`}>
            <span className="truncate">Chats</span>
            {/* Always present, and merely muted at zero. Hiding it would be
                tidier for about a second and then the count would arrive, widen
                this strip and move every tab to its right — a click already
                aimed at one of them then lands somewhere else. Reserving the
                space invisibly fixes that but leaves a conspicuous hole, which
                is what made the spacing here look wrong in the first place. A
                grey zero costs nothing and says something true. tabular-nums
                and a min-width keep 1, 2 and 3 digits the same width. */}
            <span className={`${NAV_COUNT} ${roleSessions.length > 0 ? 'bg-blue-600 text-white' : 'hidden sm:inline-block bg-gray-200 text-gray-500'}`}>{roleSessions.length > 999 ? '999+' : roleSessions.length}</span>
          </button>
          <button onClick={() => setTab('visitors')} className={`${NAV_TAB} ${tab === 'visitors' ? NAV_TAB_ON : NAV_TAB_OFF}`}
            title={`${roleVisitors.length} visitor${roleVisitors.length === 1 ? '' : 's'} on your sites right now`}>
            <span className="truncate">Visitors</span>
            {/* A dot carries "live" in a fraction of the width the word did —
                the old "N live" pill was half again as wide as any other tab and
                was most of why the spacing round here read as uneven. */}
            <span className={`${NAV_COUNT} !min-w-[2.5rem] items-center justify-center gap-1 ${roleVisitors.length > 0 ? 'inline-flex bg-green-600 text-white' : 'hidden sm:inline-flex bg-gray-200 text-gray-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${roleVisitors.length > 0 ? 'bg-white/90' : 'bg-gray-400'}`} aria-hidden />
              {roleVisitors.length > 999 ? '999+' : roleVisitors.length}
            </span>
          </button>
          {hasTrackedSite && (
            <button onClick={() => setTab('billing')} className={`${NAV_TAB} ${tab === 'billing' ? NAV_TAB_ON : NAV_TAB_OFF}`}>Billing</button>
          )}
          {userRole === 'admin' && (
            <button onClick={() => setTab('performance')} className={`${NAV_TAB} ${tab === 'performance' ? NAV_TAB_ON : NAV_TAB_OFF}`}>Reports</button>
          )}
          <a href="/pipeline" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigateTo('/pipeline') } }}
            className={`${NAV_TAB} ${NAV_TAB_OFF}`}>Pipeline</a>
          <a href="/tasks" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigateTo('/tasks') } }}
            className={`${NAV_TAB} ${NAV_TAB_OFF}`}>
            <span className="truncate">Tasks</span>
            {/* Overdue + due today for this member, in Pakistan time. */}
            <span className={`${NAV_COUNT} ${taskBadge > 0 ? (taskBadgeOverdue > 0 ? 'bg-red-600 text-white' : 'bg-amber-500 text-white') : 'hidden sm:inline-block bg-gray-200 text-gray-500'}`}
              title={taskBadge > 0 ? `${taskBadgeOverdue} overdue · ${taskBadge - taskBadgeOverdue} due today` : 'Nothing due'}>
              {taskBadge > 99 ? '99+' : taskBadge}
            </span>
          </a>
        </nav>

        {/* ── 3. Controls ── */}
        <div className="ml-auto flex items-center gap-1 lg:gap-1.5 shrink-0">

          {/* Whether the AI is answering customers on the live sites. It is a
              standing fact about the product rather than a per-page detail, so
              it gets a bordered chip.
              Read-only: there is no global on/off control in this bar today, it
              follows lib/botflag.ts and the settings fetch.

              It used to be a bare dot with the words gated behind `xl`, which
              at every width below that was an unlabelled grey circle in a box
              — and a grey dot reads as "broken", not as "off". So the chip now
              always carries a Bot / BotOff glyph AND the word, and the two
              states differ by icon, colour and text at once rather than by the
              shade of one 8px circle. */}
          <span title={botGlobalOff
              ? 'The AI bot is OFF — every chat goes straight to a human'
              : 'The AI bot is ON and answering visitors on your live sites'}
            className={`hidden sm:inline-flex items-center gap-1.5 h-8 px-2 lg:px-2.5 rounded-lg border text-[11px] font-semibold whitespace-nowrap ${botGlobalOff ? 'bg-gray-100 border-gray-300 text-gray-600' : 'bg-green-50 border-green-300 text-green-800'}`}>
            {botGlobalOff
              ? <BotOff size={14} strokeWidth={2} className="shrink-0" aria-hidden />
              : <Bot size={14} strokeWidth={2} className="shrink-0" aria-hidden />}
            <span>Bot {botGlobalOff ? 'off' : 'on'}</span>
          </span>

          {/* Replies waiting on this agent. Sits up here rather than only on a
              record, because the whole problem was that the signal lived on a
              page you had to already be looking at. Always in the bar and lit
              only when it has something to say — same reasoning as the tab
              counts: an element that appears later moves its neighbours. */}
          <a href="/tasks" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigateTo('/tasks') } }}
            title={unreadReplies > 0 ? `${unreadReplies} customer repl${unreadReplies === 1 ? 'y' : 'ies'} you have not opened` : 'No unread customer replies'}
            className={`shrink-0 inline-flex items-center justify-center gap-1 h-8 px-2 rounded-lg text-[11px] font-bold tabular-nums transition-colors ${unreadReplies > 0 ? 'bg-violet-600 text-white hover:bg-violet-700' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'}`}>
            <Inbox size={15} strokeWidth={2} aria-hidden />
            {unreadReplies > 99 ? '99+' : unreadReplies}
          </a>

          {/* The same palette the CRM pages carry, so ⌘K works wherever an agent
              happens to be when the phone rings. */}
          <GlobalSearch />

          <span className="hidden sm:block w-px h-5 bg-gray-200 mx-0.5" aria-hidden />

          {/* Utilities. Borderless and grey on purpose — they are switches you
              set once, not things to be drawn to. */}
          {pushState !== 'unsupported' && (
            <button onClick={togglePush}
              title={pushState === 'on' ? 'Push notifications ON for this device — new chats ping you even with the app closed. Click to turn off.' : 'Enable push notifications on this device — get pinged about new chats even when the app is closed'}
              aria-label={pushState === 'on' ? 'Push notifications on' : 'Push notifications off'}
              aria-pressed={pushState === 'on'}
              className={`${ICON_BTN} ${pushState === 'on' ? 'text-green-700 hover:bg-green-50' : ICON_BTN_IDLE}`}>
              <Vibrate size={15} strokeWidth={2} aria-hidden />
            </button>
          )}
          {/* Muted is the state worth shouting about: it is the one that loses
              a customer, and four grey icons in a row do not distinguish a
              bell from a struck-through bell at 15px. So OFF gets its own
              colour and a filled chip, not just a different glyph. */}
          <button onClick={toggleSound} aria-pressed={soundOn}
            aria-label={soundOn ? 'Sound on' : 'Sound off — dashboard is muted'}
            title={soundOn
              ? 'Sound on — chimes repeat every few seconds while a visitor or chat is waiting, and push notifications ping. Click to mute everything.'
              : 'Sound OFF — no chimes and no sound on push notifications. Alerts still appear, silently. Click to unmute.'}
            className={`${ICON_BTN} ${soundOn ? ICON_BTN_IDLE : 'text-amber-700 bg-amber-50 hover:bg-amber-100'}`}>
            {soundOn ? <Bell size={15} strokeWidth={2} aria-hidden /> : <BellOff size={15} strokeWidth={2} aria-hidden />}
          </button>
          <button onClick={toggleTheme} aria-pressed={darkMode}
            aria-label={darkMode ? 'Theme — dark' : 'Theme — light'}
            title={darkMode ? 'Dark mode on — click for light mode' : 'Light mode — click for dark mode'}
            className={`${ICON_BTN} ${ICON_BTN_IDLE}`}>
            {darkMode ? <Sun size={15} strokeWidth={2} aria-hidden /> : <Moon size={15} strokeWidth={2} aria-hidden />}
          </button>

          {/* Team presence — who is online right now (any member can see it). */}
          <div className="relative">
            <button onClick={() => setShowTeam((v) => !v)} title="See which teammates are online right now"
              aria-label={`Team presence — ${teamAgents.filter((a) => a.online).length} online`} aria-expanded={showTeam}
              className={`${ICON_BTN} ${ICON_BTN_IDLE} gap-1`}>
              <span className={`w-2 h-2 rounded-full shrink-0 ${teamAgents.some((a) => a.online) ? 'bg-green-500' : 'bg-gray-300'}`} aria-hidden />
              <span className="text-[11px] font-semibold tabular-nums">{teamAgents.filter((a) => a.online).length}</span>
            </button>
            {showTeam && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowTeam(false)} />
                <div className="absolute right-0 mt-1.5 w-60 max-h-80 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-xl z-30 py-1.5">
                  <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 border-b border-gray-100 flex items-center justify-between">
                    <span>Team</span>
                    <span className="text-green-600">{teamAgents.filter((a) => a.online).length} online</span>
                  </div>
                  {teamAgents.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-gray-500">No teammates found.</p>
                  ) : teamAgents.map((a) => (
                    <div key={a.email} className="px-3 py-1.5 flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${a.online ? 'bg-green-500' : 'bg-gray-300'}`} title={a.online ? 'Online' : 'Offline'} />
                      <span className={`text-xs truncate flex-1 ${a.online ? 'text-gray-900 font-medium' : 'text-gray-400'}`}>{agentShort(a.email)}</span>
                      <span className="text-[10px] text-gray-400 shrink-0">{a.online ? 'online' : a.lastSeen ? timeAgo(a.lastSeen) : '—'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <span className="hidden sm:block w-px h-5 bg-gray-200 mx-0.5" aria-hidden />

          {/* Account. Identity and the two account-level actions live together
              here instead of as loose buttons that used to be the first things
              to fall onto a second row. */}
          <div className="relative">
            <button onClick={() => setShowAccount((v) => !v)} aria-expanded={showAccount}
              title={`${userEmail} — account`} aria-label="Account menu"
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-white text-[11px] font-bold uppercase shadow-md hover:opacity-90 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              style={{ backgroundColor: accentColor }}>
              {(userEmail || '?').slice(0, 2)}
            </button>
            {showAccount && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowAccount(false)} />
                <div className="absolute right-0 mt-1.5 w-60 bg-white border border-gray-200 rounded-xl shadow-xl z-30 py-1.5">
                  <div className="px-3 py-2 border-b border-gray-100">
                    <p className="text-xs font-semibold text-gray-900 truncate">{userEmail}</p>
                    <span className={`mt-1 inline-block px-1.5 py-px rounded-full text-[9px] font-semibold uppercase tracking-wide ${userRole === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-gray-200 text-gray-600'}`}>{userRole}</span>
                  </div>
                  {userRole === 'admin' && (
                    <a href="/members" className="flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 transition-colors">
                      <Users size={14} strokeWidth={2} aria-hidden /> Members
                    </a>
                  )}
                  <button onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-100 transition-colors text-left">
                    <LogOut size={14} strokeWidth={2} aria-hidden /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── OVERVIEW TAB ── */}
      {tab === 'overview' && (
        <div className="p-6 max-w-6xl mx-auto animate-in">
          {overviewLoading ? (
            <OverviewSkeleton />
          ) : (
            <>
              {/* Stats row. Today's Leads / This Week double as filter shortcuts
                  for the Recent Leads table below (click again to clear). */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                {[
                  { label: 'Total Sites', value: roleSites.length, icon: Trophy, color: 'from-blue-100 to-blue-50', border: 'border-blue-200', dateFilter: undefined },
                  { label: 'Total Leads', value: overviewSummaryLeads.length, icon: Users, color: 'from-green-100 to-green-50', border: 'border-green-200', dateFilter: undefined },
                  { label: botGlobalOff ? 'Active Sites' : 'Active Bots', value: roleSites.length, icon: botGlobalOff ? Globe : Bot, color: 'from-purple-100 to-purple-50', border: 'border-purple-200', dateFilter: undefined },
                  { label: "Today's Leads", value: todayLeads, icon: Sun, color: 'from-orange-100 to-orange-50', border: 'border-orange-200', dateFilter: 'today' as const },
                  { label: "This Week", value: thisWeekLeads, icon: TrendingUp, color: 'from-cyan-500/10 to-cyan-600/5', border: 'border-cyan-500/20', dateFilter: 'week' as const },
                ].map((s) => {
                  const clickable = s.dateFilter !== undefined
                  const active = clickable && overviewLeadDate === s.dateFilter
                  return (
                    <button key={s.label} disabled={!clickable}
                      onClick={() => {
                        if (!s.dateFilter) return
                        setOverviewLeadDate(active ? 'all' : s.dateFilter)
                        setOverviewLeadPage(0)
                        leadsTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }}
                      title={clickable ? (active ? 'Clear this date filter' : `Show ${s.label.toLowerCase()} in the leads table below`) : undefined}
                      className={`group text-left bg-gradient-to-br ${s.color} rounded-2xl p-5 border ${active ? 'border-gray-400 ring-2 ring-gray-300' : s.border} bg-gray-100 transition-all duration-200 ${clickable ? 'hover:-translate-y-0.5 hover:border-gray-400 hover:shadow-lg hover:shadow-black/20 cursor-pointer' : ''}`}>
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide">{s.label}</p>
                        <span className="text-gray-500 opacity-80 group-hover:opacity-100 transition-opacity"><s.icon size={18} strokeWidth={2} aria-hidden /></span>
                      </div>
                      <p className="text-[2.5rem] leading-none font-extrabold text-gray-900 tracking-tight tabular-nums">{s.value}</p>
                    </button>
                  )
                })}
              </div>

              {/* Analytics over time */}
              <div className="bg-gray-100 rounded-xl border border-gray-200 p-5 mb-6">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <h2 className="text-sm font-semibold text-gray-900">Visitors &amp; Chats Over Time</h2>
                  <div className="flex gap-1 bg-white p-1 rounded-lg border border-gray-300">
                    {RANGES.map((r) => (
                      <button key={r.key} onClick={() => setAnalyticsRange(r.key)}
                        style={analyticsRange === r.key ? { backgroundColor: accentColor } : undefined}
                        className={`px-3.5 py-1.5 rounded-md text-xs font-semibold transition-all ${analyticsRange === r.key ? 'text-white shadow-sm' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'}`}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <AnalyticsChart points={analytics} accent={accentColor} totalUnique={analyticsUnique} />
              </div>

              {/* Chart + Sites row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
                {/* Bar chart */}
                <div className="bg-gray-100 rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-gray-900">Leads — Last 7 Days</h2>
                    <span className="text-xs text-gray-500">{overviewSummaryLeads.length} total</span>
                  </div>
                  <div className="flex items-end gap-2 h-24">
                    {chartDays.map((day) => {
                      const pct = chartMax > 0 ? (day.count / chartMax) * 100 : 0
                      const isToday = day.key === todayStr
                      return (
                        <div key={day.key} className="flex-1 flex flex-col items-center gap-1">
                          {day.count > 0 && <span className="text-[10px] text-gray-500">{day.count}</span>}
                          <div className="w-full flex items-end" style={{ height: '72px' }}>
                            <div
                              className={`w-full rounded-t-md transition-all ${isToday ? 'opacity-100' : 'opacity-60'}`}
                              style={{
                                height: `${Math.max(pct, day.count > 0 ? 8 : 2)}%`,
                                minHeight: day.count > 0 ? '6px' : '2px',
                                backgroundColor: isToday ? accentColor : '#d1d5db',
                              }}
                            />
                          </div>
                          <span className={`text-[10px] ${isToday ? 'text-gray-900 font-semibold' : 'text-gray-500'}`}>{day.label}</span>
                        </div>
                      )
                    })}
                  </div>
                  {overviewSummaryLeads.length === 0 && (
                    <p className="text-xs text-gray-500 text-center mt-2">No leads captured yet</p>
                  )}
                </div>

                {/* Quick stats per site */}
                <div className="bg-gray-100 rounded-xl border border-gray-200 p-5">
                  <h2 className="text-sm font-semibold text-gray-900 mb-4">Leads by Site</h2>
                  <div className="space-y-2.5">
                    {roleSites.length === 0 ? (
                      <p className="text-xs text-gray-500">No sites configured</p>
                    ) : roleSites.map((site) => {
                      const count = overviewSummaryLeads.filter(l => l.site_id === site.site_id).length
                      const pct = overviewSummaryLeads.length > 0 ? Math.round((count / overviewSummaryLeads.length) * 100) : 0
                      const accent = SITE_ACCENT[site.site_id] ?? accentColor
                      const active = overviewLeadSite === site.site_id
                      return (
                        <button key={site.site_id}
                          onClick={() => {
                            setOverviewLeadSite(active ? '' : site.site_id)
                            setOverviewLeadPage(0)
                            if (!active) leadsTableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }}
                          title={active ? 'Clear this site filter' : `Show ${site.name}'s leads in the table below`}
                          className={`block w-full text-left rounded-lg px-2 py-1.5 -mx-2 transition-colors ${active ? 'bg-white ring-1 ring-gray-300' : 'hover:bg-white/70'}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className={`text-xs truncate ${active ? 'text-gray-900 font-semibold' : 'text-gray-700'}`}>{site.name}</span>
                            <span className="text-xs text-gray-500 shrink-0 ml-2">{count} leads {active ? <X size={11} strokeWidth={2} aria-hidden /> : '→'}</span>
                          </div>
                          <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: accent }} />
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              {/* Site cards */}
              <div className="mb-6">
                <h2 className="text-sm font-semibold text-gray-900 mb-3">Configured Sites</h2>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                  {roleSites.map((site) => {
                    const accent = SITE_ACCENT[site.site_id] ?? site.primary_color
                    const url = SITE_URLS[site.site_id]
                    const count = overviewSummaryLeads.filter((l) => l.site_id === site.site_id).length
                    return (
                      <div key={site.site_id} className="bg-gray-100 rounded-2xl border border-gray-200 overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-lg hover:shadow-black/20 group">
                        <div className="h-1" style={{ backgroundColor: accent }} />
                        <div className="p-4">
                          <div className="flex items-center gap-2.5 mb-3">
                            <SiteIcon siteId={site.site_id} name={site.name} size={36} accent={accent} />
                            <div className="min-w-0">
                              <p className="font-semibold text-gray-900 text-sm truncate">{site.name}</p>
                              <p className="text-gray-500 text-[11px] truncate">{site.bot_name}</p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between pt-2 border-t border-gray-200">
                            <span className="text-xs font-medium" style={{ color: accent }}>{count} lead{count !== 1 ? 's' : ''}</span>
                            {url ? (
                              <a href={`https://${url}`} target="_blank" rel="noopener noreferrer"
                                className="text-[11px] text-gray-500 hover:text-blue-700 transition-colors truncate max-w-[120px]" title={url}>
                                {url}
                              </a>
                            ) : (
                              <span className="text-[11px] text-gray-500 font-mono">{site.site_id}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Leads table */}
              <div ref={leadsTableRef}>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <h2 className="text-sm font-semibold text-gray-900">Recent Leads</h2>
                  <select value={overviewLeadDate} onChange={(e) => { setOverviewLeadDate(e.target.value as typeof overviewLeadDate); setOverviewLeadPage(0) }}
                    className={`text-xs rounded-full px-2.5 py-1 border focus:outline-none cursor-pointer ${overviewLeadDate !== 'all' ? 'bg-orange-100 border-orange-300 text-orange-700 font-semibold' : 'bg-white border-gray-300 text-gray-700'}`}>
                    <option value="all">All time</option>
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="week">This week</option>
                    <option value="month">This month</option>
                  </select>
                  <select value={overviewLeadType} onChange={(e) => { setOverviewLeadType(e.target.value as typeof overviewLeadType); setOverviewLeadPage(0) }}
                    className={`text-xs rounded-full px-2.5 py-1 border focus:outline-none cursor-pointer ${overviewLeadType === 'quote' ? 'bg-amber-100 border-amber-300 text-amber-700 font-semibold' : overviewLeadType === 'checkout' ? 'bg-purple-100 border-purple-300 text-purple-700 font-semibold' : overviewLeadType === 'chat' ? 'bg-blue-100 border-blue-300 text-blue-700 font-semibold' : 'bg-white border-gray-300 text-gray-700'}`}>
                    <option value="all">All types</option>
                    <option value="chat">Chat only</option>
                    <option value="quote">Quote only</option>
                    <option value="checkout">Checkout only</option>
                  </select>
                  {overviewLeadSite && (
                    <button onClick={() => { setOverviewLeadSite(''); setOverviewLeadPage(0) }}
                      className="text-[11px] font-medium text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-2 py-0.5 hover:bg-blue-200 transition-colors"
                      title="Clear the site filter">
                      {roleSites.find((s) => s.site_id === overviewLeadSite)?.name ?? overviewLeadSite} <X size={11} strokeWidth={2} aria-hidden />
                    </button>
                  )}
                  {(overviewLeadSite || overviewLeadDate !== 'all' || overviewLeadType !== 'all') && (
                    <span className="text-[11px] text-gray-500">{overviewFilteredLeads.length} result{overviewFilteredLeads.length !== 1 ? 's' : ''}</span>
                  )}
                </div>
                <div className="bg-gray-100 rounded-xl border border-gray-200 overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[1100px]">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-100">
                          {['Type', 'Score', 'Name', 'Email', 'Phone', 'Message', 'Product', 'Qty', 'Budget', 'Timeline', 'Site', 'Date', ''].map((h) => (
                            <th key={h} className="text-left px-3 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {overviewFilteredLeads.length === 0 ? (
                          <tr>
                            <td colSpan={13} className="text-center py-8">
                              <div className="flex flex-col items-center">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center mb-2 text-gray-500"><Inbox size={18} strokeWidth={2} aria-hidden /></div>
                                <p className="text-gray-700 text-sm font-medium">{(overviewLeadSite || overviewLeadDate !== 'all' || overviewLeadType !== 'all') ? 'No leads match this filter' : 'No leads captured yet'}</p>
                                <p className="text-gray-500 text-xs mt-0.5">{(overviewLeadSite || overviewLeadDate !== 'all' || overviewLeadType !== 'all') ? 'Try a different date range, site, or type' : 'Leads appear here when the bot qualifies a visitor'}</p>
                              </div>
                            </td>
                          </tr>
                        ) : overviewLeadsPageRows.map((lead) => {
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
                          // Quote and checkout leads both arrive by email and have
                          // no conversation behind them, so their row opens the
                          // message instead of a chat transcript.
                          const isEmailLead = leadSource(lead.message) !== 'chat'

                          if (isEditing) return (
                            <tr key={lead.id} className="border-b border-gray-200 bg-gray-100">
                              <td className="px-3 py-2 whitespace-nowrap">
                                <LeadSourceBadge message={lead.message} />
                              </td>
                              <td className="px-3 py-2">{score !== null ? <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${score >= 7 ? 'bg-green-100 text-green-600 border border-green-200' : score >= 4 ? 'bg-yellow-100 text-yellow-700 border border-yellow-300' : 'bg-gray-200 text-gray-500'}`}>{score}/7</span> : <span className="text-gray-500 text-xs">-</span>}</td>
                              <td className="px-3 py-2"><input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="bg-gray-200 border border-gray-300 rounded px-2 py-1 text-xs text-gray-900 w-full min-w-[80px] focus:outline-none focus:border-blue-500" placeholder="Name" /></td>
                              <td className="px-3 py-2"><input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} className="bg-gray-200 border border-gray-300 rounded px-2 py-1 text-xs text-blue-700 w-full min-w-[140px] focus:outline-none focus:border-blue-500" placeholder="Email" /></td>
                              <td className="px-3 py-2"><input value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} className="bg-gray-200 border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 w-full min-w-[100px] focus:outline-none focus:border-blue-500" placeholder="Phone" /></td>
                              <td className="px-3 py-2" colSpan={5}><input value={editForm.message} onChange={(e) => setEditForm({ ...editForm, message: e.target.value })} className="bg-gray-200 border border-gray-300 rounded px-2 py-1 text-xs text-gray-700 w-full focus:outline-none focus:border-blue-500" placeholder="Message" /></td>
                              <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{siteName}</td>
                              <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{lead.created_at ? formatDateTime(lead.created_at) : '-'}</td>
                              <td className="px-3 py-2"><div className="flex gap-1"><button onClick={() => saveEditLead(lead.id)} disabled={savingEdit} className="text-xs bg-green-600 hover:bg-green-700 text-white px-2 py-1 rounded transition-colors disabled:opacity-50">{savingEdit ? '…' : 'Save'}</button><button onClick={() => setEditingLeadId(null)} className="text-xs bg-gray-200 hover:bg-gray-300 text-gray-700 px-2 py-1 rounded transition-colors">Cancel</button></div></td>
                            </tr>
                          )

                          return (
                            <tr key={lead.id} onClick={() => openLeadRecord(leadRecordId(lead))}
                              title="Open this lead's record"
                              className="group border-b border-gray-100 hover:bg-gray-100 transition-colors cursor-pointer">
                              <td className="px-3 py-3 whitespace-nowrap">
                                <LeadSourceBadge message={lead.message} />
                              </td>
                              <td className="px-3 py-3">{score !== null ? <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${score >= 7 ? 'bg-green-100 text-green-600 border border-green-200' : score >= 4 ? 'bg-yellow-100 text-yellow-700 border border-yellow-300' : 'bg-gray-200 text-gray-500'}`}>{score}/7</span> : <span className="text-gray-500 text-xs">-</span>}</td>
              {/* A plain anchor: normal click, middle-click and cmd-click all
                  behave the way the browser intends, with nothing intercepted. */}
                              <td className="px-3 py-3 text-gray-900 font-medium whitespace-nowrap">
                                <a href={leadRecordHref(leadRecordId(lead))} onClick={(e) => e.stopPropagation()}
                                  className="hover:underline">{lead.name || '-'}</a>
                              </td>
                              <td className="px-3 py-3 text-blue-600 whitespace-nowrap">{lead.email || '-'}</td>
                              <td className="px-3 py-3 text-gray-700 whitespace-nowrap">{lead.phone || '-'}</td>
                              {/* Email leads keep their full-message popup here —
                                  the record page shows it too, but this is the
                                  one-click peek the table has always had. */}
                              <td onClick={(e) => { if (isEmailLead) { e.stopPropagation(); setViewOverviewLead(lead) } }}
                                className="px-3 py-3 text-gray-500 max-w-[150px] truncate" title={isEmailLead ? 'View the full message' : (cleanLeadMessage(lead.message) !== '-' ? cleanLeadMessage(lead.message) : undefined)}>{cleanLeadMessage(lead.message)}</td>
                              <td className="px-3 py-3 text-gray-700 max-w-[120px] truncate" title={product !== '-' ? product : undefined}>{product}</td>
                              <td className="px-3 py-3 text-gray-500 whitespace-nowrap">{quantity}</td>
                              <td className="px-3 py-3 text-gray-500 whitespace-nowrap">{budget}</td>
                              <td className="px-3 py-3 text-gray-500 whitespace-nowrap">{timeline}</td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: `${accent}20`, color: accent }}>{siteName}</span>
                              </td>
                              <td className="px-3 py-3 text-gray-500 text-xs whitespace-nowrap">{lead.created_at ? formatDateTime(lead.created_at) : '-'}</td>
                              <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                {isConfirmingDelete ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-700">Delete?</span>
                                    <button onClick={() => deleteLead(lead.id)} disabled={deletingLead} className="text-xs text-red-600 hover:text-red-700 font-semibold">Yes</button>
                                    <span className="text-xs text-gray-500 mx-0.5">·</span>
                                    <button onClick={() => setConfirmLeadDeleteId(null)} className="text-xs text-gray-500 hover:text-gray-600">No</button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    {/* The row now opens the CRM record, so the
                                        old "row opens the chat" behaviour lives
                                        on as its own button. */}
                                    {!isEmailLead && (
                                      <button onClick={() => openLeadConversation(lead)} className="p-1.5 text-gray-500 hover:text-blue-700 hover:bg-gray-200 rounded-lg transition-colors" title="Open the chat conversation"><MessageSquare size={13} strokeWidth={2} aria-hidden /></button>
                                    )}
                                    <button onClick={() => startEditLead(lead)} className="p-1.5 text-gray-500 hover:text-blue-700 hover:bg-gray-200 rounded-lg transition-colors" title="Edit"><Pencil size={13} strokeWidth={2} aria-hidden /></button>
                                    <button onClick={() => setConfirmLeadDeleteId(lead.id)} className="p-1.5 text-gray-500 hover:text-red-600 hover:bg-gray-200 rounded-lg transition-colors" title="Delete"><Trash2 size={13} strokeWidth={2} aria-hidden /></button>
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
                {/* Pagination */}
                {overviewFilteredLeads.length > OVERVIEW_LEADS_PER_PAGE && (
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-xs text-gray-500">
                      Showing {overviewLeadPageClamped * OVERVIEW_LEADS_PER_PAGE + 1}–{Math.min((overviewLeadPageClamped + 1) * OVERVIEW_LEADS_PER_PAGE, overviewFilteredLeads.length)} of {overviewFilteredLeads.length}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setOverviewLeadPage(Math.max(0, overviewLeadPageClamped - 1))} disabled={overviewLeadPageClamped === 0}
                        className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"><ChevronLeft size={12} strokeWidth={2} aria-hidden /> Prev</button>
                      <span className="text-xs text-gray-600 px-2">Page {overviewLeadPageClamped + 1} / {overviewLeadPageCount}</span>
                      <button onClick={() => setOverviewLeadPage(Math.min(overviewLeadPageCount - 1, overviewLeadPageClamped + 1))} disabled={overviewLeadPageClamped >= overviewLeadPageCount - 1}
                        className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Next <ChevronRight size={12} strokeWidth={2} aria-hidden /></button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CONVERSATIONS TAB ── */}
      {tab === 'conversations' && (
        <div className="flex flex-col animate-in" style={{ height: `calc(100dvh - ${headerH}px)` }}>
         <div className="flex flex-1 min-h-0">

          {/* ── Left sidebar: live visitors + waiting chats ──
              Top: live visitors, so an agent can grab someone the moment they're
              on a site. Bottom: the reply queue — every chat whose last message
              is the customer's, oldest wait first (the same chats the alert
              chime rings for). Past visitors/chats live in the Visitors tab. */}
          {(() => {
            // Split live visitors by whether an agent has picked their chat up,
            // so "Assigned" ones sit above the still-free "Unassigned" pool.
            const assignedVisitors = roleVisitors.filter((v) => assignmentBySession[v.session_id])
            const unassignedVisitors = roleVisitors.filter((v) => !assignmentBySession[v.session_id])
            const renderVisitorCard = (v: Visitor) => {
              const accent = SITE_ACCENT[v.site_id] ?? '#16a34a'
              return (
                <button key={v.session_id} onClick={() => openVisitorSession(v)}
                  className="w-full text-left px-3 py-2 border-b border-gray-100 hover:bg-green-50 transition-colors flex items-start gap-2.5"
                  style={{ borderLeft: `3px solid ${accent}` }}>
                  <span className="shrink-0 mt-0.5 text-gray-500" title={[v.device_type, v.browser, v.os].filter(Boolean).join(' · ')}><DeviceIcon d={v.device_type} /></span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-semibold text-gray-900 truncate">{v.site_name}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {v.visits > 1 && (
                          <span className="text-[9px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-px inline-flex items-center gap-1" title={`${v.visits} visits — returning visitor`}><Repeat size={8} strokeWidth={2.5} aria-hidden /> {v.visits}</span>
                        )}
                        {/* The live list only ever contains visitors active within the
                            last 60s (server-filtered), so these are genuinely live. */}
                        <span className="text-[10px] text-green-600 font-medium flex items-center gap-1 shrink-0" title={`Last activity ${timeAgo(v.last_seen)}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />active now
                        </span>
                      </div>
                    </div>
                    {/* Currently viewing */}
                    <div className="text-[11px] text-gray-700 truncate mt-0.5" title={v.page_url ?? undefined}>
                      <span className="text-gray-500">Viewing:</span> {viewingLabel(v)}
                    </div>
                    {/* Location · referrer */}
                    <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                      {v.country && <span className="text-[11px] text-gray-500 truncate">{v.country}</span>}
                      {v.country && <span className="text-[10px] text-gray-500 shrink-0">·</span>}
                      <span className="text-[10px] text-gray-500 truncate" title={v.referrer ?? 'Direct'}>via {cleanReferrer(v.referrer)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-1 mt-0.5">
                      <span className="text-[10px] text-green-600">on site {timeOnSite(v.created_at)}</span>
                      {assignmentBySession[v.session_id] && (
                        <AssignBadge email={assignmentBySession[v.session_id]} me={userEmail} />
                      )}
                    </div>
                  </div>
                </button>
              )
            }
            // On phones the sidebar IS the page until a chat is opened; the
            // chat then takes over with a ← back button. md+ shows both.
            return (
          <div className={`w-full md:w-[300px] flex-shrink-0 border-r border-gray-200 flex-col bg-gray-50 ${selectedSession ? 'hidden md:flex' : 'flex'}`}>
            <div className="px-3 py-2 flex items-center gap-2 bg-green-50 flex-shrink-0 border-b border-gray-200">
              <span className={`w-2 h-2 rounded-full shrink-0 ${roleVisitors.length > 0 ? 'bg-green-500 ring-2 ring-green-200 animate-pulse' : 'bg-gray-300'}`} />
              <p className={`text-[11px] font-semibold uppercase tracking-wider ${roleVisitors.length > 0 ? 'text-green-600' : 'text-gray-500'}`}>
                {roleVisitors.length > 0 ? `${roleVisitors.length} Live ${roleVisitors.length === 1 ? 'Visitor' : 'Visitors'}` : 'No live visitors'}
              </p>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {roleVisitors.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8 animate-in">
                  <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center mb-2 text-gray-500"><Eye size={18} strokeWidth={2} aria-hidden /></div>
                  <p className="text-sm text-gray-700 font-medium">Nobody on your sites right now</p>
                  <p className="text-xs text-gray-500 mt-0.5">Live visitors appear here the moment they land. Past visitors &amp; chats are in the Visitors tab.</p>
                </div>
              ) : (
                <>
                  {/* Assigned — chats an agent has already picked up. Only shown
                      once at least one is claimed, so it stays out of the way. */}
                  {assignedVisitors.length > 0 && (
                    <>
                      <div className="px-3 py-1.5 bg-green-50 border-b border-green-100 flex items-center gap-1.5 sticky top-0 z-[1]">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-green-700 inline-flex items-center gap-1"><Check size={10} strokeWidth={2.5} aria-hidden /> Currently served</span>
                        <span className="text-[10px] text-green-600">({assignedVisitors.length})</span>
                      </div>
                      {assignedVisitors.map(renderVisitorCard)}
                    </>
                  )}
                  {/* Unassigned — still up for grabs. Always labelled so agents
                      can always see which chats nobody has picked up yet. */}
                  {unassignedVisitors.length > 0 && (
                    <div className="px-3 py-1.5 bg-gray-100 border-b border-gray-200 flex items-center gap-1.5 sticky top-0 z-[1]">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 inline-flex items-center gap-1"><Eye size={11} strokeWidth={2} aria-hidden /> Active visitors</span>
                      <span className="text-[10px] text-gray-400">({unassignedVisitors.length})</span>
                    </div>
                  )}
                  {unassignedVisitors.map(renderVisitorCard)}
                </>
              )}
            </div>
          </div>
            )
          })()}

          {/* ── Right panel ── */}
          <div className={`flex-1 flex-col min-w-0 ${selectedSession ? 'flex' : 'hidden md:flex'}`}>
            {!selectedSession ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center px-8 max-w-xs animate-in">
                  <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center mx-auto mb-3 border border-gray-200">
                    <svg viewBox="0 0 24 24" className="w-6 h-6 fill-gray-300"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                  </div>
                  <p className="text-gray-700 font-medium text-sm mb-1">Select a conversation</p>
                  <p className="text-gray-500 text-xs leading-relaxed">Click a live visitor or a waiting chat on the left, or find past visitors and chats in the Visitors tab.</p>
                </div>
              </div>
            ) : (
              <>
                {/* Conversation header */}
                <div className="px-3 sm:px-5 py-3 border-b border-gray-200 bg-white flex items-center justify-between flex-shrink-0">
                  <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <button onClick={() => setSelectedSession(null)}
                      className="md:hidden shrink-0 p-1.5 -ml-1 rounded-lg text-gray-600 hover:bg-gray-100 text-lg leading-none" title="Back to list">←</button>
                    <SiteIcon siteId={selectedSession.site_id} name={selectedSession.site_name} size={32} accent={SITE_ACCENT[selectedSession.site_id] ?? accentColor} />
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-900 text-sm">{selectedSession.site_name}</p>
                      <p className="text-[10px] text-gray-500 font-mono truncate">{selectedSession.session_id}</p>
                    </div>
                    {/* Additive: opening the CRM record is a separate link —
                        clicking the conversation itself behaves exactly as before. */}
                    <a href={leadRecordHref(selectedSession.session_id)}
                      title="Open the full lead record — stage, notes, deal value, activity"
                      className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-lg border border-gray-200 bg-white text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5"><Contact size={12} strokeWidth={2} aria-hidden /> Open record</span>
                    </a>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {/* Assignment control — pick up / release / take over a chat
                        so agents don't answer the same visitor at once. */}
                    {(() => {
                      const assignee = selectedSession.assignedTo
                      if (!assignee) {
                        return (
                          <button onClick={() => claimSession(true)} disabled={claimingSession}
                            title="Pick up this chat so other agents know you're handling it"
                            className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-green-300 bg-green-50 text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50 whitespace-nowrap">
                            <span className="inline-flex items-center gap-1.5"><UserPlus size={12} strokeWidth={2} aria-hidden /> Assign to me</span>
                          </button>
                        )
                      }
                      if (assignee === userEmail) {
                        return (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-green-200 bg-green-100 text-green-700 whitespace-nowrap inline-flex items-center gap-1.5"><Check size={12} strokeWidth={2.5} aria-hidden /> You have this</span>
                            <button onClick={() => claimSession(false)} disabled={claimingSession}
                              title="Release this chat back to the unassigned pool"
                              className="text-[11px] text-gray-500 hover:text-gray-800 underline disabled:opacity-50">Release</button>
                          </div>
                        )
                      }
                      return (
                        <div className="flex items-center gap-1.5">
                          <span title={`${assignee} is handling this chat`}
                            className="text-xs font-semibold px-2.5 py-1 rounded-lg border border-amber-200 bg-amber-100 text-amber-700 whitespace-nowrap"><span className="inline-flex items-center gap-1.5"><UserRound size={11} strokeWidth={2} aria-hidden /> {agentShort(assignee)} has this</span></span>
                          <button onClick={() => claimSession(true)} disabled={claimingSession}
                            title={`Take this chat over from ${assignee}`}
                            className="text-[11px] text-gray-500 hover:text-gray-800 underline disabled:opacity-50">Take over</button>
                        </div>
                      )
                    })()}
                    <span className="w-px h-5 bg-gray-200" />
                    <button onClick={() => setTranslateOn((v) => !v)}
                      title="Show English translations of non-English visitor messages"
                      className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors flex items-center gap-1.5 ${
                        translateOn ? 'bg-indigo-100 text-indigo-700 border-indigo-300' : 'bg-gray-200 text-gray-500 border-gray-300 hover:text-gray-700'
                      }`}>
                      <Languages size={12} strokeWidth={2} aria-hidden /> Translate{translateOn ? ' on' : ''}
                    </button>
                    {/* Global kill switch on: there is no bot to toggle and no
                        bot/AI wording should appear anywhere — show nothing. */}
                    {!botGlobalOff && (
                      <>
                        <span className="w-px h-5 bg-gray-200" />
                        <span className={`text-xs font-medium ${botEffectivelyActive ? 'text-blue-600' : 'text-gray-500'}`}>Bot</span>
                        <button onClick={toggleMode} disabled={togglingMode}
                          className={`relative w-10 h-5 rounded-full transition-colors focus:outline-none ${botEffectivelyActive ? 'bg-blue-600' : 'bg-orange-500'}`}>
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${botEffectivelyActive ? 'translate-x-0' : 'translate-x-5'}`} />
                        </button>
                        <span className={`text-xs font-medium ${!botEffectivelyActive ? 'text-orange-600' : 'text-gray-500'}`}>Human</span>
                        {scheduledBotOff && selectedSession.mode === 'bot' ? (
                          <span className="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full border border-indigo-200" title="The packaging bot is off on this schedule — replies are human-only right now"><span className="inline-flex items-center gap-1"><Moon size={10} strokeWidth={2} aria-hidden /> Bot off (scheduled)</span></span>
                        ) : selectedSession.mode === 'human' ? (
                          <span className="text-[10px] bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full border border-orange-200">AI off</span>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>

                {/* Messages area */}
                <div ref={messagesScrollRef} onScroll={handleMessagesScroll}
                  className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 bg-gray-50 space-y-1">
                  {messageDates.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                      {messagesLoading ? (
                        <div className="w-5 h-5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <p className="text-gray-500 text-sm">No messages yet</p>
                      )}
                    </div>
                  ) : messageDates.map((msg) => {
                    const isUser = msg.role === 'user'
                    const isAdmin = msg.role === 'admin'
                    const showDate = (msg as typeof msg & { showDate?: boolean; dateLabel?: string }).showDate
                    const dateLabel = (msg as typeof msg & { dateLabel?: string }).dateLabel
                    const dateDivider = showDate && (
                      <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-gray-200" />
                        <span className="text-[11px] text-gray-500 font-medium px-2">{dateLabel}</span>
                        <div className="flex-1 h-px bg-gray-200" />
                      </div>
                    )
                    // The widget's contact-info form doesn't post as a normal
                    // chat message (it's a structured submission, not typed
                    // text) — without this marker an agent reading the
                    // transcript has no way to know the visitor ever handed
                    // over their email at all.
                    if (msg.role === LEAD_CAPTURE_ROLE) {
                      const lead = parseLeadCapture(msg.message)
                      if (!lead) return null
                      // A manual mark has no contact info at all, so there's no
                      // visitor bubble to draw — show it as a centered note
                      // instead, making clear it was the admin's call and not
                      // something the visitor actually submitted.
                      if (lead.manual) {
                        return (
                          <div key={msg.id}>
                            {dateDivider}
                            <div className="flex justify-center mb-2">
                              <span className="text-[10px] text-amber-800 bg-amber-100 border border-amber-300 rounded-full px-2.5 py-1">
                                <span className="inline-flex items-center gap-1.5"><Pin size={10} strokeWidth={2} aria-hidden /> Marked as a lead by an admin · {formatTime(msg.created_at)}</span>
                              </span>
                            </div>
                          </div>
                        )
                      }
                      const lines = [lead.name, lead.email, lead.phone].filter(Boolean).join('\n')
                      return (
                        <div key={msg.id}>
                          {dateDivider}
                          <div className="flex flex-col mb-2 items-end">
                            <div className="flex items-center gap-1.5 mb-1 px-1">
                              <span className="text-[11px] text-gray-500">Visitor</span>
                              <span className="text-[10px] text-gray-500">{formatTime(msg.created_at)}</span>
                            </div>
                            <div className="max-w-sm lg:max-w-md xl:max-w-lg px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm bg-gray-200 text-gray-900 rounded-tr-sm border border-gray-300">
                              {lines}
                            </div>
                          </div>
                        </div>
                      )
                    }
                    const file = parseAttachment(msg.message)
                    return (
                      <div key={msg.id}>
                        {dateDivider}
                        <div className={`flex flex-col mb-2 ${isUser ? 'items-end' : 'items-start'}`}>
                          <div className="flex items-center gap-1.5 mb-1 px-1">
                            {!isUser && <span className={`text-[11px] font-semibold ${isAdmin ? 'text-orange-600' : 'text-blue-600'}`} title={isAdmin && msg.author ? msg.author : undefined}><span className="inline-flex items-center gap-1">{isAdmin
                              ? <><User size={10} strokeWidth={2.5} aria-hidden /> {msg.author ? agentShort(msg.author) : 'Agent'}</>
                              : botGlobalOff
                                ? <><MessageSquare size={10} strokeWidth={2.5} aria-hidden /> Auto-reply</>
                                : <><Bot size={10} strokeWidth={2.5} aria-hidden /> Bot</>}</span></span>}
                            {isUser && <span className="text-[11px] text-gray-500">Visitor</span>}
                            <span className="text-[10px] text-gray-500">{formatTime(msg.created_at)}</span>
                          </div>
                          {file ? (
                            <div className={`max-w-sm lg:max-w-md xl:max-w-lg rounded-2xl overflow-hidden shadow-sm border ${
                              isUser ? 'border-gray-300 rounded-tr-sm' : isAdmin ? 'border-amber-300 rounded-tl-sm' : 'border-gray-200 rounded-tl-sm'
                            }`}>
                              {isImageMime(file.mime) ? (
                                <a href={file.url} target="_blank" rel="noopener noreferrer" title={file.name}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={file.url} alt={file.name} className="block max-h-64 w-auto object-contain bg-gray-100" />
                                </a>
                              ) : (
                                <a href={file.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-2.5 px-4 py-3 bg-gray-100 hover:bg-gray-200 transition-colors">
                                  <span className="shrink-0 text-gray-500"><FileText size={24} strokeWidth={1.75} aria-hidden /></span>
                                  <span className="min-w-0">
                                    <span className="block text-sm text-blue-700 underline truncate max-w-[200px]">{file.name}</span>
                                    <span className="block text-[10px] text-gray-500">{file.size ? `${(file.size / 1024 / 1024).toFixed(1)} MB · ` : ''}Download</span>
                                  </span>
                                </a>
                              )}
                            </div>
                          ) : (
                            <div className={`max-w-sm lg:max-w-md xl:max-w-lg px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                              isUser
                                ? 'bg-gray-200 text-gray-900 rounded-tr-sm border border-gray-300'
                                : isAdmin
                                ? 'bg-amber-100 text-amber-900 rounded-tl-sm border border-amber-300'
                                : 'bg-gray-100 text-gray-900 rounded-tl-sm border border-gray-200'
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
                                <span className="text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-full px-2 py-0.5">
                                  Detected: {a.langName}
                                </span>
                                {translateOn && (
                                  <div className="px-3 py-2 rounded-2xl rounded-tr-sm text-sm leading-relaxed whitespace-pre-wrap bg-indigo-50 border border-indigo-200 text-indigo-950">
                                    <span className="block text-[10px] uppercase tracking-wide text-indigo-700 mb-0.5">English</span>
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
                      <div className="bg-gray-100 border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  )}
                  {visitorTyping && (
                    <div className="flex flex-col items-end mb-2 animate-in">
                      <div className="bg-gray-200 border border-gray-300 rounded-2xl rounded-tr-sm px-4 py-3 flex items-center gap-1.5">
                        <span className="text-[11px] text-gray-500 mr-1">Visitor is typing</span>
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    </div>
                  )}
                </div>

                {/* Reply input */}
                <div className="px-4 py-3 border-t border-gray-200 bg-white flex-shrink-0">
                  {/* Hard lock — this chat belongs to another agent. Messaging is
                      blocked (below) until you take over; you can still read it. */}
                  {lockedByOther && (
                    <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mb-2 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5"><Lock size={12} strokeWidth={2} aria-hidden /> <b>{agentShort(selectedSession.assignedTo)}</b> is handling this chat — you can view but not message.</span>
                      <button onClick={() => claimSession(true)} disabled={claimingSession}
                        className="shrink-0 font-semibold text-amber-900 underline hover:text-amber-700 disabled:opacity-50">Take over</button>
                    </div>
                  )}
                  {botEffectivelyActive ? (
                    <p className="text-[11px] text-blue-700 mb-2 flex items-center gap-1.5">
                      <Bot size={13} strokeWidth={2} aria-hidden /> Bot is active — toggle to Human to reply, or send a file to take over
                    </p>
                  ) : !botGlobalOff && scheduledBotOff && selectedSession.mode === 'bot' ? (
                    <p className="text-[11px] text-indigo-700 mb-2 flex items-center gap-1.5">
                      <Moon size={13} strokeWidth={2} aria-hidden /> Bot is off (scheduled) — human only. The bot won&apos;t reply right now; type to respond.
                    </p>
                  ) : null}
                  {/* Quick replies: one-tap canned openers/answers the agent can
                      drop into the box and Send. Shown while the box is empty (so
                      they don't get in the way once the agent starts typing). The
                      first is product-aware from the page the visitor is on. */}
                  {!lockedByOther && !botEffectivelyActive && !replyText.trim() && (() => {
                    const v = visitors.find((x) => x.session_id === selectedSession.session_id)
                    const product = (v?.page_title || '').split(/ [|\-–—] |·/)[0].trim()
                    const hasProduct = !!product && product.length >= 3 && product.length <= 70
                    // `text` is the button label AND what gets inserted; there
                    // was also an emoji `label` here that nothing ever rendered.
                    const quicks: { text: string }[] = [
                      hasProduct
                        ? { text: `Hi! Are you looking for ${product}?` }
                        : { text: 'Hi! How can I help you today?' },
                      { text: 'Would you like a quick quote? Please share your size and quantity.' },
                      { text: 'We offer custom printing and design support. Would you like the details?' },
                      { text: 'We offer free shipping and design support on all orders.' },
                      { text: 'Happy to help with sizes, quantities, or pricing — what do you need?' },
                    ]
                    return (
                      <div className="flex flex-col gap-1 mb-2 max-h-40 overflow-y-auto">
                        {quicks.map((q, i) => (
                          <button key={i} onClick={() => setReplyText(q.text)} title="Click to insert, then Send"
                            className="text-[11px] text-left px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors leading-snug">
                            {q.text}
                          </button>
                        ))}
                      </div>
                    )
                  })()}
                  {uploadError && (
                    <p className="text-[11px] text-red-600 mb-2">{uploadError}</p>
                  )}
                  {visitorLang && (
                    <label className="flex items-center gap-1.5 mb-2 text-[11px] text-indigo-700 cursor-pointer select-none w-fit">
                      <input type="checkbox" checked={translateOut} onChange={(e) => setTranslateOut(e.target.checked)}
                        className="rounded accent-indigo-500 cursor-pointer" />
                      <Languages size={12} strokeWidth={2} aria-hidden /> Translate my reply to {visitorLang} before sending
                    </label>
                  )}
                  <div className="flex gap-2">
                    <input ref={replyFileRef} type="file" className="hidden"
                      accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadReplyFile(f); e.target.value = '' }} />
                    <button
                      onClick={() => replyFileRef.current?.click()}
                      disabled={uploadingFile || lockedByOther}
                      title={lockedByOther ? 'Locked — take over to send' : 'Attach a file'}
                      className="px-3 py-2 bg-gray-100 border border-gray-300 text-gray-700 rounded-xl text-sm hover:bg-gray-200 hover:text-gray-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed self-center"
                    >
                      {uploadingFile ? '…' : <Paperclip size={16} strokeWidth={2} aria-hidden />}
                    </button>
                    <textarea
                      value={replyText}
                      onChange={(e) => {
                        setReplyText(e.target.value)
                        // Engaging (typing) claims + LOCKS an unassigned chat to
                        // this agent, so nobody else can message it.
                        if (selectedSession && e.target.value.trim() && !selectedSession.assignedTo) claimIfFree(selectedSession)
                        // Throttled "agent is typing" ping → shows dots in the widget.
                        const now = Date.now()
                        if (selectedSession && e.target.value.trim() && now - lastAgentTypingPing.current > 3000) {
                          lastAgentTypingPing.current = now
                          fetch('/api/admin/typing', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: selectedSession.session_id }),
                          }).catch(() => {})
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } }}
                      placeholder={lockedByOther ? `${agentShort(selectedSession.assignedTo)} is handling this — take over to reply` : botEffectivelyActive ? 'Switch to Human to reply' : 'Type a reply…'}
                      disabled={botEffectivelyActive || sending || lockedByOther}
                      rows={2}
                      className="flex-1 bg-white border-2 border-orange-500 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:border-orange-600 focus:ring-2 focus:ring-orange-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    />
                    <button
                      onClick={sendReply}
                      disabled={!replyText.trim() || sending || botEffectivelyActive || lockedByOther}
                      className="px-5 py-2.5 bg-orange-600 text-white rounded-xl text-sm font-semibold shadow-sm hover:bg-orange-700 active:bg-orange-800 transition-colors disabled:bg-orange-300 disabled:cursor-not-allowed self-center"
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
            <aside className="hidden lg:block w-[320px] xl:w-[360px] flex-shrink-0 border-l border-gray-200 bg-gray-50 overflow-y-auto">
              <div className="px-4 py-3 border-b border-gray-200 bg-white sticky top-0 backdrop-blur z-10 flex items-center gap-2">
                <span className="text-gray-500"><DeviceIcon d={visitorDetail?.technical.device_type ?? null} /></span>
                <div className="min-w-0">
                  {/* Once an agent saves a contact name, show it here instead of
                      the generic "Visitor details" so this reads as the customer. */}
                  <p className="text-sm font-semibold text-gray-900 leading-tight truncate">
                    {visitorDetail?.contact?.name?.trim() || 'Visitor details'}
                  </p>
                  <p className="text-[10px] text-gray-500 font-mono truncate">{selectedSession.session_id}</p>
                </div>
              </div>

              {detailLoading && !visitorDetail ? (
                <div className="flex items-center gap-2 px-4 py-8 text-gray-500 text-xs">
                  <div className="w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-300 rounded-full animate-spin" />
                  Loading visitor…
                </div>
              ) : (
                <div className="p-4 space-y-5">

                  {/* Tags */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-700 mb-2">Tags</h3>
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {tags.map((t) => (
                          <span key={t} className="group/tag inline-flex items-center gap-1 text-[11px] pl-2 pr-1 py-0.5 rounded-full text-gray-900"
                            style={{ backgroundColor: `${accentColor}cc` }}>
                            {t}
                            <button onClick={() => removeTag(t)} title="Remove tag"
                              className="w-3.5 h-3.5 inline-flex items-center justify-center rounded-full hover:bg-gray-100 text-gray-500 hover:text-gray-900 leading-none">×</button>
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
                      className="w-full bg-white border border-gray-300 rounded-lg px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400" />
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {['hot lead', 'got email', 'follow up', 'spam'].filter((q) => !tags.some((t) => t.toLowerCase() === q)).map((q) => (
                        <button key={q} onClick={() => addTag(q)}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-400 transition-colors">
                          + {q}
                        </button>
                      ))}
                    </div>
                  </section>

                  {/* Contact (editable) */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-700 mb-2">Contact</h3>
                    <div className="space-y-2">
                      <input value={contactForm.name} onChange={(e) => setContactForm({ ...contactForm, name: e.target.value })}
                        placeholder="Name"
                        className="w-full bg-white border border-gray-300 rounded-lg px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400" />
                      <input value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                        placeholder="Email" type="email"
                        className="w-full bg-white border border-gray-300 rounded-lg px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400" />
                      <input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                        placeholder="Phone"
                        className="w-full bg-white border border-gray-300 rounded-lg px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-400" />
                      <textarea value={contactForm.notes} onChange={(e) => setContactForm({ ...contactForm, notes: e.target.value })}
                        placeholder="Notes…" rows={3}
                        className="w-full bg-white border border-gray-300 rounded-lg px-2.5 py-2 text-xs text-gray-900 placeholder-gray-400 resize-none focus:outline-none focus:border-gray-400" />
                      <div className="flex items-center gap-2">
                        <button onClick={saveContact} disabled={savingContact}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium text-gray-900 disabled:opacity-50 transition-colors"
                          style={{ backgroundColor: accentColor }}>
                          {savingContact ? 'Saving…' : 'Save contact'}
                        </button>
                        {contactSaved && <span className="text-[11px] text-green-600 inline-flex items-center gap-1"><Check size={11} strokeWidth={2.5} aria-hidden /> Saved</span>}
                      </div>
                      {userRole === 'admin' && (
                        <div className="pt-2 mt-2 border-t border-gray-200">
                          <div className="flex items-center gap-2">
                            <button onClick={markAsLead} disabled={markingLead}
                              className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-800 bg-amber-100 border border-amber-300 hover:bg-amber-200 disabled:opacity-50 transition-colors">
                              <span className="inline-flex items-center gap-1.5"><Pin size={12} strokeWidth={2} aria-hidden /> {markingLead ? 'Marking…' : 'Mark as lead'}</span>
                            </button>
                            {leadMarked === 'new' && <span className="text-[11px] text-green-600 inline-flex items-center gap-1"><Check size={11} strokeWidth={2.5} aria-hidden /> Counted as a lead</span>}
                            {leadMarked === 'already' && <span className="text-[11px] text-gray-500">Already counted — no change</span>}
                          </div>
                          <p className="text-[10px] text-gray-500 mt-1">For when the customer clearly became a lead (e.g. &quot;I emailed you&quot;) without ever typing their email into the chat. Counts toward Billing with no contact info attached.</p>
                          {markLeadError && <p className="text-[10px] text-red-600 mt-1">{markLeadError}</p>}
                        </div>
                      )}
                    </div>
                  </section>

                  {/* Stats row */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-700 mb-2">Activity</h3>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { label: 'Visits', value: visitorDetail?.stats.visits ?? '—' },
                        { label: 'Chats', value: visitorDetail?.stats.chats ?? '—' },
                        { label: 'On site', value: formatDuration(visitorDetail?.stats.first_seen ?? null, visitorDetail?.stats.last_seen ?? null) },
                      ].map((s) => (
                        <div key={s.label} className="bg-gray-100 border border-gray-200 rounded-lg px-2 py-2.5 text-center">
                          <p className="text-base font-bold text-gray-900 leading-tight">{s.value}</p>
                          <p className="text-[10px] text-gray-500 mt-0.5">{s.label}</p>
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* Visitor path */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-700 mb-2">
                      Visitor path {visitorDetail && visitorDetail.path.length > 0 && <span className="text-gray-500 normal-case font-normal">· {visitorDetail.path.length} page{visitorDetail.path.length !== 1 ? 's' : ''}</span>}
                    </h3>
                    {!visitorDetail || visitorDetail.path.length === 0 ? (
                      <p className="text-xs text-gray-500">No page history captured yet</p>
                    ) : (
                      <ol className="relative border-l border-gray-300 ml-1.5 space-y-3">
                        {visitorDetail.path.map((p, i) => (
                          <li key={i} className="ml-3.5 relative">
                            <span className="absolute -left-[1.18rem] top-1 w-2 h-2 rounded-full" style={{ backgroundColor: accentColor }} />
                            <p className="text-xs text-gray-800 leading-snug break-words" title={p.url ?? undefined}>{pageLabel(p)}</p>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className="text-[10px] text-gray-500">{i + 1}.</span>
                              {p.at && <span className="text-[10px] text-gray-500">{formatDateTime(p.at)}</span>}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>

                  {/* Technical info */}
                  <section>
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-700 mb-2">Technical</h3>
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
                          <dt className="text-[11px] text-gray-500 shrink-0">{row.label}</dt>
                          <dd className="text-[11px] text-gray-800 text-right break-all">{row.value || '—'}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>

                  {/* Ban a spam/bot visitor by IP (admin only). Blocks them across
                      ALL sites — they can't load the widget or send messages. */}
                  {userRole === 'admin' && visitorDetail?.technical.ip && (
                    <section>
                      {blockedIps.includes(visitorDetail.technical.ip) ? (
                        <button onClick={() => toggleIpBlock(visitorDetail!.technical.ip!, false)}
                          className="w-full text-xs font-semibold px-3 py-2 rounded-lg border border-gray-300 bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors">
                          <span className="inline-flex items-center gap-1.5"><Check size={12} strokeWidth={2.5} aria-hidden /> Blocked — tap to unban</span>
                        </button>
                      ) : (
                        <button onClick={() => { const ip = visitorDetail!.technical.ip!; if (confirm(`Ban this visitor (IP ${ip})?\n\nThey won't be able to load the widget or chat on any of your sites. Use for spam / bots.`)) toggleIpBlock(ip, true) }}
                          className="w-full text-xs font-semibold px-3 py-2 rounded-lg border border-red-300 bg-red-50 text-red-700 hover:bg-red-100 transition-colors">
                          <span className="inline-flex items-center gap-1.5"><Ban size={12} strokeWidth={2} aria-hidden /> Ban visitor (spam / bot)</span>
                        </button>
                      )}
                      <p className="text-[10px] text-gray-500 mt-1.5 leading-relaxed">Blocks this IP across all sites — takes effect within a minute. Admins only.</p>
                    </section>
                  )}
                </div>
              )}
            </aside>
          )}
         </div>

          {/* ── My open chats tab bar (Zendesk-style) ──
              One tab per chat THIS agent is CURRENTLY handling: assigned to them
              AND either the visitor is live right now OR they exchanged a message
              in the last 15 min. This keeps last-night's finished chats out of the
              bar. Click to switch — reuses the single chat panel above, so only
              the open chat polls messages (no extra DB load). A red dot marks a
              chat whose last message is the customer's and isn't the one open. */}
          {(() => {
            const RECENT = 15 * 60 * 1000
            const liveIds = new Set(roleVisitors.map((v) => v.session_id))
            // The chat you're viewing always stays in the bar while it's open,
            // even if the visitor briefly goes idle, so it can't vanish mid-reply.
            const myChats = roleSessions
              .filter((s) => s.assignedTo === userEmail && (
                liveIds.has(s.session_id) ||
                s.session_id === selectedSession?.session_id ||
                Date.now() - new Date(s.last_at).getTime() <= RECENT))
              .sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime())
            if (myChats.length === 0) return null
            return (
              <div className="flex items-stretch gap-1 px-2 py-1.5 border-t border-gray-200 bg-gray-100 overflow-x-auto flex-shrink-0">
                <span className="flex items-center text-[10px] font-semibold uppercase tracking-wider text-gray-500 px-2 shrink-0 gap-1"><MessageSquare size={11} strokeWidth={2} aria-hidden /> My chats ({myChats.length})</span>
                {myChats.map((s) => {
                  const active = selectedSession?.session_id === s.session_id
                  const waiting = s.last_role === 'user' && !active
                  const accent = SITE_ACCENT[s.site_id] ?? '#6b7280'
                  return (
                    <div key={s.session_id} onClick={() => setSelectedSession(s)}
                      title={`${s.site_name} · ${s.session_id}`}
                      className={`group/tab flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-t-lg text-xs whitespace-nowrap border-t-2 transition-colors shrink-0 cursor-pointer ${active ? 'bg-white text-gray-900 font-semibold shadow-sm' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}
                      style={{ borderTopColor: active ? accent : 'transparent' }}>
                      {waiting && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />}
                      <SiteIcon siteId={s.site_id} name={s.site_name} size={16} accent={accent} />
                      <span className="max-w-[110px] truncate">{s.site_name}</span>
                      <button onClick={(e) => { e.stopPropagation(); closeChatTab(s.session_id, s.site_id) }}
                        title="Close chat (release it)"
                        className="w-4 h-4 inline-flex items-center justify-center rounded text-gray-400 hover:text-gray-800 hover:bg-gray-300 leading-none shrink-0">×</button>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      )}

      {/* ── VISITORS TAB (Zendesk-style history) ── */}
      {tab === 'visitors' && (() => {
        const now = Date.now()
        const isLiveV = (v: HistVisitor) => v.status === 'active' && now - new Date(v.last_seen).getTime() < 90000
        const q = histSearch.trim().toLowerCase()
        // Everything except the status filter — so the status dropdown can show
        // live/left counts that match what selecting each option would yield.
        const base = visitorHistory.filter((v) => {
          if (histSiteFilter && v.site_id !== histSiteFilter) return false
          if (histChatOnly && !v.has_chat) return false
          if (histHotOnly && !isHotVisitor(v)) return false
          if (histCountryFilter && (v.country ?? '') !== histCountryFilter) return false
          if (histDeviceFilter && (v.device_type ?? '') !== histDeviceFilter) return false
          if (q) {
            const hay = [v.page_title, v.page_url, v.referrer, v.country, v.city, v.site_name, v.browser, v.os]
              .filter(Boolean).join(' ').toLowerCase()
            if (!hay.includes(q)) return false
          }
          return true
        })
        const liveTotal = base.filter(isLiveV).length
        const filtered = base.filter((v) =>
          histStatusFilter === 'live' ? isLiveV(v) : histStatusFilter === 'left' ? !isLiveV(v) : true)
        const histSites = Array.from(new Map(visitorHistory.map((v) => [v.site_id, v.site_name])).entries())
        const histCountries = Array.from(new Set(visitorHistory.map((v) => v.country).filter(Boolean) as string[])).sort()
        const histDevices = Array.from(new Set(visitorHistory.map((v) => v.device_type).filter(Boolean) as string[])).sort()
        const liveCount = filtered.filter(isLiveV).length
        // Client-side pagination so a week of visitors doesn't render 1000+ rows.
        const PER_PAGE = 50
        const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
        const page = Math.min(histPage, pageCount - 1)
        const pageRows = filtered.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
        const anyFilter = histSiteFilter || histChatOnly || histStatusFilter !== 'all' || histCountryFilter || histDeviceFilter || histHotOnly || q
        let lastDay = ''
        return (
          <div className="max-w-5xl mx-auto px-5 py-6 animate-in">
            <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Visitors</h2>
                <p className="text-xs text-gray-500">Every widget session of the last 7 days — live and departed. {filtered.length} visitor{filtered.length !== 1 ? 's' : ''}{liveCount > 0 ? ` · ${liveCount} live now` : ''}</p>
              </div>
            </div>
            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap mb-4">
              <input value={histSearch} onChange={(e) => setHistFilter(setHistSearch)(e.target.value)} placeholder="Search page, referrer, country…"
                className="w-56 bg-white border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 placeholder-gray-400 focus:outline-none focus:border-blue-400" />
              <select value={histSiteFilter} onChange={(e) => setHistFilter(setHistSiteFilter)(e.target.value)}
                className="bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-gray-400">
                <option value="">All Sites</option>
                {histSites.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
              <select value={histStatusFilter} onChange={(e) => setHistFilter(setHistStatusFilter)(e.target.value as 'all' | 'live' | 'left')}
                className="bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-gray-400">
                <option value="all">All ({base.length})</option>
                <option value="live">Live now ({liveTotal})</option>
                <option value="left">Left ({base.length - liveTotal})</option>
              </select>
              <select value={histCountryFilter} onChange={(e) => setHistFilter(setHistCountryFilter)(e.target.value)}
                className="bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-gray-400">
                <option value="">All Countries</option>
                {histCountries.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select value={histDeviceFilter} onChange={(e) => setHistFilter(setHistDeviceFilter)(e.target.value)}
                className="bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-gray-400">
                <option value="">All Devices</option>
                {histDevices.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none">
                <input type="checkbox" checked={histChatOnly} onChange={(e) => setHistFilter(setHistChatOnly)(e.target.checked)} className="rounded accent-blue-500 cursor-pointer" />
                With chats only
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none" title="High buying intent: browsed several pages, stayed a while, or keeps coming back">
                <input type="checkbox" checked={histHotOnly} onChange={(e) => setHistFilter(setHistHotOnly)(e.target.checked)} className="rounded accent-orange-500 cursor-pointer" />
                <span className="inline-flex items-center gap-1.5"><Flame size={12} strokeWidth={2} aria-hidden /> Hot only</span>
              </label>
              {anyFilter && (
                <button onClick={() => { setHistSiteFilter(''); setHistChatOnly(false); setHistStatusFilter('all'); setHistCountryFilter(''); setHistDeviceFilter(''); setHistSearch(''); setHistHotOnly(false); setHistPage(0) }}
                  className="text-xs text-blue-600 hover:text-blue-700 font-medium">Clear filters</button>
              )}
            </div>

            {userRole === 'admin' && blockedIps.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                <span className="text-[11px] text-gray-500 font-medium"><span className="inline-flex items-center gap-1"><Ban size={11} strokeWidth={2} aria-hidden /> Blocked IPs:</span></span>
                {blockedIps.map((ip) => (
                  <button key={ip} onClick={() => { if (confirm(`Unblock ${ip}?`)) toggleIpBlock(ip, false) }}
                    className="text-[11px] font-mono text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5 hover:bg-red-100 transition-colors" title="Click to unblock">
                    {ip} <X size={11} strokeWidth={2} aria-hidden />
                  </button>
                ))}
              </div>
            )}

            {!visitorHistoryLoaded ? (
              <p className="text-sm text-gray-500 py-12 text-center">Loading visitors…</p>
            ) : filtered.length === 0 ? (
              <p className="text-sm text-gray-500 py-12 text-center">No visitors in the last 7 days{histChatOnly ? ' with chats' : ''}.</p>
            ) : (
              <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-50">
                {pageRows.map((v) => {
                  const day = dateDividerLabel(v.created_at)
                  const showDay = day !== lastDay
                  lastDay = day
                  const isLive = isLiveV(v)
                  const accent = SITE_ACCENT[v.site_id] ?? v.primary_color ?? '#2563eb'
                  const clickable = v.has_chat || isLive
                  const open = () => {
                    if (v.has_chat) {
                      openConversationBySession({ sessionId: v.session_id, siteId: v.site_id, siteName: v.site_name, lastAt: v.last_seen })
                    } else if (isLive) {
                      openVisitorSession(v); setTab('conversations')
                    }
                  }
                  return (
                    <div key={v.session_id}>
                      {showDay && (
                        <div className="px-4 py-1.5 bg-gray-100 border-b border-gray-200 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{day}</div>
                      )}
                      <div onClick={clickable ? open : undefined}
                        className={`px-4 py-2.5 border-b border-gray-100 flex items-start gap-3 ${clickable ? 'cursor-pointer hover:bg-gray-100 transition-colors' : ''}`}
                        style={{ borderLeft: `3px solid ${accent}` }}>
                        <span className="shrink-0 mt-0.5 text-gray-500" title={[v.device_type, v.browser, v.os].filter(Boolean).join(' · ')}><DeviceIcon d={v.device_type} size={16} /></span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-gray-900">{v.site_name}</span>
                            {isLive ? (
                              <span className="text-[10px] text-green-600 font-medium flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />live now</span>
                            ) : (
                              <span className="text-[10px] text-gray-500">left · {timeAgo(v.last_seen)}</span>
                            )}
                            {v.has_chat && (v.awaiting_reply ? (
                              <span className="text-[10px] font-bold text-red-700 bg-red-100 border border-red-300 rounded-full px-1.5 py-px" title="The visitor messaged and NO agent has replied yet — click to open and answer"><span className="inline-flex items-center gap-1"><AlertTriangle size={9} strokeWidth={2.5} aria-hidden /> no agent reply</span></span>
                            ) : (
                              <span className="text-[10px] font-semibold text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-1.5 py-px" title="This visitor chatted and an agent replied — click to open the conversation"><span className="inline-flex items-center gap-1"><MessageSquare size={9} strokeWidth={2.5} aria-hidden /> chatted</span></span>
                            ))}
                            {isHotVisitor(v) && <span className="text-[10px] font-bold text-orange-700 bg-orange-100 border border-orange-300 rounded-full px-1.5 py-px" title={`High buying intent: ${v.pages} page${v.pages !== 1 ? 's' : ''}, ${formatDuration(v.created_at, v.last_seen)} on site, ${v.visits} visit${v.visits !== 1 ? 's' : ''}`}><span className="inline-flex items-center gap-1"><Flame size={9} strokeWidth={2.5} aria-hidden /> hot</span></span>}
                            {v.visits > 1 && <span className="text-[9px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 rounded-full px-1.5 py-px inline-flex items-center gap-1" title={`${v.visits} visits — returning visitor`}><Repeat size={8} strokeWidth={2.5} aria-hidden /> {v.visits}</span>}
                            {v.pages > 1 && (
                              <button onClick={(e) => { e.stopPropagation(); setExpandedVisitor(expandedVisitor === v.session_id ? null : v.session_id) }}
                                className="text-[10px] font-medium text-gray-600 bg-gray-100 border border-gray-300 rounded-full px-1.5 py-px hover:bg-gray-200 transition-colors"
                                title="Show the pages this visitor browsed, in order">
                                <span className="inline-flex items-center gap-1"><FileText size={10} strokeWidth={2.5} aria-hidden /> {v.pages} pages {expandedVisitor === v.session_id ? <ChevronUp size={10} strokeWidth={2.5} aria-hidden /> : <ChevronDown size={10} strokeWidth={2.5} aria-hidden />}</span>
                              </button>
                            )}
                            {v.ip_blocked && (
                              <button onClick={(e) => { e.stopPropagation(); if (userRole === 'admin' && confirm(`Unblock ${v.ip}?`)) toggleIpBlock(v.ip!, false) }}
                                className="text-[10px] font-bold text-red-700 bg-red-100 border border-red-300 rounded-full px-1.5 py-px"
                                title={userRole === 'admin' ? `Blocked (${v.ip}) — click to unblock` : `This visitor's IP is blocked`}>
                                <span className="inline-flex items-center gap-1.5"><Ban size={10} strokeWidth={2.5} aria-hidden /> blocked</span>
                              </button>
                            )}
                            {userRole === 'admin' && v.ip && !v.ip_blocked && (
                              <button onClick={(e) => { e.stopPropagation(); if (confirm(`Block ${v.ip}?\n\nThis visitor won't see the widget or be able to chat on ANY of your sites until unblocked.`)) toggleIpBlock(v.ip!, true) }}
                                className="text-[10px] text-gray-400 hover:text-red-600 transition-colors"
                                title={`Block this visitor's IP (${v.ip}) — hides the widget and drops their messages on all sites`}>
                                <Ban size={12} strokeWidth={2} aria-hidden />
                              </button>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-700 truncate mt-0.5" title={v.page_url ?? undefined}>
                            <span className="text-gray-500">Viewed:</span> {viewingLabel(v)}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-gray-500 min-w-0">
                            {v.country && <><span className="truncate">{v.country}{v.city ? ` · ${v.city}` : ''}</span><span>·</span></>}
                            <span className="truncate" title={v.referrer ?? 'Direct'}>via {cleanReferrer(v.referrer)}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-[11px] text-gray-700">{formatTime(v.created_at)}</div>
                          <div className="text-[10px] text-gray-500 mt-0.5">on site {formatDuration(v.created_at, v.last_seen)}</div>
                        </div>
                      </div>
                      {/* Browsing trail (expanded via the pages chip) */}
                      {expandedVisitor === v.session_id && v.history.length > 0 && (
                        <div className="pl-12 pr-4 pb-2.5 bg-gray-100/60 border-b border-gray-100 animate-in">
                          {v.history.map((p, i) => (
                            <div key={i} className="flex items-center gap-2 text-[11px] py-0.5 min-w-0">
                              <span className="text-gray-400 tabular-nums shrink-0 w-4 text-right">{i + 1}.</span>
                              <a href={p.u ?? undefined} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                                className="text-gray-700 truncate hover:text-blue-700 hover:underline" title={p.u ?? undefined}>
                                {pageLabel({ url: p.u, title: p.t })}
                              </a>
                              <span className="text-gray-400 shrink-0">{formatTime(p.ts)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Pagination */}
            {filtered.length > PER_PAGE && (
              <div className="flex items-center justify-between mt-4">
                <span className="text-xs text-gray-500">
                  Showing {page * PER_PAGE + 1}–{Math.min((page + 1) * PER_PAGE, filtered.length)} of {filtered.length}
                </span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => setHistPage(Math.max(0, page - 1))} disabled={page === 0}
                    className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"><ChevronLeft size={12} strokeWidth={2} aria-hidden /> Prev</button>
                  <span className="text-xs text-gray-600 px-2">Page {page + 1} / {pageCount}</span>
                  <button onClick={() => setHistPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}
                    className="px-3 py-1.5 text-xs font-medium bg-white border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Next <ChevronRight size={12} strokeWidth={2} aria-hidden /></button>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── BILLING TAB ── */}
      {tab === 'billing' && (
        <div className="p-6 max-w-5xl mx-auto animate-in">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
            <div>
              <h2 className="text-base font-bold text-gray-900">Leads &amp; Billing</h2>
              <p className="text-gray-500 text-xs mt-0.5">Auto-captured leads (email provided) for tracked sites — for monthly client billing.</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setBillingMonth(shiftMonth(billingMonth, -1)); setBillingSiteFilter(null) }}
                className="px-2.5 py-1.5 text-xs text-gray-700 bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 transition-colors" title="Previous month"><ChevronLeft size={13} strokeWidth={2} aria-hidden /></button>
              <input type="month" value={billingMonth} max={currentMonth()} onChange={(e) => { if (e.target.value) { setBillingMonth(e.target.value); setBillingSiteFilter(null) } }}
                className="bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-gray-400 [color-scheme:dark]" />
              <button onClick={() => { const next = shiftMonth(billingMonth, 1); if (next <= currentMonth()) { setBillingMonth(next); setBillingSiteFilter(null) } }}
                disabled={billingMonth >= currentMonth()}
                className="px-2.5 py-1.5 text-xs text-gray-700 bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title="Next month"><ChevronRight size={13} strokeWidth={2} aria-hidden /></button>
              <button onClick={downloadBillingCsv} disabled={!billing || billing.leads.length === 0}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors disabled:opacity-40" style={{ backgroundColor: accentColor }}>
                <span className="inline-flex items-center gap-1.5"><Download size={13} strokeWidth={2} aria-hidden /> Download CSV</span>
              </button>
            </div>
          </div>

          {billingLoading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 3 }).map((_, i) => <Skel key={i} className="h-20" />)}</div>
              <Skel className="h-64 w-full" />
            </div>
          ) : (() => {
            const allLeads = billing?.leads ?? []
            const chatLeads = allLeads.filter((l) => l.source === 'chat')
            const quoteLeads = allLeads.filter((l) => l.source === 'quote')
            const checkoutLeads = allLeads.filter((l) => l.source === 'checkout')
            const activeLeads = billingLeadType === 'chat' ? chatLeads : billingLeadType === 'quote' ? quoteLeads : checkoutLeads
            // By-site breakdown recomputed for whichever type is showing, so the
            // numbers on screen always add up to what's in the table below —
            // the server's combined billing.bySite mixed both types together,
            // which was the confusing part.
            const bySiteMap: Record<string, { name: string; count: number }> = {}
            for (const l of activeLeads) {
              if (!bySiteMap[l.site_id]) bySiteMap[l.site_id] = { name: l.site_name, count: 0 }
              bySiteMap[l.site_id].count++
            }
            const bySiteActive = Object.entries(bySiteMap).sort((a, b) => b[1].count - a[1].count)
            const chatLeadsShown = billingSiteFilter ? chatLeads.filter((l) => l.site_id === billingSiteFilter) : chatLeads
            // The non-chat table branch renders whichever email-sourced type is
            // active — quote and checkout leads have the identical shape.
            const emailLeadsSrc = billingLeadType === 'checkout' ? checkoutLeads : quoteLeads
            const emailLeadsShown = billingSiteFilter ? emailLeadsSrc.filter((l) => l.site_id === billingSiteFilter) : emailLeadsSrc
            return (
            <>
              {/* Total + type breakdown */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3 mb-5">
                <div className="bg-gradient-to-br from-indigo-100 to-indigo-50 rounded-2xl p-5 border border-indigo-200">
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-2">Total leads this period</p>
                  <p className="text-[2.5rem] leading-none font-extrabold text-gray-900 tabular-nums">{billing?.total ?? 0}</p>
                  <p className="text-[11px] text-gray-500 mt-1">{chatLeads.length} chat + {quoteLeads.length} quote{checkoutLeads.length > 0 ? ` + ${checkoutLeads.length} checkout` : ''}</p>
                  {billing && (
                    <p className="text-[11px] text-gray-500 mt-2">
                      Last month: <span className="font-semibold text-gray-700">{billing.prevTotal}</span>
                      {billing.prevTotal > 0 && (
                        <span className={`ml-1.5 font-semibold ${billing.total >= billing.prevTotal ? 'text-green-600' : 'text-red-600'}`}>
                          <span className="inline-flex items-center gap-0.5">
                            {billing.total >= billing.prevTotal
                              ? <TrendingUp size={11} strokeWidth={2.5} aria-hidden />
                              : <TrendingDown size={11} strokeWidth={2.5} aria-hidden />}
                            {Math.abs(Math.round(((billing.total - billing.prevTotal) / billing.prevTotal) * 100))}%
                          </span>
                        </span>
                      )}
                    </p>
                  )}
                  {billing && billing.total > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {LEAD_STATUSES.map((s) => {
                        const n = billing.byStatus?.[s] ?? 0
                        if (n === 0) return null
                        return <span key={s} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize ${LEAD_STATUS_STYLE[s]}`}>{s} {n}</span>
                      })}
                    </div>
                  )}
                </div>

                {/* The number to actually invoice on — if the same customer
                    (same email, same site) shows up in both Chat and Quote,
                    that's one customer and gets charged once. The Chat/Quote
                    tiles below stay as raw per-channel totals on purpose;
                    this is the only place the overlap is collapsed. */}
                <div className="bg-gradient-to-br from-emerald-100 to-emerald-50 rounded-2xl p-5 border border-emerald-200">
                  <p className="text-emerald-800 text-[11px] font-semibold uppercase tracking-wide mb-2 inline-flex items-center gap-1.5"><CreditCard size={11} strokeWidth={2} aria-hidden /> Billable Leads</p>
                  {/* Fixed light-green card — use emerald text (NOT gray, which the
                      dark theme remaps to near-white and would vanish here). */}
                  <p className="text-[2.5rem] leading-none font-extrabold text-emerald-900 tabular-nums">{billing?.billable ?? 0}</p>
                  <p className="text-[11px] text-emerald-800 mt-1">
                    {billing && (billing.billableBase ?? billing.total) > billing.billable
                      ? `${(billing.billableBase ?? billing.total) - billing.billable} overlap${(billing.billableBase ?? billing.total) - billing.billable === 1 ? '' : 's'} removed — same customer, both channels`
                      : 'No overlap this period'}
                  </p>
                  <p className="text-[11px] text-emerald-700 mt-2">
                    Unique customers — this is what to charge per lead for.
                    {checkoutLeads.length > 0 ? ` Checkout orders (${checkoutLeads.length}) are counted in the total but never billed.` : ''}
                  </p>
                </div>

                {/* Chat / Quote tabs — click either to switch the table below */}
                <button onClick={() => { setBillingLeadType('chat'); setBillingSiteFilter(null) }}
                  className={`text-left rounded-2xl p-5 border transition-all ${billingLeadType === 'chat' ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-200' : 'bg-gray-100 border-gray-200 hover:border-gray-300'}`}>
                  <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 inline-flex items-center gap-1.5 ${billingLeadType === 'chat' ? 'text-blue-700' : 'text-gray-500'}`}><MessageSquare size={11} strokeWidth={2} aria-hidden /> Chat Leads</p>
                  {/* Plain gray text on purpose: these three tab cards get a dark
                      background in dark mode (see .bg-blue-50/.bg-amber-50/.bg-purple-50
                      in globals.css), so the theme's gray→near-white remap is what
                      keeps them readable. Only the Billable card, whose gradient
                      stays light in both themes, needs a hardcoded dark accent. */}
                  <p className="text-[2.5rem] leading-none font-extrabold text-gray-900 tabular-nums">{chatLeads.length}</p>
                  <p className="text-[11px] text-gray-500 mt-2">Someone typed their email while chatting on the widget.</p>
                </button>

                <button onClick={() => { setBillingLeadType('quote'); setBillingSiteFilter(null) }}
                  className={`text-left rounded-2xl p-5 border transition-all ${billingLeadType === 'quote' ? 'bg-amber-50 border-amber-300 ring-2 ring-amber-200' : 'bg-gray-100 border-gray-200 hover:border-gray-300'}`}>
                  <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 inline-flex items-center gap-1.5 ${billingLeadType === 'quote' ? 'text-amber-700' : 'text-gray-500'}`}><Mail size={11} strokeWidth={2} aria-hidden /> Quote Leads</p>
                  <p className="text-[2.5rem] leading-none font-extrabold text-gray-900 tabular-nums">{quoteLeads.length}</p>
                  <p className="text-[11px] text-gray-500 mt-2">From your Gmail-labeled custom-quote-request emails.</p>
                </button>

                {/* Cart orders. Deliberately NOT part of Billable above — these
                    are completed sales, counted so the period total is honest
                    but never charged for as generated leads. */}
                <button onClick={() => { setBillingLeadType('checkout'); setBillingSiteFilter(null) }}
                  className={`text-left rounded-2xl p-5 border transition-all ${billingLeadType === 'checkout' ? 'bg-purple-50 border-purple-300 ring-2 ring-purple-200' : 'bg-gray-100 border-gray-200 hover:border-gray-300'}`}>
                  <p className={`text-[11px] font-semibold uppercase tracking-wide mb-2 inline-flex items-center gap-1.5 ${billingLeadType === 'checkout' ? 'text-purple-700' : 'text-gray-500'}`}><ShoppingCart size={11} strokeWidth={2} aria-hidden /> Checkout Leads</p>
                  <p className="text-[2.5rem] leading-none font-extrabold text-gray-900 tabular-nums">{checkoutLeads.length}</p>
                  <p className="text-[11px] text-gray-500 mt-2">WooCommerce cart orders — counted in the total, not billed.</p>
                </button>
              </div>

              {/* By site (for whichever tab is active) — click a site to
                  filter the table below to just that site. Each card wears
                  the site's own accent color (SITE_ACCENT, same as the rest
                  of the dashboard) with a proportional bar so relative
                  volume reads at a glance, not just the raw number. */}
              <div className="bg-gray-100 rounded-2xl p-5 border border-gray-200 mb-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide">
                    By site — <span className="inline-flex items-center gap-1 align-middle">{billingLeadType === 'chat'
                      ? <><MessageSquare size={11} strokeWidth={2} aria-hidden /> Chat</>
                      : billingLeadType === 'quote'
                        ? <><Mail size={11} strokeWidth={2} aria-hidden /> Quote</>
                        : <><ShoppingCart size={11} strokeWidth={2} aria-hidden /> Checkout</>}</span>
                  </p>
                  {billingSiteFilter && (
                    <button onClick={() => setBillingSiteFilter(null)}
                      className="text-[11px] font-medium text-indigo-700 hover:text-indigo-800 hover:underline"><span className="inline-flex items-center gap-1">Clear filter <X size={11} strokeWidth={2} aria-hidden /></span></button>
                  )}
                </div>
                {bySiteActive.length === 0 ? (
                  <p className="text-xs text-gray-500">No {billingLeadType} leads in this period.</p>
                ) : (() => {
                  const maxCount = Math.max(...bySiteActive.map(([, info]) => info.count))
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {bySiteActive.map(([siteId, info]) => {
                        const accent = SITE_ACCENT[siteId] ?? '#6366f1'
                        const selected = billingSiteFilter === siteId
                        const pct = Math.max(8, Math.round((info.count / maxCount) * 100))
                        return (
                          <button key={siteId} onClick={() => setBillingSiteFilter(selected ? null : siteId)}
                            style={selected ? { backgroundColor: `${accent}14`, borderColor: accent, boxShadow: `0 0 0 1px ${accent}` } : undefined}
                            className={`group text-left rounded-xl px-3.5 py-3 border transition-all ${selected ? '' : 'bg-white border-gray-200 hover:border-gray-300 hover:-translate-y-0.5 hover:shadow-sm'}`}>
                            <div className="flex items-center justify-between gap-2 mb-1.5">
                              <span className="flex items-center gap-2 min-w-0">
                                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: accent }} />
                                <span className={`text-sm truncate ${selected ? 'font-semibold' : 'text-gray-800 group-hover:text-gray-900'}`} style={selected ? { color: accent } : undefined}>{info.name}</span>
                              </span>
                              <span className="text-lg font-extrabold tabular-nums flex-shrink-0" style={{ color: selected ? accent : '#111827' }}>{info.count}</span>
                            </div>
                            <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
                              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: accent, opacity: selected ? 1 : 0.55 }} />
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>

              {/* Detail table — columns differ by tab: Chat has a real
                  conversation (Source/Agent/View chat); Quote has no chat
                  session, so it shows the raw email text instead. Filtered
                  down to the selected site, if any. */}
              <div className="bg-gray-100 rounded-2xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  {billingLeadType === 'chat' ? (
                    <table className="w-full text-sm min-w-[1000px]">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-100">
                          {['Email', 'Name', 'Phone', 'Site', 'Source', 'Agent', 'Status', 'Date Captured', ''].map((h) => (
                            <th key={h} className="text-left px-4 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {chatLeadsShown.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="text-center py-10">
                              <div className="flex flex-col items-center">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center mb-2 text-gray-500"><MessageSquare size={18} strokeWidth={2} aria-hidden /></div>
                                <p className="text-gray-700 text-sm font-medium">No chat leads this period{billingSiteFilter ? ' for this site' : ''}</p>
                                <p className="text-gray-500 text-xs mt-0.5">Recorded when a visitor shares an email while chatting on a tracked site.</p>
                              </div>
                            </td>
                          </tr>
                        ) : chatLeadsShown.map((l) => (
                          <tr key={l.session_id} onClick={() => openLeadRecord(l.session_id)} title="Open this lead's record"
                            className="border-b border-gray-100 hover:bg-gray-100 transition-colors cursor-pointer">
                            <td className="px-4 py-3 whitespace-nowrap">
                              <a href={leadRecordHref(l.session_id)} className="text-blue-700 hover:underline"
                                onClick={(e) => e.stopPropagation()}>
                                {l.email ?? <span className="text-gray-500 italic">Marked as lead</span>}
                              </a>
                            </td>
                            <td className="px-4 py-3 text-gray-800 whitespace-nowrap">{l.name || <span className="text-gray-500">—</span>}</td>
                            <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{l.phone || <span className="text-gray-500">—</span>}</td>
                            <td className="px-4 py-3 whitespace-nowrap"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 border border-gray-300 text-gray-700">{l.site_name}</span></td>
                            <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap" title={l.referrer ?? 'Direct'}>
                              {l.country ? <span>{l.country}</span> : <span className="text-gray-400">—</span>}
                              <span className="text-gray-400"> · </span>{cleanReferrer(l.referrer)}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-700 whitespace-nowrap" title={l.agent ?? undefined}>
                              {l.agent ? l.agent.split('@')[0] : <span className="text-gray-400">—</span>}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <select value={l.status} onChange={(e) => setLeadStatus(l, e.target.value as LeadStatus)}
                                className={`text-[11px] font-semibold px-2 py-1 rounded-full border capitalize cursor-pointer focus:outline-none ${LEAD_STATUS_STYLE[l.status]}`}>
                                {LEAD_STATUSES.map((s) => <option key={s} value={s} className="bg-white text-gray-800 capitalize">{s}</option>)}
                              </select>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDateTime(l.captured_at)}</td>
                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <a href={conversationHref(l.session_id, l.site_id)} className="text-xs text-indigo-700 hover:text-indigo-800 hover:underline"
                                onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); openConversation(l) }}>View chat →</a>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full text-sm min-w-[1000px]">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-100">
                          {[...['Email', 'Name', 'Phone', 'Site', 'Message', 'Status', 'Date Captured'], ...(userRole === 'admin' ? [''] : [])].map((h, i) => (
                            <th key={h || i} className="text-left px-4 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {emailLeadsShown.length === 0 ? (
                          <tr>
                            <td colSpan={userRole === 'admin' ? 8 : 7} className="text-center py-10">
                              <div className="flex flex-col items-center">
                                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center mb-2 text-gray-500">{billingLeadType === 'checkout' ? <ShoppingCart size={18} strokeWidth={2} aria-hidden /> : <Mail size={18} strokeWidth={2} aria-hidden />}</div>
                                <p className="text-gray-700 text-sm font-medium">No {billingLeadType} leads this period{billingSiteFilter ? ' for this site' : ''}</p>
                                <p className="text-gray-500 text-xs mt-0.5">{billingLeadType === 'checkout' ? 'Sent by your Gmail Apps Script when a WooCommerce order email carries the checkout label.' : 'Sent by your Gmail Apps Script when a labeled quote-request email arrives.'}</p>
                              </div>
                            </td>
                          </tr>
                        ) : emailLeadsShown.map((l) => (
                          <tr key={l.session_id} onClick={() => openLeadRecord(l.session_id)} title="Open this lead's record"
                            className="border-b border-gray-100 hover:bg-gray-100 transition-colors cursor-pointer">
                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <a href={`mailto:${l.email}`} className="text-blue-700 hover:underline">{l.email}</a>
                            </td>
                            <td className="px-4 py-3 text-gray-800 whitespace-nowrap">{l.name || <span className="text-gray-500">—</span>}</td>
                            <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{l.phone || <span className="text-gray-500">—</span>}</td>
                            <td className="px-4 py-3 whitespace-nowrap"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 border border-gray-300 text-gray-700">{l.site_name}</span></td>
                            {/* The row opens the record now; the full-message
                                popup stays one click away, right here. */}
                            <td onClick={(e) => { e.stopPropagation(); setViewQuote(l) }} title="View the full quote message"
                              className="px-4 py-3 text-gray-600 max-w-[220px] truncate hover:text-gray-900">{l.quote_message || <span className="text-gray-400">—</span>}</td>
                            <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <select value={l.status} onChange={(e) => setLeadStatus(l, e.target.value as LeadStatus)}
                                className={`text-[11px] font-semibold px-2 py-1 rounded-full border capitalize cursor-pointer focus:outline-none ${LEAD_STATUS_STYLE[l.status]}`}>
                                {LEAD_STATUSES.map((s) => <option key={s} value={s} className="bg-white text-gray-800 capitalize">{s}</option>)}
                              </select>
                            </td>
                            <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDateTime(l.captured_at)}</td>
                            {userRole === 'admin' && (
                              <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                                {confirmQuoteDeleteId === l.session_id ? (
                                  <div className="flex items-center gap-1">
                                    <span className="text-xs text-gray-700">Delete?</span>
                                    <button onClick={() => deleteQuoteLead(l.session_id)} disabled={deletingQuoteId === l.session_id}
                                      className="text-xs text-red-600 hover:text-red-700 font-semibold">{deletingQuoteId === l.session_id ? '…' : 'Yes'}</button>
                                    <span className="text-xs text-gray-500 mx-0.5">·</span>
                                    <button onClick={() => setConfirmQuoteDeleteId(null)} className="text-xs text-gray-500 hover:text-gray-600">No</button>
                                  </div>
                                ) : (
                                  <button onClick={() => setConfirmQuoteDeleteId(l.session_id)}
                                    className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-gray-200 rounded-lg transition-colors" title="Delete this quote lead"><Trash2 size={13} strokeWidth={2} aria-hidden /></button>
                                )}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </>
            )
          })()}
        </div>
      )}

      {/* Recent Leads (Overview tab): a Quote-type row has no chat session,
          so clicking it shows its full details here instead. */}
      {viewOverviewLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setViewOverviewLead(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl border border-gray-200 shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200">
              <div className="min-w-0">
                <LeadSourceBadge message={viewOverviewLead.message} className="inline-block mb-1.5" />
                <p className="text-sm font-semibold text-gray-900 truncate">{viewOverviewLead.name || viewOverviewLead.email}</p>
                <p className="text-xs text-gray-500 truncate">
                  {viewOverviewLead.email} · {(roleSites.find((s) => s.site_id === viewOverviewLead.site_id)?.name) ?? viewOverviewLead.site_id}
                  {viewOverviewLead.created_at ? ` · ${formatDateTime(viewOverviewLead.created_at)}` : ''}
                </p>
              </div>
              <button onClick={() => setViewOverviewLead(null)} className="text-gray-400 hover:text-gray-700 leading-none flex-shrink-0" title="Close"><X size={15} strokeWidth={2} aria-hidden /></button>
            </div>
            <div className="px-5 py-4 overflow-y-auto">
              <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{stripQuoteTag(viewOverviewLead.message) || 'No message text.'}</p>
            </div>
            <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
              {viewOverviewLead.email && (
                <a href={`mailto:${viewOverviewLead.email}`} className="px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors" style={{ backgroundColor: accentColor }}>Reply by email</a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Daily performance table: click a day's Chats count to see exactly
          those sessions instead of just a number. Each row jumps straight
          into that conversation on the Conversations tab. */}
      {viewDayChats && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setViewDayChats(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl border border-gray-200 shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">
                  {new Date(`${viewDayChats.date}T00:00:00Z`).toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                </p>
                <p className="text-xs text-gray-500">{viewDayChats.chatSessions.length} chat{viewDayChats.chatSessions.length !== 1 ? 's' : ''}</p>
              </div>
              <button onClick={() => setViewDayChats(null)} className="text-gray-400 hover:text-gray-700 leading-none flex-shrink-0" title="Close"><X size={15} strokeWidth={2} aria-hidden /></button>
            </div>
            <div className="overflow-y-auto">
              {viewDayChats.chatSessions.map((cs, i) => {
                const site = sites.find((s) => s.site_id === cs.site_id)
                const accent = SITE_ACCENT[cs.site_id] ?? '#6b7280'
                return (
                  <a key={cs.session_id + i} href={conversationHref(cs.session_id, cs.site_id)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey) return // let the browser open a new tab/window
                      e.preventDefault()
                      openConversationBySession({ sessionId: cs.session_id, siteId: cs.site_id, siteName: site?.name })
                      setTab('conversations')
                      setViewDayChats(null)
                    }}
                    className="w-full text-left px-5 py-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-100 transition-colors flex items-center justify-between gap-2"
                    style={{ borderLeft: `3px solid ${accent}` }}>
                    <span className="text-sm text-gray-800 truncate">{site?.name ?? cs.site_id}</span>
                    <span className="text-xs text-indigo-700 flex-shrink-0">View chat →</span>
                  </a>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Per-agent breakdown for a single day: who picked up how many chats. */}
      {viewDayAgents && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setViewDayAgents(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl border border-gray-200 shadow-xl w-full max-w-sm max-h-[80vh] flex flex-col">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">
                  {new Date(`${viewDayAgents.date}T00:00:00Z`).toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}
                </p>
                <p className="text-xs text-gray-500">Chats picked up per agent · {viewDayAgents.picked} total</p>
              </div>
              <button onClick={() => setViewDayAgents(null)} className="text-gray-400 hover:text-gray-700 leading-none flex-shrink-0" title="Close"><X size={15} strokeWidth={2} aria-hidden /></button>
            </div>
            <div className="overflow-y-auto">
              {(viewDayAgents.byAgent ?? []).map((a, i) => (
                <div key={a.email + i} className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-100 last:border-b-0">
                  <span className="text-sm text-gray-800 truncate">{agentShort(a.email)}<span className="text-gray-400 text-xs ml-1.5 hidden sm:inline">{a.email}</span></span>
                  <span className="text-sm font-semibold text-green-700 tabular-nums flex-shrink-0 bg-green-100 rounded-full px-2.5 py-0.5">{a.picked}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Full quote-email text — the table only shows a truncated preview.
          Prev/Next walk the same filtered list currently on screen (site
          filter included), so browsing several leads doesn't mean closing
          and reopening the modal each time. */}
      {viewQuote && (() => {
        const navList = (billing?.leads ?? [])
          .filter((l) => l.source === viewQuote.source)
          .filter((l) => !billingSiteFilter || l.site_id === billingSiteFilter)
        const idx = navList.findIndex((l) => l.session_id === viewQuote.session_id)
        const hasPrev = idx > 0
        const hasNext = idx !== -1 && idx < navList.length - 1
        return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setViewQuote(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl border border-gray-200 shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200">
              <div className="min-w-0">
                <p className={`text-[11px] font-semibold rounded-full px-2 py-0.5 inline-block mb-1.5 border ${viewQuote.source === 'checkout' ? 'text-purple-700 bg-purple-100 border-purple-200' : 'text-amber-700 bg-amber-100 border-amber-200'}`}><span className="inline-flex items-center gap-1.5">{viewQuote.source === 'checkout'
                  ? <><ShoppingCart size={11} strokeWidth={2} aria-hidden /> Checkout</>
                  : <><Mail size={11} strokeWidth={2} aria-hidden /> Quote</>}</span></p>
                <p className="text-sm font-semibold text-gray-900 truncate">{viewQuote.name || viewQuote.email}</p>
                <p className="text-xs text-gray-500 truncate">{viewQuote.email} · {viewQuote.site_name} · {formatDateTime(viewQuote.captured_at)}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {idx !== -1 && <span className="text-[11px] text-gray-400 tabular-nums mr-1">{idx + 1}/{navList.length}</span>}
                <button onClick={() => hasPrev && setViewQuote(navList[idx - 1])} disabled={!hasPrev}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors" title="Previous lead">‹</button>
                <button onClick={() => hasNext && setViewQuote(navList[idx + 1])} disabled={!hasNext}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors" title="Next lead">›</button>
                <button onClick={() => setViewQuote(null)} className="text-gray-400 hover:text-gray-700 leading-none ml-1.5 px-1" title="Close"><X size={15} strokeWidth={2} aria-hidden /></button>
              </div>
            </div>
            <div className="px-5 py-4 overflow-y-auto">
              <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{viewQuote.quote_message || 'No message text.'}</p>
            </div>
            <div className="px-5 py-3 border-t border-gray-200 flex justify-end gap-2">
              <a href={`mailto:${viewQuote.email}`} className="px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-colors" style={{ backgroundColor: accentColor }}>Reply by email</a>
            </div>
          </div>
        </div>
        )
      })()}

      {tab === 'performance' && (
        <div className="p-6 max-w-6xl mx-auto animate-in">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
            <div>
              <h2 className="text-base font-bold text-gray-900">Agent Performance</h2>
              <p className="text-gray-500 text-xs mt-0.5">Per-agent responsiveness &amp; accountability for {WORKSPACE_LABEL[workspace]} — who&apos;s replying, who&apos;s slow, who&apos;s missing chats.</p>
            </div>
            <div className="flex items-center gap-2">
              {/* The full month-end report (all three breakdowns, CSV + PDF)
                  lives on its own route so this tab stays a quick daily view. */}
              <a href="/reports" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); router.push('/reports') } }}
                title="Full month-end report with per-agent, per-site and daily breakdowns, plus CSV and PDF export"
                className="px-2.5 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                Month-end report
              </a>
              <button onClick={() => setPerfMonth(shiftMonth(perfMonth, -1))}
                className="px-2.5 py-1.5 text-xs text-gray-700 bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 transition-colors" title="Previous month"><ChevronLeft size={13} strokeWidth={2} aria-hidden /></button>
              <input type="month" value={perfMonth} max={currentMonth()} onChange={(e) => e.target.value && setPerfMonth(e.target.value)}
                className="bg-gray-100 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none focus:border-gray-400 [color-scheme:dark]" />
              <button onClick={() => { const next = shiftMonth(perfMonth, 1); if (next <= currentMonth()) setPerfMonth(next) }}
                disabled={perfMonth >= currentMonth()}
                className="px-2.5 py-1.5 text-xs text-gray-700 bg-gray-100 border border-gray-200 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title="Next month"><ChevronRight size={13} strokeWidth={2} aria-hidden /></button>
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
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-5">
                <div className="bg-gray-100 rounded-2xl p-4 border border-gray-200">
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Conversations</p>
                  <p className="text-3xl leading-none font-extrabold text-gray-900 tabular-nums">{perf?.summary.totalConversations ?? 0}</p>
                </div>
                {(() => {
                  const total = perf?.summary.totalConversations ?? 0
                  const answered = perf?.summary.answeredConversations ?? 0
                  const pct = total ? Math.round((answered / total) * 100) : 0
                  const bad = total > 0 && pct < 80
                  return (
                    <div className={`rounded-2xl p-4 border ${bad ? 'bg-red-100 border-red-300' : 'bg-gray-100 border-gray-200'}`} title="Conversations that got at least one agent reply">
                      <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Answered</p>
                      <p className={`text-3xl leading-none font-extrabold tabular-nums ${bad ? 'text-red-700' : 'text-gray-900'}`}>{pct}%</p>
                      <p className="text-[10px] text-gray-500 mt-1">{answered} of {total}</p>
                    </div>
                  )
                })()}
                <div className="bg-gray-100 rounded-2xl p-4 border border-gray-200">
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Leads</p>
                  <p className="text-3xl leading-none font-extrabold text-emerald-700 tabular-nums">{perf?.summary.totalLeads ?? 0}</p>
                </div>
                <div className="bg-gray-100 rounded-2xl p-4 border border-gray-200">
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Avg response</p>
                  <p className="text-3xl leading-none font-extrabold text-gray-900 tabular-nums">{formatMs(perf?.summary.avgResponseMs)}</p>
                </div>
                <div className={`rounded-2xl p-4 border ${(perf?.summary.totalMissed ?? 0) > 0 ? 'bg-amber-50 border-amber-300' : 'bg-gray-100 border-gray-200'}`}>
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Missed (slow)</p>
                  <p className={`text-3xl leading-none font-extrabold tabular-nums ${(perf?.summary.totalMissed ?? 0) > 0 ? 'text-amber-700' : 'text-gray-900'}`}>{perf?.summary.totalMissed ?? 0}</p>
                </div>
                <div className={`rounded-2xl p-4 border ${(perf?.summary.totalUnanswered ?? 0) > 0 ? 'bg-red-100 border-red-300' : 'bg-gray-100 border-gray-200'}`}>
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Unanswered</p>
                  <p className={`text-3xl leading-none font-extrabold tabular-nums ${(perf?.summary.totalUnanswered ?? 0) > 0 ? 'text-red-700' : 'text-gray-900'}`}>{perf?.summary.totalUnanswered ?? 0}</p>
                </div>
                <div className={`rounded-2xl p-4 border ${(perf?.summary.ignoredVisitors ?? 0) > 0 ? 'bg-red-100 border-red-300' : 'bg-gray-100 border-gray-200'}`}
                  title="Visitors who came to a site this period and left without a single message — they never typed AND no agent ever reached out">
                  <p className="text-gray-500 text-[11px] font-medium uppercase tracking-wide mb-1.5">Ignored visitors</p>
                  <p className={`text-3xl leading-none font-extrabold tabular-nums ${(perf?.summary.ignoredVisitors ?? 0) > 0 ? 'text-red-700' : 'text-gray-900'}`}>{perf?.summary.ignoredVisitors ?? 0}</p>
                </div>
              </div>

              {/* Attribution status — historical-estimate vs accurate-going-forward */}
              {perf && perf.summary.totalReplies > 0 && perf.unattributedReplies > 0 && (
                <div className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-[11px] text-gray-500 flex items-start gap-2">
                  <span className="text-gray-500 mt-px shrink-0"><Info size={13} strokeWidth={2} aria-hidden /></span>
                  <span>
                    <span className="text-gray-700 font-medium">{perf.summary.attributedReplies}</span> of <span className="text-gray-700 font-medium">{perf.summary.totalReplies}</span> agent replies this period are attributed to a specific agent.
                    The remaining <span className="text-gray-700 font-medium">{perf.unattributedReplies}</span> were sent before per-agent tracking was added, so they aren&apos;t counted in the per-agent rows below (the workspace totals above include everything). Attribution is exact going forward.
                  </span>
                </div>
              )}

              {/* Per-agent table */}
              <div className="bg-gray-100 rounded-2xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[720px]">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-100">
                        {['Agent', 'Conversations', 'Proactive', 'Replies', 'Leads', 'Avg response', 'Slow replies', 'Dropped', 'Last active'].map((h, i) => (
                          <th key={h} className={`px-4 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(perf?.agents ?? []).length === 0 ? (
                        <tr>
                          <td colSpan={9} className="text-center py-10">
                            <div className="flex flex-col items-center">
                              <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center mb-2 text-gray-500"><Users size={18} strokeWidth={2} aria-hidden /></div>
                              <p className="text-gray-700 text-sm font-medium">No agents in this workspace</p>
                              <p className="text-gray-500 text-xs mt-0.5">Add members to see per-agent performance.</p>
                            </div>
                          </td>
                        </tr>
                      ) : perf!.agents.map((a) => {
                        const idle = a.replies === 0
                        const slowAvg = a.avgResponseMs !== null && a.avgResponseMs > 120000
                        return (
                          <tr key={a.id} className={`border-b border-gray-100 transition-colors ${idle ? 'opacity-60' : 'hover:bg-gray-100'}`}>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="flex items-center gap-2">
                                <span className="text-gray-800">{a.email}</span>
                                {a.builtin && <span className="text-[9px] px-1.5 py-px rounded-full bg-purple-100 text-purple-700 font-semibold uppercase tracking-wide">admin</span>}
                                {a.former && <span className="text-[9px] px-1.5 py-px rounded-full bg-gray-200 text-gray-500 font-semibold uppercase tracking-wide">former</span>}
                                {idle && <span className="text-[9px] px-1.5 py-px rounded-full bg-amber-100 text-amber-700 font-semibold uppercase tracking-wide">no replies</span>}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right text-gray-800 tabular-nums">{a.handled}</td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {a.proactive > 0
                                ? <span className="inline-block px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold" title="Chats this agent started themselves by messaging a browsing visitor first">{a.proactive}</span>
                                : <span className="text-gray-500">0</span>}
                            </td>
                            <td className="px-4 py-3 text-right text-gray-800 tabular-nums">{a.replies}</td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {a.leads > 0
                                ? <span className="inline-block px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">{a.leads}</span>
                                : <span className="text-gray-500">0</span>}
                            </td>
                            <td className={`px-4 py-3 text-right tabular-nums font-medium ${slowAvg ? 'text-red-700' : idle ? 'text-gray-500' : 'text-emerald-700'}`}>{formatMs(a.avgResponseMs)}</td>
                            <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                              {a.slowReplies > 0
                                ? <span className="inline-block px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold" title={`${a.slowReplies} of ${a.measuredReplies} measured replies took over 2 minutes`}>{a.slowReplies}{a.measuredReplies > 0 ? ` (${Math.round((a.slowReplies / a.measuredReplies) * 100)}%)` : ''}</span>
                                : <span className="text-gray-500">0</span>}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {a.dropped > 0
                                ? <span className="inline-block px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-bold" title="Conversations where this agent replied last, the visitor followed up, and nobody answered">{a.dropped}</span>
                                : <span className="text-gray-500">0</span>}
                            </td>
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              {a.lastReplyAt
                                ? <span className={Date.now() - new Date(a.lastReplyAt).getTime() > 24 * 60 * 60 * 1000 ? 'text-amber-700 font-medium' : 'text-gray-600'} title={formatDateTime(a.lastReplyAt)}>{timeAgo(a.lastReplyAt)}</span>
                                : <span className="text-gray-400">—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Daily pickup table: visitors that came each day vs how many the
                  team actually engaged (replied to or proactively messaged). */}
              {(perf?.daily ?? []).length > 0 && (
                <div className="bg-gray-100 rounded-2xl border border-gray-200 overflow-hidden mt-5">
                  <div className="px-4 pt-4 pb-1">
                    <h3 className="text-sm font-bold text-gray-900">Daily performance</h3>
                    <p className="text-[11px] text-gray-500 mt-0.5">Per day (Pakistan time): visitors that came, how many the team picked up (replied or proactively messaged), and how many got no contact at all.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-100">
                          {['Date', 'Visitors', 'Chats', 'Picked up', 'Not picked', 'Pickup %'].map((h, i) => (
                            <th key={h} className={`px-4 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {perf!.daily.map((d) => {
                          const isToday = d.date === new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10)
                          const pct = d.visitors ? Math.round((d.picked / d.visitors) * 100) : 0
                          const label = new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
                          return (
                            <tr key={d.date} className={`border-b border-gray-100 ${isToday ? 'bg-blue-50/60' : ''}`}>
                              <td className="px-4 py-2.5 text-gray-800 whitespace-nowrap">{label}{isToday && <span className="ml-1.5 text-[9px] font-semibold text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-1.5 py-px">today</span>}</td>
                              <td className="px-4 py-2.5 text-right text-gray-800 tabular-nums">{d.visitors}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {d.chats > 0
                                  ? <button onClick={() => setViewDayChats(d)} className="text-blue-700 hover:underline hover:text-blue-800 font-medium" title="View these chats">{d.chats}</button>
                                  : <span className="text-gray-800">0</span>}
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {d.picked > 0
                                  ? (d.byAgent && d.byAgent.length > 0
                                      ? <button onClick={() => setViewDayAgents(d)} title="See which agent picked up how many" className="inline-block px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold hover:bg-green-200">{d.picked} ›</button>
                                      : <span className="inline-block px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-semibold">{d.picked}</span>)
                                  : <span className="text-gray-500">0</span>}
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                {d.notPicked > 0
                                  ? <span className={`font-semibold ${d.picked === 0 ? 'text-red-600' : 'text-gray-700'}`}>{d.notPicked}</span>
                                  : <span className="text-gray-500">0</span>}
                              </td>
                              <td className={`px-4 py-2.5 text-right tabular-nums font-semibold ${pct === 0 ? 'text-red-600' : pct < 10 ? 'text-amber-700' : 'text-green-700'}`}>{pct}%</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Attendance register: when each agent was online, per PKT day. */}
              {attendance.length > 0 && (
                <div className="bg-gray-100 rounded-2xl border border-gray-200 overflow-hidden mt-5">
                  <div className="px-4 pt-4 pb-1">
                    <h3 className="text-sm font-bold text-gray-900">Agent attendance</h3>
                    <p className="text-[11px] text-gray-500 mt-0.5">Dashboard online time per agent per day (Pakistan time) — when they signed on, when they were last seen, and total hours with the dashboard open.</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-100">
                          {['Date', 'Agent', 'First seen', 'Last seen', 'Online time'].map((h, i) => (
                            <th key={h} className={`px-4 py-2.5 text-[11px] text-gray-500 font-semibold uppercase tracking-wide whitespace-nowrap ${i < 2 ? 'text-left' : 'text-right'}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {attendance.map((a, i) => {
                          const showDate = i === 0 || attendance[i - 1].date !== a.date
                          const label = new Date(`${a.date}T00:00:00Z`).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
                          const hours = a.secs >= 3600 ? `${Math.floor(a.secs / 3600)}h ${Math.round((a.secs % 3600) / 60)}m` : `${Math.round(a.secs / 60)}m`
                          return (
                            <tr key={`${a.date}|${a.email}`} className="border-b border-gray-100">
                              <td className="px-4 py-2.5 text-gray-800 whitespace-nowrap">{showDate ? label : ''}</td>
                              <td className="px-4 py-2.5 text-gray-700 whitespace-nowrap">{a.email.split('@')[0]}</td>
                              <td className="px-4 py-2.5 text-right text-gray-600 text-xs whitespace-nowrap">{formatTime(a.first)}</td>
                              <td className="px-4 py-2.5 text-right text-gray-600 text-xs whitespace-nowrap">{formatTime(a.last)}</td>
                              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-gray-800">{hours}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="px-4 py-2 text-[10px] text-gray-400">Tracking starts today — days before this feature shipped have no data. An agent only accrues time while their dashboard tab is open.</p>
                </div>
              )}

              <p className="text-gray-500 text-[11px] mt-3 leading-relaxed">
                <span className="text-gray-500 font-medium">How to read this:</span> Avg response is the time between a visitor&apos;s message and the agent&apos;s reply.
                A reply is &quot;slow&quot; if it took longer than 2 minutes. <span className="text-emerald-700">Leads</span> = conversations the agent handled that captured a lead.
                <span className="text-red-600"> Dropped</span> = the agent replied last in a conversation, the visitor followed up, and nobody ever answered — owned by that agent.
                <span className="text-gray-700"> Last active</span> = the agent&apos;s most recent reply (amber if over a day ago).
                <span className="text-amber-700"> Missed</span> = a visitor messaged while the bot was off and no agent replied within 2 minutes.
                <span className="text-red-600"> Unanswered</span> = a conversation still waiting on its first agent reply.
                <span className="text-red-600"> Ignored visitors</span> = visitors who came and left without a single message — they never typed and no agent ever reached out.
                <span className="text-blue-700"> Proactive</span> = chats the agent started themselves by messaging a browsing visitor first.
                Missed, unanswered &amp; ignored are workspace-wide (no single agent owns them); <span className="text-gray-700">Answered %</span> is the share of conversations that got at least one agent reply.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
