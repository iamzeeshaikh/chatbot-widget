// Members who may use Jobs and nothing else.
//
// The designer/estimator (owner, 2026-10-13: "Jennifer sirf estimation hi
// karegi") works estimates and designs. She must not read chats, leads,
// customers' addresses and numbers, the inbox or sales — and an account with
// the plain "standard" role reaches all of those.
//
// No DDL, so not a new role in `members`: a list here, enforced twice —
//   • lib/auth.ts getMember() refuses every API outside JOBS_ONLY_API for
//     these accounts (the rule that matters);
//   • middleware.ts sends their browser to /jobs from any other page (the
//     courtesy, so they never land on a dashboard full of errors).
// Edge-safe on purpose: middleware imports it, so no Node or DB imports here.

export const JOBS_ONLY_EMAILS = ['jenniferwright@shopcardboardboxes.com']
/** The same accounts by member id — middleware can read the id off the cookie. */
export const JOBS_ONLY_UIDS = ['1d90b4ee-f0d1-4014-9b20-5ba8ff1eab87']

/** What a jobs-only account may call. */
const JOBS_ONLY_API = ['/api/jobs', '/api/auth/', '/api/admin/push-subscribe', '/api/version', '/api/logo/']

export function isJobsOnly(email: string | null | undefined): boolean {
  return JOBS_ONLY_EMAILS.includes(String(email ?? '').trim().toLowerCase())
}

export function jobsOnlyMayCall(pathname: string): boolean {
  return JOBS_ONLY_API.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`) || pathname === p.replace(/\/$/, ''))
}
