// "Is this the same person?" — the one rule, shared.
//
// findRelatedLeads already answers this on the record page: two leads are the
// same party when their lowercased emails match, or their digits-only phones
// match. Search groups its results with the SAME rule rather than inventing a
// second one, so "3 leads across 2 sites" on the search palette and Related
// Leads on the record can never disagree about who is who.

export const digitsOnly = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '')

export const normEmail = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase()

/** A phone is only identifying once it has enough digits to be a real number. */
export const MIN_PHONE_DIGITS = 7

/**
 * The comparable form of a phone number: its last PHONE_KEY_DIGITS digits.
 *
 * Comparing full digit strings looks right and is wrong in practice, because
 * the same number is stored in whatever shape it arrived in:
 *   +92 300 4567890  -> 923004567890
 *   0300 4567890     ->  03004567890
 *   00923004567890   -> 00923004567890
 *   3004567890       ->   3004567890
 * Those are four spellings of one person, and no two of them are equal. The
 * trailing digits are the part that does not move — country code and trunk
 * prefix are exactly what varies — so the last 9 reduce all four to 004567890.
 */
export const PHONE_KEY_DIGITS = 9

export function phoneKey(v: string | null | undefined): string | null {
  const d = digitsOnly(v)
  if (d.length < MIN_PHONE_DIGITS) return null
  return d.slice(-PHONE_KEY_DIGITS)
}

/** Do two numbers, however they were typed, denote the same line? */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = phoneKey(a)
  return !!ka && ka === phoneKey(b)
}

export function samePartyKeys(lead: { email?: string | null; phone?: string | null }): string[] {
  const keys: string[] = []
  const e = normEmail(lead.email)
  if (e) keys.push(`e:${e}`)
  const p = phoneKey(lead.phone)
  if (p) keys.push(`p:${p}`)
  return keys
}

/**
 * Group leads that belong to the same party.
 *
 * Union-find rather than a single key, because identity is transitive and a
 * single key cannot express it: lead A (email X, phone P) and lead B (email Y,
 * phone P) are the same person via the phone, and B and C (email Y, no phone)
 * are the same via the email — so A, B and C are one party. Keying on "email
 * else phone" would split them into three.
 *
 * Returns a group id per input index. Groups are numbered by first appearance,
 * so the ordering the caller sorted into is preserved.
 */
export function groupSameParty(leads: { email?: string | null; phone?: string | null }[]): number[] {
  const parent: number[] = leads.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }

  const seen = new Map<string, number>()
  leads.forEach((lead, i) => {
    for (const key of samePartyKeys(lead)) {
      const prev = seen.get(key)
      if (prev === undefined) seen.set(key, i)
      else union(prev, i)
    }
  })

  const label = new Map<number, number>()
  return leads.map((_, i) => {
    const root = find(i)
    if (!label.has(root)) label.set(root, label.size)
    return label.get(root)!
  })
}
