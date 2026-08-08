# CLAUDE.md — operating rules for this repo

ZeeOps live-chat + CRM dashboard. Next.js 16 (App Router) · React 19 · Tailwind v4 ·
Supabase Postgres · Groq. Deployed on Vercel, aliased to **https://chat.zeeops.dev**.

These rules are the standing brief. Follow them without being reminded.

---

## 1. Autonomy

- **Never ask for permission or confirmation.** Decide and proceed. If a choice is
  ambiguous, pick the option most consistent with the rest of the codebase, state the
  assumption in your final report, and keep going.
- **Every session ends with a commit and a production deploy** — `vercel --prod --yes`.
- **Never end a session with uncommitted work.** If you touched it and it builds, it
  ships. Half-finished work left in the working tree is the failure mode this rule
  exists to prevent.
- Verify before deploying: `npm run build` **and** `npx tsc --noEmit`. After deploying,
  actually fetch the affected production URL and confirm it returns 200 and renders.

## 2. Git hygiene

- **Never `git add -A`** (nor `git add .`). Stage every path explicitly, by name. The
  working tree routinely contains build output, probes and scratch files.
- **All throwaway scripts, probes and one-off tests go in `scratch/`**, which is
  gitignored. Never leave an ad-hoc `*.mjs` at the repo root — six of them once had to
  be cleaned up by hand.
- **Never commit `.env.local`** or anything carrying a credential. `.gitignore` covers
  `.env*`; confirm with `git check-ignore -v .env.local` before staging when in doubt.
- **The GitHub repo `iamzeeshaikh/chatbot-widget` is PUBLIC.** A shared secret sat in a
  committed script for nine days once. Secrets belong in Vercel env vars or Apps Script
  Script Properties — never in a file git can see.
- Commit messages: one line, plain English, describing the behaviour change from the
  user's point of view — not the mechanics. Match the existing log style.

## 3. Architecture — the rules that break things when ignored

### No DDL. Ever.
There is **no DDL access to the database**. Do not write migrations, do not add
columns, do not add tables. **All new per-session state is stored as `chat_logs`
control rows** — a reserved `role` value with a JSON body, where the newest row for a
session wins on read. Older rows are never deleted; they are the audit trail.
See `lib/mode.ts`, `lib/assignment.ts`, `lib/crm.ts` for the pattern.

### Every new control role MUST be registered in `lib/controlroles.ts`
That file is the single source of truth for "is this row a real message or internal
state". A role missing from it leaks raw JSON into the chat transcript and the
conversation list, looking like the bot replied to the agent.

### The `session_message_summaries()` denylist — this bug has shipped TWICE
The conversations list gets its per-session preview from the Postgres function
`session_message_summaries()`, which carries **its own hardcoded denylist of roles
inside the database**. We cannot alter it (no DDL). It therefore **cannot see any role
added after it was written** — an unknown role comes back as that session's
`preview` / `last_role` / `last_at`, i.e. raw control JSON rendered as the last message.

**Consequence: registering a role in `lib/controlroles.ts` is not sufficient on its
own.** `app/api/admin/conversations/route.ts` re-checks every summary against
`isControlRole()` in Node and repairs any session the DB got wrong (`withoutControlRows`).
**Do not remove that guard.** After adding any control role, re-check the conversations
list preview and confirm no JSON appears.

Also: the DB summary **counts** control rows as messages. New roles must be subtracted
from `message_count` in the same file, or (say) three CRM notes read as three extra
chat messages.

### Registered control roles today
`mode`, `contact`, `tags`, `lead_capture`, `reply_author`, `lead_status`, `assignment`,
`blocked_visitor`, `push_sub`, and the CRM ones — `crm_stage`, `crm_note`, `crm_field`,
`crm_value`, `crm_task`, `crm_prefs`, `crm_reminder`. The `crm_*` set lives in
`CRM_ROLES` (`lib/crm.ts`), which `controlroles.ts` spreads and the conversations route
subtracts from the message count, so adding a new `crm_*` role to that one array wires
up both protections at once.

### One lead or four hundred: stage changes go through `lib/stagechange.ts`
`applyStageChange()` is the ONLY place a stage is written. `/api/leads/[id]/stage`
and `/api/pipeline/bulk` both call it, which is what guarantees the two-row write —
`crm_stage` plus the legacy `lead_status` mirror sharing one `created_at` — cannot
drift between the single and bulk paths. Do not inline that write anywhere else.

