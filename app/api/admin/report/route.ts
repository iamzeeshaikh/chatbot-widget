import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { hasFeature } from '@/lib/workspaces'
import { buildReport } from '@/lib/report'
import { agentsCsv, sitesCsv, dailyCsv, buildPdf } from '@/lib/reportexport'
import { buildLeadsPdf } from '@/lib/leadspdf'
import {
  pktMonthRange, pktMonthOf, pktLastDaysRange, pktCustomRange, type ReportRange,
} from '@/lib/datetime'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Month-end performance report. Admin-only and workspace-isolated, like the
// performance section it belongs to.
//
//   ?format=json (default) | agents.csv | sites.csv | daily.csv | pdf
//
// Range comes from a preset or an explicit custom pair. EVERY boundary is a
// Karachi wall-clock instant — see lib/datetime.ts. Note that "this month"
// means the current KARACHI month, which after 19:00 UTC is already the next
// month; a report for a specific month must name it explicitly.
function resolveRange(sp: URLSearchParams): ReportRange | { error: string } {
  const preset = sp.get('preset') ?? 'last-month'
  const now = new Date()

  switch (preset) {
    case 'this-month': {
      const { year, month } = pktMonthOf(now)
      return pktMonthRange(year, month)
    }
    case 'last-month': {
      const { year, month } = pktMonthOf(now)
      return month === 1 ? pktMonthRange(year - 1, 12) : pktMonthRange(year, month - 1)
    }
    case 'last-7': return pktLastDaysRange(7, now)
    case 'last-30': return pktLastDaysRange(30, now)
    case 'month': {
      const year = Number(sp.get('year'))
      const month = Number(sp.get('month'))
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return { error: 'month preset needs year and month (1-12)' }
      }
      return pktMonthRange(year, month)
    }
    case 'custom': {
      const from = sp.get('from') ?? ''
      const to = sp.get('to') ?? ''
      const r = pktCustomRange(from, to)
      return r ?? { error: 'custom range needs from and to as YYYY-MM-DD' }
    }
    default: return { error: `unknown preset "${preset}"` }
  }
}

export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // Same gate as /api/admin/performance: only admins see other agents' numbers.
  if (member.role !== 'admin') return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  // Reports are a packaging deliverable; see WORKSPACE_FEATURES in lib/workspaces.ts.
  if (!hasFeature(member.workspace, 'reports')) {
    return NextResponse.json({ error: 'Reports are not enabled for this workspace' }, { status: 403 })
  }

  const sp = req.nextUrl.searchParams
  const range = resolveRange(sp)
  if ('error' in range) return NextResponse.json({ error: range.error }, { status: 400 })

  try {
    const data = await buildReport(member, range)
    const format = sp.get('format') ?? 'json'
    // A filename the client can file without renaming.
    const slug = data.periodLabel.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase()
    const stem = `zeeops-${data.workspace}-report-${slug}`

    const csv = (body: string, name: string) => new NextResponse(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${stem}-${name}.csv"`,
        'Cache-Control': 'no-store',
      },
    })

    switch (format) {
      case 'agents.csv': return csv(agentsCsv(data), 'agents')
      case 'sites.csv': return csv(sitesCsv(data), 'sites')
      case 'daily.csv': return csv(dailyCsv(data), 'daily')
      case 'leads.pdf': {
        // The client-facing document: every lead itemised, billable ones
        // marked. `site=` narrows it to one client's own site.
        const siteId = sp.get('site') || undefined
        const bytes = await buildLeadsPdf(data, { siteId })
        const suffix = siteId ? `-${siteId}` : ''
        return new NextResponse(Buffer.from(bytes), {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="zeeops-leads${suffix}-${slug}.pdf"`,
            'Cache-Control': 'no-store',
          },
        })
      }
      case 'pdf': {
        const bytes = await buildPdf(data)
        return new NextResponse(Buffer.from(bytes), {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${stem}.pdf"`,
            'Cache-Control': 'no-store',
          },
        })
      }
      default: return NextResponse.json(data)
    }
  } catch (err) {
    console.error('[report] failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Report failed' }, { status: 500 })
  }
}
