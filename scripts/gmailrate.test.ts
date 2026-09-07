// The exact shapes Google uses to say "you are going too fast".
//
// This matters more than it looks: a rate limit arrives as a 403, the same
// status as a refused authorisation, and we used to answer both with
// "Reconnect Gmail". An agent replying to a customer was sent round the consent
// screen for what was a busy minute. These cases pin the difference down.
import assert from 'node:assert/strict'
import { isRateLimited } from '../lib/gmail.ts'

// The message Shujat actually saw, verbatim from the Cloud quota system: a 403
// carrying no `reason` at all, only prose.
assert.equal(isRateLimited(403, {
  error: {
    code: 403,
    message: "Quota exceeded for quota metric 'Total Query Cost' and limit " +
      "'Queries per minute per user' of service 'gmail.googleapis.com' for " +
      "consumer 'project_number:965544971996'.",
    status: 'RESOURCE_EXHAUSTED',
  },
} as never), true, 'the Total Query Cost 403 is a rate limit')

// The classic Gmail form, which does carry a reason.
assert.equal(isRateLimited(403, {
  error: { code: 403, message: 'User-rate limit exceeded.', errors: [{ reason: 'userRateLimitExceeded' }] },
} as never), true, 'userRateLimitExceeded is a rate limit')
assert.equal(isRateLimited(403, {
  error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] },
} as never), true, 'rateLimitExceeded is a rate limit')
assert.equal(isRateLimited(429, {} as never), true, 'a bare 429 is a rate limit')

// And the ones that must NOT be swallowed as "just busy" — these really do need
// the agent to reconnect or to fix the request.
assert.equal(isRateLimited(403, {
  error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] },
} as never), false, 'a missing scope is not a rate limit')
assert.equal(isRateLimited(403, {
  error: { code: 403, message: 'Delegation denied for user', errors: [{ reason: 'forbidden' }] },
} as never), false, 'a refusal is not a rate limit')
assert.equal(isRateLimited(401, {
  error: { code: 401, message: 'Invalid Credentials' },
} as never), false, 'a dead token is not a rate limit')
assert.equal(isRateLimited(400, { error: { message: 'Invalid to header' } } as never), false)
assert.equal(isRateLimited(200, {} as never), false)

console.log('gmail rate-limit classification: all cases pass')