Bulk edits (`lib/bulk.ts`, `/api/pipeline/bulk`) follow three rules:
- **Access is decided per lead, never per batch.** `resolveSitesForIds` batches the
  *lookup* (two queries for the whole selection) but still runs `canAccessSite` for
  every id. Out-of-scope leads are skipped and reported, never applied, and never
  fatal to the batch.
- **Writes run in waves of `BULK_CONCURRENCY`** — not all at once (800 sockets at a
  Micro Postgres that has already fallen over once) and not sequentially (400 round
  trips would time out).
- **Partial failure is normal and reported.** Control rows are append-only, so there
  is no transaction to roll back and the response says exactly which ids landed.
  Undo is a *compensating write* (a further row restoring the previous value), not a
  rollback — history keeps both events on purpose.

Anything reading a lead's current stage for a "before" value must mirror
`loadPipeline`'s fold, including the legacy `lead_status` fallback and its
`stagePairAt` guard. Reading only the newest `crm_stage` row calls a pre-CRM lead
"new" and writes a false `previous` into the timeline — see `currentStateFor` in the
bulk route.

### Identity — "is this the same person?" — lives in `lib/identity.ts`
`samePhone` / `phoneKey` / `groupSameParty`. Phones are compared on their **last 9
digits**, never on the full digit string: the same line arrives as `+92 300 4567890`,
`0300 4567890`, `00923004567890` and `3004567890`, and no two of those are equal.
`findRelatedLeads` and search grouping both go through it, so the record page and the
search palette can never disagree about who is who. Search also builds its SQL phone
pattern from that same key — built from the typed digits instead, the wildcards demand
a digit that a differently-prefixed stored number does not have, and the row is never
fetched for Node to verify.

### Inbound email (Phase 6): poll threads we started, never the mailbox
`lib/emailsweep.ts`, cron `*/10` in `vercel.json`. Reading replies needs
**`gmail.readonly`** — the Gmail API has no per-thread read scope, and
`gmail.metadata` returns headers without bodies. The restriction is therefore
ours to enforce: the sweep only ever calls `fetchThread(threadId)` for a
`threadId` off a `crm_email` row WE wrote. There is deliberately **no list or
search helper in `lib/gmail.ts`**, so the wider inbox is unreachable by
construction rather than by policy. Do not add one.

`GMAIL_SCOPES` (send + settings.basic) stays the *required* set; `GMAIL_READ_SCOPE`
is requested alongside but optional, so a connection made before Phase 6 keeps
sending and only reply capture reports "reconnect". Deduped on Gmail's immutable
message id, so the sweep is safe run late, twice or after a missed window.

Failures are never swallowed: every per-agent error lands in a `crm_email_sweep`
row on the reserved `zeeops-crm` site and is surfaced by the sweep endpoint.

**Inbound attachment limits are NOT the outbound ones.** Outbound is capped
because Gmail refuses a message over 25MB *after* base64; inbound is already
through Gmail, so the only question is what we will store. Copying the 10MB
outbound cap to inbound refused an ordinary 11.3MB phone photo — the common
case for artwork approval, not an edge case. `MAX_INBOUND_ATTACHMENT_BYTES`
(25MB) is separate on purpose; the Supabase bucket's own file-size limit must be
raised to match or the upload fails after the download has already been paid for.
A refusal is recorded on the row with its reason, shown inline on the timeline,
and `isRetryableSkip()` decides whether `/api/leads/[id]/email/attachment` offers
a retry — a size refusal is retryable because the limit that caused it may since
have been raised. Never leave a dead chip pointing at a file nobody can get.

**Quote stripping fails safe, in both directions.** `splitQuoted` cuts at the
first quote marker, signature or attribution, but a `--` signature and an
`-----Original Message-----` banner are explicit delimiters while "On … wrote:"
and a bare `From:/Sent:` block are inferences. Where the boundary was *inferred*
and real prose still sits below it, the boundary is abandoned and the whole
message is shown — bottom-posted and inline replies are common and hiding a
sentence a customer wrote is the one unacceptable outcome. A reply that is
entirely quote (an attachment on its own) is flagged `textless` rather than
having its quote promoted into the body, which used to render as though the
customer had sent our own words back at us. `parseCrmEmailIn` re-applies that
test on **read** via `isAllQuote()`, because rows written before the fix already
have the quote in `body` and control rows are append-only — there is nothing to
migrate, so the repair belongs at the read edge.

