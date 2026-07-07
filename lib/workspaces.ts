// The two separate dashboards ("workspaces"). Every member belongs to exactly
// one workspace and can never see the other. Site groupings mirror the original
// hardcoded dashboard split.

export type Workspace = 'sports' | 'packaging'

// Active packaging-workspace sites. The other site configs (zeecustomboxes,
// zeepack, burgersleeves, leadgen) still exist in the Supabase sites table —
// they're just removed from this grouping so they don't show in the packaging
// dashboard. Re-add their ids here to bring them back.
export const PACKAGING_SITES = ['shopcardboardboxes', 'thetubepackaging', 'kraftboxpack']
export const SPORTS_SITES = ['texasfootball', 'volleyballuniforms', 'californiasoccer', 'floridabasketball', 'baseballjerseys']

// Sites whose leads are counted/billed (auto lead detection + the Billing tab).
// Data-driven: add a site_id here to start tracking it — no other code changes.
export const LEAD_TRACKED_SITES = ['shopcardboardboxes', 'thetubepackaging', 'kraftboxpack']

export function isLeadTracked(siteId: string): boolean {
  return LEAD_TRACKED_SITES.includes(siteId)
}

export function workspaceSites(ws: Workspace): string[] {
  return ws === 'sports' ? SPORTS_SITES : PACKAGING_SITES
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
