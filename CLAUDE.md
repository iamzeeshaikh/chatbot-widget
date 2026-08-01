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

## 8. Domain facts worth knowing

- **Lead sources are encoded as a message prefix**, not a column: `[Custom Quote] ` and
  `[Checkout] ` (`lib/quoteintake.ts`).
- **Checkout leads count in TOTAL but never in BILLABLE.** The UI's "N overlaps removed"
  line compares against `billableBase`, not `total`.
- Email-only leads have no chat session and use the synthetic id `quote-<leadId>` —
  the same id the Billing tab already uses. `/leads/<id>` accepts both forms.
- Lead dedupe has three rules in `app/api/quote-intake`, each added after a real
  duplicate got through. The same person contacting two **different sites** is two
  leads, not a duplicate — the site is part of every dedupe key.