A customer reply deliberately does **not** move `lastContactedAt` — that measures
OUR outreach and feeds the follow-up cadence, so folding inbound into it would
make an ignored lead look freshly worked. It sets `lastReplyAt` and increments
`unreadReplies` instead, which is what drives the "waiting on you" badge on the
record, the board card and the list.

### Push subscriptions dedupe on the DEVICE, not the endpoint
`push_sub` rows fold by endpoint, which catches a repeat save of the same
subscription but not a *new* endpoint from a browser that already had one — and a
browser can mint several. Three live endpoints once appeared for one member inside
one second, and two sat on another account for three weeks, each getting its own
copy of every notification. Nothing retired them: an orphan is only cleaned up when
a send returns 404/410, and a **live** orphan never does.

So `savePushSubscription` takes a `did` — a stable per-browser-profile id minted in
localStorage (`zee-push-did`, `pushDeviceId()` in `app/page.tsx`) — and retires any
other active row with the same email + `did` before inserting. One member on one
profile therefore holds at most one subscription, and re-subscribing replaces.
Rows predating `did` are deliberately left alone: they are unattributable, and a
member genuinely running a laptop and a phone would lose one. They retire when they
die. `scratch/test-push-dedupe.mjs` asserts all four cases against the real module.

### Member-scoped rows go on a reserved site, not a lead
`crm_prefs` and `crm_reminder` belong to a *member*, not a conversation, so they live on
the reserved `zeeops-crm` site (`lib/reminders.ts`) — the same trick `push_sub` uses with
`zeeops-push`. A reserved site is in nobody's site scope, so those rows cannot reach a
conversation list, a task list or a preview at all. They are registered in `CRM_ROLES`
anyway as a second line of defence.

