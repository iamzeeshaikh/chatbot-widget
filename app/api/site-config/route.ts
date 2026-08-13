import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { siteWorkspace, isWidgetBlocked } from '@/lib/workspaces'
import { resolveCountryCode } from '@/lib/geo'
import { isBotEnabled } from '@/lib/botflag'
import { getBlockedIps, requestIp } from '@/lib/blocklist'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function GET(req: NextRequest) {
  const siteId = req.nextUrl.searchParams.get('siteId')

  if (!siteId) {
    return NextResponse.json({ error: 'siteId required' }, { status: 400, headers: corsHeaders })
  }

  const { data, error } = await supabase
    .from('sites')
    .select('site_id, name, bot_name, primary_color')
    .eq('site_id', siteId)
    .single()

  if (error || !data) {
    // Unregistered site: tell the widget to render nothing at all. The widget's
    // fetch fallback builds itself with default branding on any error, so a
    // plain 404 here does NOT stop it — `blocked: true` is the one response it
    // honours by bailing before any UI exists. Deleting a site's row is
    // therefore the server-side kill switch for stray installs (pages whose
    // hosting we can't edit, e.g. WordPress footers).
    return NextResponse.json({ blocked: true }, { headers: corsHeaders })
  }

  // Geo-gate: hide the widget for blocked South Asian countries on packaging
  // sites only. Sports sites are never gated. The country comes from the Vercel
  // edge header (reliable), falling back to ipapi only in local dev.
  //
  // `preview=1` (set by ?zeechat=preview in the widget) skips the geo-check so
  // the site owners, who sit inside the blocked region, can see their own
  // widget. It deliberately does NOT skip the admin IP blocklist below — a
  // blocked visitor stays blocked whatever query string they pass.
  const preview = req.nextUrl.searchParams.get('preview') === '1'
  let blocked = false
  if (!preview && siteWorkspace(siteId) === 'packaging') {
    const code = await resolveCountryCode(req.headers)
    blocked = isWidgetBlocked(siteId, code)
  }
  // Admin IP blocklist: a blocked visitor never even sees the widget.
  if (!blocked) {
    const ip = requestIp(req.headers)
    // Only this site's own workspace can have blocked the visitor.
    const ws = siteWorkspace(siteId)
    if (ip && ws && (await getBlockedIps(ws)).has(ip)) blocked = true
  }

  // bot_enabled lets the widget swap the bot-persona greeting for a neutral
  // "our team" one while the bot is globally off (lib/botflag.ts).
  return NextResponse.json({ ...data, blocked, bot_enabled: isBotEnabled() }, { headers: corsHeaders })
}
