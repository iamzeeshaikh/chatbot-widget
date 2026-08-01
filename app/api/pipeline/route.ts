import { NextRequest, NextResponse } from 'next/server'
import { getMember } from '@/lib/auth'
import { loadPipeline, CARDS_PER_COLUMN, type PipelineFilters } from '@/lib/pipeline'
import { isCrmStage, CRM_STAGES, type CrmStage } from '@/lib/crm'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The board / list data.
//
// Site scope lives inside loadPipeline's queries, so a member cannot receive a
// lead outside their sites whatever they put in the filters. There is no write
// here at all: dragging a card calls the existing /api/leads/[id]/stage
// endpoint, which re-checks access with guardLeadAccess — the pipeline does not
// fork the stage-change path, including its legacy lead_status dual-write.
//
// Two shapes:
//   GET /api/pipeline?...                  → every column, first page of cards
//   GET /api/pipeline?more=<stage>&offset= → one column's next page of cards
export async function GET(req: NextRequest) {
  const member = await getMember(req)
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const rawStage = sp.get('stage') ?? 'all'
  const filters: PipelineFilters = {
    siteId: sp.get('site') || undefined,
    owner: sp.get('owner') || undefined,
    stage: isCrmStage(rawStage) ? rawStage : 'all',
    from: sp.get('from') || undefined,
    to: sp.get('to') || undefined,
  }

  const more = sp.get('more')
  const offset = Math.max(0, Number(sp.get('offset') ?? 0) || 0)

  try {
    // Every matching lead id, for "select all N matching" in the list view.
    // loadPipeline already folds over the whole filtered set to build its exact
    // column counts, so this costs the same query and returns ids only — no
    // card payloads — which is what makes selecting beyond the loaded page
    // honest rather than a guess.
    if (sp.get('ids') === '1') {
      const result = await loadPipeline(member, filters, { perColumn: Number.MAX_SAFE_INTEGER })
      const ids = result.columns.flatMap((c) => c.cards.map((card) => card.id))
      return NextResponse.json({ ids, total: ids.length, truncated: result.truncated })
    }

    if (more && isCrmStage(more)) {
      // Load-more for a single column. The aggregate is recomputed rather than
      // cached: it is the same bounded fold, and a stale total on a board people
      // are actively dragging through would be worse than the extra work.
      const result = await loadPipeline(member, filters, {
        perColumn: CARDS_PER_COLUMN,
        offsets: { [more as CrmStage]: offset } as Partial<Record<CrmStage, number>>,
      })
      const col = result.columns.find((c) => c.stage === more)
      return NextResponse.json({ stage: more, cards: col?.cards ?? [], hasMore: col?.hasMore ?? false, count: col?.count ?? 0 })
    }

    const result = await loadPipeline(member, filters)
    return NextResponse.json({
      ...result,
      me: member.email,
      stages: CRM_STAGES,
      perColumn: CARDS_PER_COLUMN,
    })
  } catch (err) {
    console.error('[pipeline] load failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to load pipeline' }, { status: 500 })
  }
}