### Scheduled work: a secret-protected endpoint driven by an external clock
`/api/tasks/reminders/sweep` (declared in `vercel.json` as a `*/5` Vercel Cron; the team
plan is Pro, so sub-daily schedules are allowed). It accepts
`Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends) or `x-cron-secret`, mirroring
the `x-quote-secret` style `/api/quote-intake` already uses; a signed-in admin can also run
it by hand, and `?dryRun=1` reports without sending or writing.
**`CRON_SECRET` must exist in the Vercel environment or every scheduled run 401s and
reminders silently never fire** — the endpoint says so explicitly in its 401 body.
The job derives everything from current task state and is idempotent, so running late,
twice, or after missing a window is safe.

### Pakistan-time calendar math lives in `lib/datetime.ts`
`pktDayKey` / `pktOffsetMs` / `pktDateTimeToUtc` / `pktPartsOf` / `pktDayKeyOffset` /
`formatDueLabel`. Anything that means "today", "overdue" or "tomorrow 10am" must go
through these — they use the timezone database via `Intl`, never a hardcoded `+5`.
Task due dates are entered as Karachi wall-clock and converted **server-side**; the
browser's own zone never enters into it. `scratch/pkt-real-impl.test.mjs` asserts the
buckets against the real modules and passes under `TZ=America/Los_Angeles`,
`TZ=Pacific/Kiritimati` and `TZ=UTC` — re-run it after touching any of this.

### Deployment skew: agents' tabs stay open for DAYS across deploys
A tab loaded before a deploy holds a bundle whose lazily-loaded route chunks no
longer exist on the server. Clicking Pipeline/Tasks then fails: the URL changes
but the route chunk 404s. This was misdiagnosed once as a pointer-target bug —
`scratch/nav-click.mjs` passes (cold load = fresh bundle) while a stale tab
reproduces it. Four nets now cover it, all needed:
- **Vercel Skew Protection is ON** (12h, set via the project API — not in any
  file here; check with `vercel project inspect` / the dashboard if in doubt).
  Old tabs get their own deployment's assets via the `?dpl=` param for 12 hours.
- **`app/error.tsx` auto-reloads on chunk-load errors.** Next 16 renders the
  error boundary when a route chunk 404s (it does NOT keep the old page — the
  old `pathname === '/'` fallback guard could never fire for this). A
  sessionStorage stamp limits it to one attempt/minute so a truly broken server
  shows the card, not a reload loop.
- **`navigateTo` (app/page.tsx) hard-navigates if the dashboard is still
  mounted 1.5s after `router.push`** — the net for a push that dies without
  reaching an error boundary.
- **`DeployRefresh` (root layout) polls `/api/version` every 5 min** and on a
  new deployment id reloads hidden tabs immediately, shows a reload pill on
  visible ones, and reloads when the tab next goes hidden — but NEVER while any
  textarea holds text (composer/note/task draft). `/api/version` is env-var
  only, no DB, no auth — the deployment id is already public in every asset URL.
`scratch/deploy-skew.test.mjs` verifies all of it end to end: it loads the
dashboard, runs a real `vercel --prod --yes --force` deploy UNDER the open tab,
then asserts one click still lands a rendered /pipeline, the pill appears, a
draft blocks the hidden reload, and a chunk-404 tab self-heals. It costs a real
production deploy per run — run it when touching any of the four nets, not
routinely.

### The dashboard header must not move after first paint
Every count in the nav (Conversations, Visitors live, the Tasks badge, unread
replies) arrives from its own fetch a second or two after paint. When those
badges were rendered conditionally, each one that appeared widened the tab strip
and pushed Pipeline and Tasks sideways — and once the strip was wide enough the
whole header wrapped to a second row and moved them 45px down as well. A click
already aimed at Pipeline then landed on the logo button, which quietly switches
to Overview, so the first click looked like it did nothing and the second
worked. **This was reported as a router bug and was not one.** Badges are now
rendered from first paint and merely `invisible` until they have a value, with
`tabular-nums` and a `min-w-` so a count going 9 → 10 → 100 does not move
anything either. Keep any new header chrome to that pattern.

The tab strip **wraps, it does not scroll**. As a horizontal scroller it was
678px of tabs in a 364px box on a phone, so Billing, Performance, Pipeline and
Tasks sat past the right edge with nothing to suggest they existed.

The bar is one `<nav>` element re-laid out at two breakpoints, never two copies:
four equal columns below `sm`, a wrapped full-width row up to `xl`, and inline
beside the brand from `xl`. Duplicating it for mobile would put two Pipeline
links in the DOM and the first `querySelector` would find the hidden one.
Below `xl` it is the **nav** that takes its own row, not the controls — when the
controls wrapped instead, Members and Sign out ended up orphaned on a second
line while the first still had space.

Counts are always rendered and go grey at zero rather than being hidden: an
invisible reservation is stable but leaves a conspicuous hole, which is what
made the spacing look wrong. They are capped (`999+`, `99+`) so the value can
never outgrow its `min-w-`. On mobile only, the count is absolutely positioned
on the tab's corner — out of flow, so it costs no width and may be hidden at
zero for free; four columns in the flow ellipsised every label.

Account-level things (identity, Members, Sign out) belong in the avatar menu,
not loose in the bar. That is also what bought the space to fit one row.

`scratch/nav-click.mjs` is the regression test: it aims at an entry, waits, then
clicks the *recorded* coordinates — a person cannot re-aim mid-movement either,
and a test that re-reads the position right before clicking can never catch this
class of bug. Run it against **production** (`BASE=…`), with `CLICK_AT` sweeping
1500–4500ms, since the shift is driven by real API latency and does not
reproduce against a fast local server.

### Do not restructure `app/page.tsx`
It is one ~3,400-line client component and it works. Edit it **surgically** — add to it,
never reorganise, re-split or "clean it up". Keep list sorts stable (sort by
`created_at`, not `last_seen`) and key message/detail effects on `session_id` rather
than the object, or the polling UI churns and flashes.

### Enforce access server-side
Workspace isolation and per-member site access are decided **on the server**, in the
API route — never only by hiding UI. A member without access to a lead's site gets
403 whether they clicked a link or typed the id. Use `getMember` / `canAccessSite` /
`siteScope` / `memberSites` from `lib/auth.ts`; see `guardLeadAccess` in
`lib/leadrecord.ts` for the reference implementation.

## 4. Conventions

- **Timestamps: Asia/Karachi, 12-hour format, always via `lib/datetime.ts`.** Never
  hand-roll a date format and never call `toLocaleString` directly — the DB stores some
  timestamps naive-UTC, and `toDate()` is what stops them being read as local time and
  landing hours off. `formatDateTime`, `timeAgo` and the day-key helpers live there.
- **Relative paths only** (`/leads/${id}`, never `https://chat.zeeops.dev/leads/...`).
  The app may later also serve from **crm.zeeops.dev** on the same Vercel project, and
  every link has to keep working under that origin.
