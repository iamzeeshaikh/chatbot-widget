// The two separate dashboards ("workspaces"). Every member belongs to exactly
// one workspace and can never see the other. Site groupings mirror the original
// hardcoded dashboard split.

export type Workspace = 'sports' | 'packaging'

// Active packaging-workspace sites. The other site configs (zeepack,
// burgersleeves, leadgen) still exist in the Supabase sites table — they're
// just removed from this grouping so they don't show in the packaging
// dashboard. Re-add their ids here to bring them back.
//
// zeecustomboxes is QUOTE-TRACKING ONLY: no widget.js is installed there (chat
// is off, no footer edits were made) — it's registered purely so its
// /api/quote-intake leads (see lib/quoteintake.ts) have a home in the Billing
// tab for month-end payout reconciliation with the buying partner.
export const PACKAGING_SITES = [
  'shopcardboardboxes', 'thetubepackaging', 'kraftboxpack', 'thecandlepackaging', 'theburgerboxes', 'smallfoodboxes', 'zeecustomboxes', 'thepapercups',
  // 2026-07 roster. thepapercups (above) also gets the widget now, so it is no
  // longer quote-tracking-only. Note `theburgersleeves` (theburgersleeves.com)
  // is a NEW site — distinct from the retired `burgersleeves` (burgersleeves.com.au),
  // whose old chat history stays parked under its own id and out of this list.
  'thewaxpapers', 'thecustomstickers', 'zeepack', 'thecerealboxes', 'hotdogtrays',
  'theburgersleeves', 'thecandlesleeves', 'cardboardcups', 'thecoffeesleeves',
  'shopbubblemailers', 'insertshub', 'thediecutstickers', 'customperfumeboxes',
  'shopdisplayboxes', 'peptidesboxes',
  // 2026-08-04: lipboxes.com got the widget.
  'lipboxes',
  // 2026-08-16: thepolymailers.com got the widget.
  'thepolymailers',
  // 2026-08-20: theretailpackaging.com got the widget.
  'theretailpackaging',
]
export const SPORTS_SITES = ['texasfootball', 'volleyballuniforms', 'californiasoccer', 'floridabasketball', 'baseballjerseys']

// Sites whose leads are counted (auto lead detection + the Billing tab and the
// Overview tiles, which are computed from the same lead_capture dataset).
// Data-driven: add a site_id here to start tracking it — no other code changes.
// 2026-08-17: sports sites added — the widget lead form was writing `leads`
// rows for them, but with no lead_capture control row the Overview tiles read
// 0 while Recent Leads showed the leads, and no session link could be
// resolved. Sports leads stay out of packaging billing automatically: the
// billing endpoint is scoped to the member's workspace sites.
export const LEAD_TRACKED_SITES = [...PACKAGING_SITES, ...SPORTS_SITES]

export function isLeadTracked(siteId: string): boolean {
  return LEAD_TRACKED_SITES.includes(siteId)
}

// Sites we no longer source NEW leads for (2026-08-06: both partnerships ended).
// They stay in PACKAGING_SITES and LEAD_TRACKED_SITES on purpose — every
// existing lead, conversation and Billing row must remain visible. Only new
// intake is refused, at every write path: /api/quote-intake (Gmail quote
// forms), /api/lead (widget form), the chat bot's lead extraction, and manual
// mark-as-lead. Remove a site from this set to resume intake.
export const RETIRED_LEAD_SITES = new Set(['thetubepackaging', 'zeecustomboxes'])

export function isRetiredLeadSite(siteId: string): boolean {
  return RETIRED_LEAD_SITES.has(siteId)
}

export function workspaceSites(ws: Workspace): string[] {
  return ws === 'sports' ? SPORTS_SITES : PACKAGING_SITES
}

// ── Per-workspace feature gate ───────────────────────────────────────────────
// Everything built for the packaging CRM used to reach the sports dashboard for
// free. The UI has no workspace branching beyond a title, a favicon and an
// accent colour, so sports inherited Pipeline, Tasks, Reports, Gmail and
// reminders on the day each shipped — every one of them empty, none of them
// designed or tested against it.
//
// This list is the single place that decides. A feature a workspace does not
// carry is hidden in its nav AND refused by its API routes: the UI is never the
// only gate, exactly as CLAUDE.md §3 requires.
//
// Packaging carries everything, so this changes nothing that works today. The
// point is the DEFAULT for what comes next: a new feature reaches sports only
// when someone adds it here deliberately.
// `records` is the /leads/[id] page — stage, deal value, notes, owner, custom
// fields. It is the CRM itself, not a detail of it: gating pipeline and tasks
// while leaving this open let the sports dashboard open a lead and change its
// deal stage, which is exactly what "no CRM for sports" was meant to prevent.
// `chatpdf` is the PDF variant of the conversation download. Requested for the
// sports workspace only — packaging keeps its original single-file HTML
// download, and the route falls back to HTML for any workspace without this.
export type WorkspaceFeature = 'records' | 'pipeline' | 'tasks' | 'reports' | 'email' | 'reminders' | 'chatpdf'

const WORKSPACE_FEATURES: Record<Workspace, ReadonlySet<WorkspaceFeature>> = {
  packaging: new Set<WorkspaceFeature>(['records', 'pipeline', 'tasks', 'reports', 'email', 'reminders']),
  // Sports is dormant, and was never the audience for any of this: no widget has
  // run on its five sites since 2026-08-05, it has produced one lead ever, and
  // its only member is a consumer Gmail account that cannot consent to our
  // Internal OAuth app. It keeps chat, visitors, conversations and its own
  // history — the things it actually had. (Chat is back on since 2026-08-13,
  // which is what the PDF transcript download was asked for.)
  sports: new Set<WorkspaceFeature>(['chatpdf']),
}

export function hasFeature(ws: Workspace, feature: WorkspaceFeature): boolean {
  return WORKSPACE_FEATURES[ws]?.has(feature) ?? false
}

export function siteWorkspace(siteId: string): Workspace | null {
  if (SPORTS_SITES.includes(siteId)) return 'sports'
  if (PACKAGING_SITES.includes(siteId)) return 'packaging'
  return null
}

export const WORKSPACE_LABEL: Record<Workspace, string> = {
  sports: 'Sports',
  packaging: 'Packaging',
}

// ── Widget geo-blocking ──────────────────────────────────────────────────────
// The chat widget is hidden from visitors in these South Asian countries, but
// ONLY on packaging sites. Sports sites are never affected. Because the decision
// runs through siteWorkspace(), any site added to PACKAGING_SITES is covered
// automatically. Codes are ISO 3166-1 alpha-2 (uppercase).
export const WIDGET_BLOCKED_COUNTRIES = new Set(['PK', 'IN', 'LK', 'BD', 'NP'])

// Should the widget be hidden for a visitor from `countryCode` on `siteId`?
// Only blocks packaging sites for blocked countries; unknown country ('') is
// never blocked (default to showing — don't block on uncertainty).
export function isWidgetBlocked(siteId: string, countryCode: string): boolean {
  if (!countryCode) return false
  if (siteWorkspace(siteId) !== 'packaging') return false
  return WIDGET_BLOCKED_COUNTRIES.has(countryCode.toUpperCase())
}
