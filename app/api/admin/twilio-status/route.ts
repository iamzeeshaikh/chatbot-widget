import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { twilioConfig, twilioProblem, fetchAccount } from '@/lib/twilio'

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

  try {
    const account = await fetchAccount(cfg)
    return NextResponse.json({
      configured: true,
      problem,                       // e.g. a missing WhatsApp sender, which is not fatal
      account: account.friendlyName,
      status: account.status,        // 'active' when the account is in good standing
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
