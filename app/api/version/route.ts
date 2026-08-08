import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// Which deployment is serving right now — the cheap half of stale-tab
// detection (app/components/DeployRefresh.tsx). Deliberately no auth and no
// database: the deployment id is already public in every asset URL (?dpl=...),
// and reading an env var costs nothing, so every open tab can poll this
// without ever touching Postgres. Compare two responses: if they differ, a
// deploy happened in between.
export async function GET() {
  return NextResponse.json(
    { id: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? 'dev' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
