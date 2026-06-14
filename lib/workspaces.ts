// The two separate dashboards ("workspaces"). Every member belongs to exactly
// one workspace and can never see the other. Site groupings mirror the original
// hardcoded dashboard split.

export type Workspace = 'sports' | 'packaging'

// Only shopcardboardboxes is active in the packaging workspace. The other site
// configs (zeecustomboxes, zeepack, burgersleeves, leadgen) still exist in the
// Supabase sites table — they're just removed from this grouping so they don't
// show in the packaging dashboard. Re-add their ids here to bring them back.
export const PACKAGING_SITES = ['shopcardboardboxes']
export const SPORTS_SITES = ['texasfootball', 'volleyballuniforms', 'californiasoccer', 'floridabasketball', 'baseballjerseys']

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