- **Dark theme with readable contrast.** The dashboard is authored in *light* Tailwind
  utilities; `app/globals.css` remaps them under `html.dark` (opt-in via the header 🌙
  toggle, persisted in localStorage). So **use the standard `-100` / `-300` / `-700`
  Tailwind shades** the rest of the UI uses. A hand-picked hex is the one thing that
  will go dark-on-dark when the theme flips. Where a solid accent is unavoidable, pick a
  saturated mid-tone that reads on both themes (see `CRM_STAGE_DOT` in `lib/crm.ts`).
- **Both themes have a contrast floor in `globals.css`, not per component.** Light mode
  is remapped under `html:not(.dark)` the same way dark is under `html.dark`, because
  Tailwind's grey ramp was drawn for dark surfaces and `gray-400`/`gray-500` fall under
  AA on this app's white cards. Raise a colour **there**, once; do not hand-pick a hex in
  a component to work around it. What the tiers mean now:
  `gray-400` = tertiary, `gray-500` = secondary, `gray-600/700` = body/strong,
  `gray-300` = **decoration only** (aria-hidden separators, em-dash placeholders) — if a
  span carries information it must be `gray-400` or darker. For borders,
  `border-gray-300` is the **interactive** tier (≥3:1: dropdowns, buttons, drop targets)
  and `border-gray-200` is structure (card outlines, row rules). Put a control on the
  interactive tier rather than darkening the structural one.
  `scratch/contrast-audit.mjs` measures it — run with `THEME=light|dark` against a
  **production build**, never `next dev`, whose CSS cache serves a stale stylesheet and
  will quietly report the wrong numbers.
- **Icons come from the App Router file convention**, not `metadata.icons` and not loose
  files in `public/`: `app/favicon.ico` (16/32/48), `app/icon.svg`, `app/apple-icon.png`.
  Regenerate the whole set — including the PWA `icon-192/512/maskable-512` that
  `app/manifest.ts` and `public/sw.js` (push notifications) point at — with
  `node scratch/gen-icons.mjs`, which draws them all from one mark so they cannot drift.
  Note `app/page.tsx` swaps the *tab* icon per workspace at runtime; it deliberately
  leaves `rel='apple-touch-icon'` in place, because "Add to Home Screen" reads the live
  DOM and removing it blanked the installed icon.
- New links should be real `<a href>` so they can be middle-clicked into a new tab, with
  `router.push` on plain click (check `metaKey`/`ctrlKey`/`shiftKey` before
  `preventDefault`).
- Prefer additive changes to existing UI: keep the behaviour that was already there
  available somewhere (a button, a cell click) rather than replacing it outright.

## 5. Build baseline

- `npm run build` and `npx tsc --noEmit` must both stay green.
- **Known-acceptable pre-existing lint state — introduce zero new problems.**
  Measured on this commit: **`npx eslint .` → 54 problems (23 errors, 31 warnings)**.
  `scratch/**` is in `eslint.config.mjs`'s ignore list — throwaway probes were being
  linted, so the "baseline" drifted by a dozen warnings depending on which scripts
  happened to be lying around, which made the number useless for comparison.
  (An earlier note put the error count at 38; the difference was ad-hoc root-level test
  scripts that have since been deleted. **23 errors is the real baseline** — re-measure
  rather than trusting either number, and compare before/after using `git stash`.)
- **One known `tsc` error is pre-existing and acceptable:**
  `scripts/botschedule.test.ts(6,61): TS5097` (import path ending in `.ts`). That file
  is run via `npm run test:schedule` with a custom loader. Anything beyond it is yours.
- The fast way to prove you added nothing: `git stash push -u`, run the checks, note the
  counts, `git stash pop`, run them again. The numbers must match.

## 6. Performance notes (the DB has crashed once)

Supabase Postgres, AWS ap-northeast-1, project `xrvaxzkbszpbqgfixkce`, Micro compute.
On 2026-07-24 it pinned CPU at 95% because the conversations endpoint scanned the whole
`chat_logs` table on every poll with no indexes.

- Two indexes must exist: `idx_chat_logs_created_at`, `idx_chat_logs_session_created`.
  Check with `select indexname from pg_indexes where tablename='chat_logs'`.
- **Recommended, not yet applied** — the one index lead search wants:
  `create index concurrently idx_chat_logs_role_site on chat_logs (role, site_id);`
  Search finds chat leads with `role = 'lead_capture'`, which is 88 rows inside a
  40k-row table and has no index, so every search seq-scans the lot. Harmless today
  (~10ms of a ~180ms round trip) and linear in a table that grows ~1k rows/month.
  `CONCURRENTLY` so it does not lock writes. This is the only DDL worth asking for
  right now; `leads` is 1.1k rows and needs nothing. Revisit `pg_trgm` GIN indexes on
  `leads.name`/`leads.email` only past roughly 20k leads — below that a seq scan of
  1.1k rows beats maintaining a trigram index.
