// The two separate dashboards ("workspaces"). Every member belongs to exactly
// one workspace and can never see the other. Site groupings mirror the original
// hardcoded dashboard split.

export type Workspace = 'sports' | 'packaging'

export const PACKAGING_SITES = ['zeecustomboxes', 'zeepack', 'burgersleeves', 'leadgen', 'shopcardboardboxes']
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
