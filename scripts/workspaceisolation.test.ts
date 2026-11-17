// A site belongs to exactly one workspace, and every workspace gets only its
// own sites. Run: npx tsx scripts/workspaceisolation.test.ts
import assert from 'node:assert/strict'
import { WORKSPACES, workspaceSites, siteWorkspace, workspaceKind, workspaceForHost, hasFeature } from '../lib/workspaces'

const seen = new Map<string, string>()
for (const ws of WORKSPACES) {
  for (const site of workspaceSites(ws)) {
    assert.equal(seen.get(site), undefined, `${site} is listed in both ${seen.get(site)} and ${ws}`)
    seen.set(site, ws)
    assert.equal(siteWorkspace(site), ws, `${site} resolves to ${siteWorkspace(site)}, not ${ws}`)
  }
}
// The bug this guards: a workspace that is not sports used to receive the
// Model Town team's sites.
const packaging = new Set(workspaceSites('packaging'))
for (const site of workspaceSites('zeedesk')) assert.ok(!packaging.has(site), `${site} leaked into zeedesk from packaging`)
assert.notEqual(workspaceSites('zeedesk'), workspaceSites('packaging'))
assert.equal(workspaceKind('zeedesk'), 'packaging')
assert.equal(workspaceForHost('app.zeedesk.dev'), 'zeedesk')
assert.equal(workspaceForHost('chat.zeeops.dev'), 'packaging')
// Automated packaging jobs still belong to the Model Town team alone.
for (const f of ['quotebot', 'wabot', 'sales'] as const) assert.equal(hasFeature('zeedesk', f), false, `zeedesk must not carry ${f} yet`)
console.log(`workspace isolation: ${seen.size} sites, each in exactly one of ${WORKSPACES.length} workspaces`)