- Queries are windowed (7–30 days) and row-capped on purpose. **Do not widen a window or
  remove a cap** without accounting for the load.
- Poll intervals: visitors 5s, conversations 10s, messages 3s, detail 20s. Don't tighten
  them.
- Any new per-poll query must select only the columns it needs and be bounded.

## 7. Things that live outside this repo

- **`scripts/quote-intake-apps-script.gs` must be pasted into the user's Apps Script
  editor by hand** — deploying this repo does not update it. Refresh
  `~/Desktop/zeeops-quote-intake-NEW.txt` from the repo copy after any change, and
  re-run `pbcopy` rather than assuming the clipboard survived.
- After changing how mail is found, `rewindWatermark()` must be run, or the fix only
  applies to mail that hasn't arrived yet.
- The widget is blocked by a host site's CSP unless `chat.zeeops.dev` is in `script-src`,
  `connect-src` and `img-src` — check both the HTTP header and any
  `<meta http-equiv="content-security-policy">`.
- Any new widget sound must be gated in `playChime` — that is the single mute/dismiss
  chokepoint, and an ungated ding once cost a real sale.
- **The DASHBOARD's sound switch has two halves, and a new sound must respect both.**
  `playDashSound` (`app/page.tsx`) covers everything the page plays; `silent` on
  `showNotification` (`public/sw.js`) covers everything a push plays. The second half
  exists because a push notification is drawn by the worker and sounded by the OS —
  outside the tab, where neither the page's AudioContext nor **Chrome's own tab mute**
  can reach it. That was a real bug: a muted tab kept dinging. A worker cannot read
  localStorage, so the page posts `{type:'zee-sound'}` to it on every change and on
  load, and the worker persists it in the Cache API to survive being killed between
  pushes. Anything that sends a push (`sendPushToWorkspace` on new chats,
  `sendPushToMember` for Phase 6 reply alerts and task reminders) inherits this by
  going through that one push handler — do not add a second one.
  Note `renotify` must track `silent`: it is what makes a repeat push on the same tag
  alert again instead of quietly updating the banner, and Chrome rejects the two
  together.
- **When the widget asks for contact details is tuned in ONE object: `LEAD_PROMPT` in
  `public/widget.js`.** Every threshold (idle delay, minimum messages, active-conversation
  grace, retry/defer, exit intent on/off) lives there — do not scatter new constants.
  Everything that wants to show the form must go through `showLeadPrompt()`, whose
  `leadPromptAllowed()` gate holds the never-nag rules (captured, dismissed, email already
  given, minimum messages). A new trigger that calls it inherits those rules; one that
  sets `display` directly bypasses them.
  History worth not repeating: the form used to need a bot/agent reply or a file upload
  *and* >= 3 visitor messages. With the bot globally off, 46.4% of real conversations were
  never asked at all — measured over 412 conversations, of which 48.8% are a single
  message. `scratch/trigger-coverage.mjs` recomputes this from `chat_logs` +
  `active_visitors.last_seen` (use that for presence — a session's last chat_logs row can
  be an agent reply days later and will tell you a bounced visitor stayed 16 days).

## 8. Domain facts worth knowing

- **Lead sources are encoded as a message prefix**, not a column: `[Custom Quote] ` and
  `[Checkout] ` (`lib/quoteintake.ts`). `cleanQuoteSubject()` tidies a subject for
  DISPLAY (Gmail writes inline images into it as `[image: 📋]`). Keep it out of
  `stripQuoteTag`, which feeds `normalizeQuoteBody` — the dedupe key. Changing what
  the dedupe sees would shift every existing key and let previously-deduped forwards
  back in as new leads.
- **Checkout leads count in TOTAL but never in BILLABLE.** The UI's "N overlaps removed"
  line compares against `billableBase`, not `total`.
- Email-only leads have no chat session and use the synthetic id `quote-<leadId>` —
  the same id the Billing tab already uses. `/leads/<id>` accepts both forms.
- Lead dedupe has three rules in `app/api/quote-intake`, each added after a real
  duplicate got through. The same person contacting two **different sites** is two
  leads, not a duplicate — the site is part of every dedupe key.
