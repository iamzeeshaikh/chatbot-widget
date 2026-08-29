// Who is allowed to see a customer's email address and phone number.
//
// The owner of the sports workspace put it plainly: an agent should be able to
// work every lead — stages, notes, tasks, and email the customer from inside
// the CRM — without ever learning the customer's address or number. Somebody
// who cannot read the address cannot take the list with them.
//
// TWO RULES MAKE THAT REAL, and both matter:
//
//  1. The masking happens on the SERVER, at every read edge. Hiding a field in
//     the UI leaves it in the JSON the browser already has, which is one
//     devtools tab away from being copied — and this repo's standing rule is
//     that the API refuses, the UI is only a courtesy.
//
//  2. It is not enough to mask the `email` and `phone` COLUMNS. A quote lead
//     carries the entire original form email in `message` ("Email: someone@…
//     Phone: 0300…"), a chat transcript carries whatever the visitor typed,
//     and an email thread carries the customer's own signature. Masking the
//     columns while leaving those bodies untouched would have looked like it
//     worked and leaked on the first lead anybody opened. So free text is
//     scrubbed too, by pattern, wherever it is served to someone who may not
//     see contacts.
//
// Admins see everything, unchanged. Today every packaging member is an admin,
// so nothing there changes at all; this bites exactly where it was asked for.

import type { Member } from './auth'
import { hasFeature } from './workspaces'

export const HIDDEN_EMAIL = '•••••• hidden'
export const HIDDEN_PHONE = '•••••• hidden'
const HIDDEN_INLINE = '••••••'

// Admins always see contacts. Everyone else sees them too UNLESS their
// workspace has asked for the opposite — see `contactprivacy` in
// lib/workspaces.ts. Packaging's agents phone their customers back, so nothing
// is withheld there; sports asked for exactly the reverse.
export function canSeeContacts(member: Pick<Member, 'role' | 'workspace'> | null | undefined): boolean {
  if (!member) return false
  if (member.role === 'admin') return true
  return !hasFeature(member.workspace, 'contactprivacy')
}

export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  return HIDDEN_EMAIL
}

export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return value ?? null
  return HIDDEN_PHONE
}

// Anything that looks like an address. Deliberately greedy about what counts as
// a local part: a form body writes "Email: first.last+tag@example.co.uk" and a
// signature writes "<first@example.com>".
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

// A phone number as people actually write one: 7+ digits, with spaces, dashes,
// dots, brackets or a leading +. The 7 is the floor for a real number; below it
// the risk is mangling quantities ("45 sets") for nothing.
const PHONE_RE = /\+?\d[\d\s().-]{5,}\d/g

// A run of digits long enough to BE a number even with nothing separating it —
// covers "Phone 03004567890" and the digits pasted bare into a chat.
const DIGITS_RE = /\d{7,}/g

/**
 * Remove addresses and phone numbers from free text.
 *
 * Errs towards over-masking: an agent seeing "••••••" where a quantity used to
 * be is a cosmetic problem, an agent seeing one customer's mobile is the thing
 * this exists to prevent. The full text is always intact in the database and
 * for an admin.
 */
export function scrubText(text: string | null | undefined): string | null {
  if (!text) return text ?? null
  return text
    .replace(EMAIL_RE, HIDDEN_INLINE)
    .replace(PHONE_RE, HIDDEN_INLINE)
    .replace(DIGITS_RE, HIDDEN_INLINE)
}

/** scrubText, but for a value that may legitimately be absent. */
export function scrubMaybe<T extends string | null | undefined>(text: T): string | null {
  return scrubText(text)
}
