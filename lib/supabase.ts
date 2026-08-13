import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _client
}

// Anon client — used only for password sign-in. Never persists a session
// (auth is carried by our own signed cookie, not Supabase's session storage).
export function createAnonClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop: string | symbol) {
    const client = getClient()
    const val = (client as unknown as Record<string | symbol, unknown>)[prop]
    return typeof val === 'function' ? (val as Function).bind(client) : val
  },
})

// ── 1000-row cap workaround ───────────────────────────────────────────────────
// Supabase/PostgREST silently caps EVERY response at 1000 rows (server
// max-rows), no matter what .limit() asks for — a `.limit(20000)` quietly
// returns the first 1000 and drops the rest, which is how the analytics chart
// lost all recent days. fetchAllPages pulls a query page by page until a short
// page or maxRows. The caller passes a FACTORY that builds a fresh query per
// page (builders are single-use); it MUST include a stable .order() — that
// ordering is what makes .range() pagination correct.
const SUPA_PAGE_ROWS = 1000

interface PageQuery<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

// Pages are fetched in parallel waves of PAGE_CONCURRENCY (serial paging made
// multi-thousand-row reads take one round trip PER page, which showed up as
// slow tab loads). A short/empty page anywhere in a wave marks the end.
const PAGE_CONCURRENCY = 6

/**
 * Shout when a `fetchAllPages` cap was actually reached.
 *
 * A cap that is hit has silently changed the answer, and every caller here
 * orders OLDEST FIRST — so what gets dropped is the most recent data, which is
 * the part anyone is looking at. That is not theoretical: on 2026-08-13 the
 * Overview chart read Picked 0 / Chats 0 for the four most recent days because
 * its 50,000-row fetch was 63% control rows it then threw away, and the
 * genuinely useful rows fell off the end.
 *
 * A truncated result that says so is recoverable. One that doesn't is a chart
 * people trust while it quietly lies.
 */
export function warnIfCapped(what: string, got: number, cap: number): boolean {
  if (got < cap) return false
  console.error(`[${what}] hit its ${cap}-row cap (got ${got}) — the newest rows were dropped, so recent figures are undercounted. Narrow the query (filter by role) or raise the cap.`)
  return true
}

export async function fetchAllPages<T>(makeQuery: () => PageQuery<T>, maxRows: number): Promise<T[]> {
  const all: T[] = []
  for (let base = 0; base < maxRows; base += SUPA_PAGE_ROWS * PAGE_CONCURRENCY) {
    const wave: { from: number; to: number }[] = []
    for (let k = 0; k < PAGE_CONCURRENCY; k++) {
      const from = base + k * SUPA_PAGE_ROWS
      if (from >= maxRows) break
      wave.push({ from, to: Math.min(from + SUPA_PAGE_ROWS, maxRows) - 1 })
    }
    const results = await Promise.all(wave.map((w) => makeQuery().range(w.from, w.to)))
    for (let i = 0; i < results.length; i++) {
      const { data, error } = results[i]
      if (error) { console.error('[supabase] fetchAllPages page failed:', error.message); return all }
      if (!data || data.length === 0) return all
      all.push(...data)
      if (data.length < wave[i].to - wave[i].from + 1) return all
    }
  }
  return all
}
