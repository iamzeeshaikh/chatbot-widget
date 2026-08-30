import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import {
  twilioConfig, twilioProblem, fetchAccount, recentCalls, recentRecordings,
  recentMessages, verifiedCallerIds, recentAlerts, dialingPermission, lookupNumber, callInsights,
} from '@/lib/twilio'

export const dynamic = 'force-dynamic'

// "Are the Twilio credentials actually working?" — asked from the server, where
// the credentials live.
//
// Vercel keeps secrets encrypted and `vercel env pull` returns them empty, so
// there is no way to check them from a laptop. Without this, the first proof
// that the keys were right would have been a customer's message failing to
// send. Admin-only; it returns the account's name and status, never the token.
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const problem = twilioProblem()
  const cfg = twilioConfig()
  if (!cfg) return NextResponse.json({ configured: false, problem })

  // ?calls=1 — the last few calls as Twilio saw them, which is the only way to
  // find out why a call that "queued" never reached anybody.
  if (req.nextUrl.searchParams.get('verified') === '1') {
    try {
      return NextResponse.json({ verified: await verifiedCallerIds(cfg) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  if (req.nextUrl.searchParams.get('alerts') === '1') {
    try {
      return NextResponse.json({ alerts: await recentAlerts(cfg) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  const insights = req.nextUrl.searchParams.get('insights')
  if (insights) {
    try {
      return NextResponse.json({ insights: await callInsights(cfg, insights) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  const lookup = req.nextUrl.searchParams.get('lookup')
  if (lookup) {
    try {
      return NextResponse.json({ lookup: await lookupNumber(cfg, lookup) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  const country = req.nextUrl.searchParams.get('country')
  if (country) {
    try {
      return NextResponse.json({ permission: await dialingPermission(cfg, country) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  if (req.nextUrl.searchParams.get('messages') === '1') {
    try {
      return NextResponse.json({ messages: await recentMessages(cfg) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  if (req.nextUrl.searchParams.get('recordings') === '1') {
    try {
      return NextResponse.json({ recordings: await recentRecordings(cfg) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  if (req.nextUrl.searchParams.get('calls') === '1') {
    try {
      return NextResponse.json({ calls: await recentCalls(cfg) })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 502 })
    }
  }

  try {
    const account = await fetchAccount(cfg)
    return NextResponse.json({
      configured: true,
      problem,                       // e.g. a missing WhatsApp sender, which is not fatal
      account: account.friendlyName,
      status: account.status,        // 'active' when the account is in good standing
      // 'Trial' or 'Full'. A trial account can only call numbers verified in
      // the console — the single most likely reason a call "does nothing" — and
      // `status` does not reveal it, so it is reported separately.
      accountType: account.type,
      whatsappFrom: cfg.whatsappFrom,
      phoneNumber: cfg.phoneNumber,
    })
  } catch (e) {
    return NextResponse.json({
      configured: true,
      working: false,
      error: e instanceof Error ? e.message : 'Twilio did not accept the credentials.',
    }, { status: 502 })
  }
}
