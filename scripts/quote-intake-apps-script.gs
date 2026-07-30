/**
 * ZeeOps Custom-Quote Lead Intake — Google Apps Script
 *
 * Runs entirely inside your own Gmail account (script.google.com), completely
 * free, no third-party service, no cost regardless of volume.
 *
 * LABEL-ONLY: this only ever touches emails that already carry one of YOUR
 * OWN site labels (SCB, TTP, SFB, KBP, TBB, ZCB, TCP, TPC — see SITE_CODES
 * below). It never guesses from sender/subject text, so it can never pick up
 * spam — if you haven't labeled it, it's invisible here. Delete spam as you
 * already do; label the real ones and they'll be picked up on a later run,
 * no matter how deeply nested.
 *
 * HOW IT FINDS MAIL: the automatic run (processQuoteLeads, on your 30-min
 * trigger) searches your WHOLE mailbox for mail from the last RECENT_DAYS
 * days that isn't already marked Processed/Unmatched, then checks each
 * candidate's own labels to see if it's one of yours. This is deliberately
 * NOT a `label:"Site/Path"` text search — Gmail's search operator doesn't
 * reliably match nested labels like "Extra Outsource Projects/SCB" even
 * quoted with the full path (an earlier version relied on that and silently
 * found nothing for weeks). And it's deliberately not "list every thread
 * under this label" either — a site label with a big historical backlog has
 * more threads than any run can safely re-scan, and Gmail doesn't return
 * them newest-first, so a fixed per-label cap silently missed brand new
 * leads once a label passed it. Genuine new mail is always recent, so the
 * date window doesn't lose anything day-to-day. If you ever go back and
 * label something OLDER than RECENT_DAYS, run processQuoteLeadsBackfill by
 * hand once to sweep it in (see that function).
 *
 * QUOTA: a personal Gmail account gets a modest daily allowance of Gmail API
 * calls from Apps Script. Running this MUCH more often than the recommended
 * 30-minute trigger (e.g. "every minute") re-scans the same mail far more
 * often than needed and can burn through that allowance in a few hours,
 * failing with "Service invoked too many times for one day: gmail" for the
 * rest of the day. If you ever see that error, widen the trigger interval
 * (Triggers → edit → every 30 min, not more often) and wait for the quota to
 * reset (~24h from when it started failing) — nothing is lost either way,
 * since whatever a run can't get to just waits for the next one.
 *
 * TIME BUDGET: Apps Script kills any run after 6 minutes. This script checks
 * the clock as it works and stops itself cleanly at ~4.5 minutes, logging
 * how far it got. Nothing is lost — whatever it finished is marked
 * Processed, and your recurring trigger (every 30 min) picks up the rest
 * next time.
 *
 * SETUP (5 minutes, one time):
 *   1. Go to https://script.google.com → New project.
 *   2. Select all the placeholder code, delete it, paste this whole file in.
 *   3. Save (Cmd/Ctrl+S).
 *   3b. ⚙ Project Settings → Script Properties → Add script property →
 *      name `ZEEOPS_WEBHOOK_SECRET`, value = the QUOTE_INTAKE_SECRET set on
 *      the server. Required — the secret is deliberately NOT in this file
 *      (it's a public repo). Everything below fails with a clear error
 *      until this property exists.
 *   4. Run `testConnection` once (▶ Run, pick it from the function dropdown)
 *      — Google will ask you to authorize; allow it (Advanced → Go to
 *      [project] (unsafe) → Allow — normal for a script you wrote yourself).
 *      Execution log should say "OK: webhook reachable".
 *   5. If you have OLD mail already labeled (older than RECENT_DAYS), run
 *      `processQuoteLeadsBackfill` first — may need a few manual runs
 *      back-to-back (each one chips away ~4.5 minutes' worth). Otherwise
 *      just run `processQuoteLeads` once.
 *   6. Clock icon (Triggers) on the left → Add Trigger → function
 *      processQuoteLeads, Time-driven, Minutes timer, every 30 minutes →
 *      Save. That trigger is what keeps it caught up automatically from
 *      here on — processQuoteLeadsBackfill is manual-only, never on a
 *      trigger.
 *
 * WHAT STOPS DOUBLE-SENDING: a message-date watermark stored in this script's
 * properties (ZEEOPS_LAST_RUN_MS), NOT the Gmail labels. Labels are
 * thread-level, and a form-notification thread keeps receiving new
 * submissions — treating "thread handled" as "done" silently hid every later
 * message in it. The labels below are now only a human-readable trail.
 *
 * Every email it successfully sends gets the Gmail label "ZeeOps/Processed"
 * (auto-created) so it's never sent twice. One that's labeled with a site
 * code but has no readable email/phone gets "ZeeOps/Unmatched" instead, so
 * it doesn't retry forever — check those by hand occasionally.
 */

// ── Config ───────────────────────────────────────────────────────────────
var WEBHOOK_URL = 'https://chat.zeeops.dev/api/quote-intake';

// The shared secret is read from this project's Script Properties, NOT written
// here. This file lives in a PUBLIC GitHub repo, and an earlier version had the
// secret as a plain string in it — which meant anyone reading the repo could
// POST fake leads to the webhook. Never paste the value into this file; keep it
// in Script Properties, where it stays out of git for good.
//
// ONE-TIME SETUP: Apps Script → ⚙ Project Settings → Script Properties →
//   Add script property → name: ZEEOPS_WEBHOOK_SECRET, value: <the secret>
// A wrong or missing value shows up immediately as a 401 from testConnection.
function webhookSecret_() {
  var v = PropertiesService.getScriptProperties().getProperty('ZEEOPS_WEBHOOK_SECRET');
  if (!v) {
    throw new Error('Script property ZEEOPS_WEBHOOK_SECRET is not set — ' +
      'Project Settings → Script Properties → add ZEEOPS_WEBHOOK_SECRET.');
  }
  return v;
}
var PROCESSED_LABEL = 'ZeeOps/Processed';
var SKIPPED_LABEL = 'ZeeOps/Unmatched'; // labeled with a site code, but no email/phone found in the body

// Your Gmail label names that mean "this is a real lead for this site" —
// matches lib/quoteintake.ts QUOTE_SITE_CODES on the server exactly. Matched
// by LEAF name (the part after the last "/"), so it doesn't matter which
// parent folder each one lives under. Add a line here the day you start
// labeling a new site (e.g. once TPC exists for The Paper Cups).
// Only codes that are ACTUALLY used as Gmail label leaf names belong here — a
// code listed here claims every thread carrying that label. TCS is confirmed
// from a real thread ("Extra Outsource Projects/tcs"). The rest of the 2026-07
// roster is in SITE_DOMAINS below but deliberately NOT here: their label names
// haven't been seen yet, and guessing one that means something else in this
// mailbox would file leads under the wrong site. Run listSiteLabels to see
// which labels exist and add them as they're confirmed.
var SITE_CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC', 'PB', 'TCS'];

// ── Checkout (cart order) emails ────────────────────────────────────────────
// WooCommerce "New order #6449" notifications live under ONE flat label rather
// than a per-site one, so the site has to come from somewhere else. These mails
// carry the store name in the subject — "[Shop Cardboard Boxes]: New order
// #6449" — which WooCommerce fills in from the store's own settings, so it is
// the store identifying itself rather than us guessing from sender text.
//
// Only consulted for threads under CHECKOUT_LABEL that carry no site-code
// label; a site-code label always wins. Unrecognised store names go to
// ZeeOps/Unmatched instead of being attributed to the wrong site.
var CHECKOUT_LABEL = 'checkout';

var STORE_NAME_CODES = {
  'shop cardboard boxes': 'SCB',
  'the tube packaging': 'TTP',
  'small food boxes': 'SFB',
  'kraft box pack': 'KBP',
  'the burger boxes': 'TBB',
  'zee custom boxes': 'ZCB',
  'the candle packaging': 'TCP',
  'the paper cups': 'TPC',
  'peptides boxes': 'PB',
  'the coffee sleeves': 'TCS',
  'the wax papers': 'TWP',
  'the custom stickers': 'TCST',
  'zeepack': 'ZP',
  'the cereal boxes': 'TCRB',
  'hotdog trays': 'HDT',
  'the burger sleeves': 'TBSL',
  'the candle sleeves': 'TCSL',
  'cardboard cups': 'CBC',
  'shop bubble mailers': 'SBM',
  'inserts hub': 'IH',
  'the die cut stickers': 'TDCS',
  'custom perfume boxes': 'CPB',
  'shop display boxes': 'SDB',
};

// Own domain per site code — used to make sure a lead's "email" is never the
// site's own notification address (see parseLeadBody_ below).
var SITE_DOMAINS = {
  SCB: 'shopcardboardboxes.com',
  TTP: 'thetubepackaging.com',
  SFB: 'smallfoodboxes.com',
  KBP: 'kraftboxpack.com',
  TBB: 'theburgerboxes.com',
  ZCB: 'zeecustomboxes.com',
  TCP: 'thecandlepackaging.com',
  TPC: 'thepapercups.com',
  PB: 'peptidesboxes.com',
  // Full 2026-07 roster. Two jobs here, both independent of Gmail labels:
  // codeFromBodyUrl_ resolves a form's "Page URL:" host to one of these, and
  // isOwnAddress_ uses them to make sure a site's own noreply@ address is never
  // recorded as the customer's (this mail is literally from
  // noreply@thecoffeesleeves.com).
  TCS: 'thecoffeesleeves.com',
  TWP: 'thewaxpapers.co',
  TCST: 'thecustomstickers.co',
  ZP: 'zeepack.co',
  TCRB: 'thecerealboxes.com',
  HDT: 'hotdogtrays.com',
  TBSL: 'theburgersleeves.com',
  TCSL: 'thecandlesleeves.com',
  CBC: 'cardboardcups.com',
  SBM: 'shopbubblemailers.com',
  IH: 'insertshub.com',
  TDCS: 'thediecutstickers.com',
  CPB: 'customperfumeboxes.com',
  SDB: 'shopdisplayboxes.com',
};

// Stop working with this much headroom before Apps Script's 6-minute limit.
var TIME_BUDGET_MS = 4.5 * 60 * 1000;
// How many threads to list per label — used only by the listSiteLabels
// diagnostic below now (see processQuoteLeads for why the real run doesn't
// rely on this cap anymore).
var MAX_THREADS_PER_LABEL = 150;
// processQuoteLeads only looks at mail from the last N days — a site label
// with a big historical backlog (ZCB, TCP) has MORE threads than any single
// run could safely re-scan, and Gmail's per-label thread order isn't
// reliably newest-first, so a fixed "first 150" cap silently missed brand
// new leads once a label passed that count (found via a real report: 3
// same-day ZCB leads never arrived, all already correctly labeled). Genuine
// new mail is always recent, so this window doesn't lose anything — the
// bigger the number, the more quota a run spends re-checking old mail.
//
// SIZED FOR THE GMAIL QUOTA, not for "as much as possible". Checking a
// thread's labels costs one Gmail call, so a run costs roughly one call per
// candidate thread. At 30 days / 500 threads with the recommended 30-minute
// trigger that is ~500 × 48 = ~24,000 calls a day — over a personal account's
// daily allowance, which is exactly how this hit "Service invoked too many
// times for one day: gmail" on 2026-07-28. Seven days at this mailbox's
// volume is ~120 threads per run (~6,000/day), with plenty of headroom.
// Raising either number multiplies daily quota use — don't, unless the
// trigger interval is widened by the same factor.
//
// The trade-off is deliberate: labelling an email OLDER than RECENT_DAYS no
// longer gets picked up automatically. Run processQuoteLeadsBackfill by hand
// after doing that. (The checkout sweep below has no date window at all, so
// order mail is unaffected either way.)
// Gmail labels are THREAD-level, so "this thread is done" is the wrong unit of
// work — a form-notification thread keeps receiving new submissions, and any
// message arriving after the thread was labelled Processed became invisible to
// the search below. (Found live: Levi Lyons' 28 Jul enquiry landed in the ZCB
// thread that already carried Processed and was never ingested — the thread
// showed "19 deleted messages", i.e. every earlier submission had been in it
// too.) The unit of work is therefore a MESSAGE DATE, kept here: everything
// newer than this watermark gets processed, whatever its thread is labelled.
// The overlap re-covers the seam so a message arriving mid-run is never lost;
// re-sending a message is harmless because the server dedupes.
var LAST_RUN_KEY = 'ZEEOPS_LAST_RUN_MS';
var WATERMARK_OVERLAP_MS = 15 * 60 * 1000;
// First run only (no watermark stored yet) — how far back to reach.
var FIRST_RUN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

var RECENT_DAYS = 7;
// Sized for a CATCH-UP run (after rewindWatermark), not for the steady state —
// a normal 30-minute run returns a handful of threads, so this ceiling only
// comes into play when re-covering days at once, and being cut short there is
// exactly the case that loses leads. Reached by PAGING: GmailApp.search
// rejects a `max` above 500 outright ("Argument max cannot exceed 500"), so
// anything larger has to be fetched a page at a time.
var MAX_CANDIDATE_THREADS = 1500;
var SEARCH_PAGE_SIZE = 500; // Gmail's hard per-call limit
// How many threads the dedicated checkout sweep walks per run (see
// sweepCheckoutLabel_ for why checkout can't rely on the search above).
// Same quota maths: every thread here costs a call on every run.
var CHECKOUT_SWEEP_MAX = 150;

// ── Entry points ─────────────────────────────────────────────────────────

function testConnection() {
  var res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-quote-secret': webhookSecret_() },
    payload: JSON.stringify({ siteCode: 'SCB', email: '' }), // intentionally invalid — just checking auth wiring
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 400) Logger.log('OK: webhook reachable, auth accepted.');
  else if (code === 401) Logger.log('FAILED: webhook rejected the secret (401). Check the ZEEOPS_WEBHOOK_SECRET script property matches the server.');
  else Logger.log('Unexpected response ' + code + ': ' + res.getContentText());
}

// Diagnostic: lists every Gmail label that matches one of SITE_CODES, and
// roughly how many threads sit under each (capped, time-budgeted the same
// way as the real run), WITHOUT sending anything.
function listSiteLabels() {
  var start = Date.now();

  // First, the cheap and most useful half: every short label leaf this mailbox
  // has that is NOT a recognised site code. 14 of the 23 packaging sites have
  // no code yet, so any thread filed under one of their labels is silently
  // ignored — this is how you find their real names instead of guessing them.
  // One getUserLabels() call, no thread listing, so it costs almost nothing.
  var everyLabel = GmailApp.getUserLabels();
  var unknown = [];
  for (var u = 0; u < everyLabel.length; u++) {
    var full = everyLabel[u].getName();
    if (full.indexOf('ZeeOps/') === 0) continue;            // our own bookkeeping
    var leafName = full.split('/').pop().trim();
    if (SITE_CODES.indexOf(leafName.toUpperCase()) !== -1) continue;
    if (leafName.toLowerCase() === CHECKOUT_LABEL) continue;
    if (leafName.length <= 5) unknown.push(full);           // short = looks like a code
  }
  Logger.log('Short labels NOT recognised as site codes (add the real ones to SITE_CODES): ' +
    (unknown.join('   |   ') || 'none'));

  var found = findSiteLabels_();
  var codes = Object.keys(found);
  if (codes.length === 0) {
    Logger.log('No Gmail labels matched any of: ' + SITE_CODES.join(', '));
    return;
  }
  for (var i = 0; i < codes.length; i++) {
    if (Date.now() - start > TIME_BUDGET_MS) { Logger.log('(stopped early — time budget)'); break; }
    var label = found[codes[i]];
    var n = label.getThreads(0, MAX_THREADS_PER_LABEL).length;
    var suffix = n === MAX_THREADS_PER_LABEL ? '+ (capped)' : '';
    Logger.log(codes[i] + ' → "' + label.getName() + '" (' + n + suffix + ' threads)');
  }
}

// MANUAL USE ONLY — not on the trigger. processQuoteLeads only looks at
// mail from the last RECENT_DAYS days, so if you ever go back and label a
// genuinely OLD email (older than that), it won't be picked up
// automatically. Run this by hand afterward to sweep everything under every
// site label regardless of age, same as the very first backlog clear-out.
// Safe to run repeatedly (already-handled threads are skipped instantly).
function processQuoteLeadsBackfill() {
  var start = Date.now();
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);
  var siteLabels = findSiteLabels_();

  var sent = 0, skipped = 0, seen = {}, stoppedEarly = false;
  var BACKFILL_MAX_THREADS_PER_LABEL = 3000;

  // `checkout` isn't a site-code label, so the loop below never reaches it.
  // Sweep it here with no date window — that's what pulls in an existing
  // backlog of order mail.
  var co = sweepCheckoutLabel_(start, processedLabel, skippedLabel, BACKFILL_MAX_THREADS_PER_LABEL);
  sent += co.sent; skipped += co.skipped;
  if (co.stoppedEarly) stoppedEarly = true;

  outer:
  for (var code in siteLabels) {
    if (stoppedEarly || Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break outer; }
    var threads = siteLabels[code].getThreads(0, BACKFILL_MAX_THREADS_PER_LABEL);
    for (var t = 0; t < threads.length; t++) {
      if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break outer; }
      var thread = threads[t];
      var id = thread.getId();
      if (seen[id]) continue;
      seen[id] = true;
      // Deliberately NOT skipping already-labelled threads. This is the
      // catch-all sweep — its whole job is to re-read everything under a site
      // label, including the threads the main run marked Processed after
      // handling only the messages that existed at the time. Anything already
      // ingested comes straight back as `deduped` from the server, so a
      // re-read costs a request and nothing else.

      var messages = thread.getMessages();
      var handledAny = false;
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var parsed = parseLeadBody_(msg.getPlainBody());
        if (!parsed.email && !parsed.phone) continue;
        if (postLead_(code, parsed, msg.getDate())) { sent++; handledAny = true; }
      }
      if (handledAny) thread.addLabel(processedLabel);
      else { thread.addLabel(skippedLabel); skipped++; }
    }
  }
  Logger.log('processQuoteLeadsBackfill: sent=' + sent + ' skipped=' + skipped +
    (stoppedEarly ? ' — stopped early (time budget); run again to continue.' : ' — done, nothing left to process.'));
}

function processQuoteLeads() {
  var start = Date.now();
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);

  var sent = 0, skipped = 0, notOurs = 0, stoppedEarly = false;
  var noLabel = 0, siteLabeled = 0; // for the summary line

  // Checkout FIRST, before the general search spends the time budget — order
  // mail must never be starved by a mailbox full of unrelated threads.
  var co = sweepCheckoutLabel_(start, processedLabel, skippedLabel, CHECKOUT_SWEEP_MAX);
  sent += co.sent; skipped += co.skipped;
  if (co.stoppedEarly) {
    Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped +
      ' (checkout sweep only) — stopped early (time budget); rest will be picked up on the next run.');
    return;
  }

  // ONE search across the whole mailbox for recent mail — not scoped to any
  // particular site label, so there's no nested-label text-matching to get
  // wrong (that's what broke v5's search).
  //
  // Deliberately NOT excluding Processed/Unmatched any more. Those labels sit
  // on the THREAD, and a form-notification thread goes on receiving new
  // submissions forever, so excluding it hid every message that arrived after
  // the first one was handled. The message-date watermark below is what stops
  // the same message being sent twice.
  var cutoff = readWatermark_();
  // Scope the search to the watermark, not to a fixed RECENT_DAYS window — on a
  // 30-minute trigger that is a handful of threads instead of a week's worth,
  // which both slashes the Gmail quota AND keeps the run clear of
  // MAX_CANDIDATE_THREADS. Hitting that cap means the run silently never looked
  // at the oldest threads in its window, so it is warned about below.
  //
  // yyyy/MM/dd, NOT a Unix timestamp. Gmail's own search box accepts an epoch
  // in `after:`, but GmailApp.search does not — swapping to one took a run that
  // had been scanning 250 threads down to 3, silently. Day granularity means
  // the window is always a little wider than needed; that is harmless now the
  // search pages up to MAX_CANDIDATE_THREADS, and the watermark still decides
  // message by message what actually gets sent.
  var since = new Date(cutoff - 24 * 60 * 60 * 1000);
  var query = 'after:' + Utilities.formatDate(since, Session.getScriptTimeZone(), 'yyyy/MM/dd');
  var threads = [];
  for (var off = 0; off < MAX_CANDIDATE_THREADS; off += SEARCH_PAGE_SIZE) {
    var want = Math.min(SEARCH_PAGE_SIZE, MAX_CANDIDATE_THREADS - off);
    var batch = GmailApp.search(query, off, want);
    threads = threads.concat(batch);
    if (batch.length < want) break;               // last page
    if (Date.now() - start > TIME_BUDGET_MS) break;
  }
  if (threads.length >= MAX_CANDIDATE_THREADS) {
    Logger.log('WARNING: hit the ' + MAX_CANDIDATE_THREADS + '-thread ceiling — the oldest threads in this window went unread. Run again to continue.');
  }

  for (var t = 0; t < threads.length; t++) {
    if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break; }

    var thread = threads[t];
    var code = matchSiteCode_(thread); // null if it doesn't carry one of our site labels
    if (!code) {
      // Last line of defence: a genuine form notification nobody labelled.
      // Decided from the form's own machine-generated footer ("Page URL:
      // https://<site>/…", written by the site itself), never from sender or
      // subject text — so the label-only guarantee against spam still holds,
      // and only hosts already in SITE_DOMAINS can match.
      //
      // Read here rather than via a separate `"Page URL:"` search: Gmail's
      // quoted-phrase search containing a colon is unreliable, and this is
      // exactly the path that must not fail quietly. It costs a body read per
      // unlabelled thread WITH NEW MESSAGES, which the watermark keeps to a
      // handful on a normal run.
      var fbAny = false;
      var umsgs = thread.getMessages();
      for (var um = 0; um < umsgs.length; um++) {
        if (umsgs[um].getDate().getTime() <= cutoff) continue;
        var ubody = umsgs[um].getPlainBody();
        var ucode = codeFromBodyUrl_(ubody);
        if (!ucode) continue;
        var uparsed = parseLeadBody_(ubody);
        if (!uparsed.email && !uparsed.phone) continue;
        if (postLead_(ucode, uparsed, umsgs[um].getDate())) { sent++; noLabel++; fbAny = true; }
      }
      if (fbAny) { thread.addLabel(processedLabel); continue; }

      // A checkout thread whose store name isn't in STORE_NAME_CODES would
      // otherwise be re-scanned forever. Park it in Unmatched so it shows up as
      // something to fix (add the store name) rather than silently vanishing.
      if (hasCheckoutLabel_(thread) && !isHandled_(thread)) { thread.addLabel(skippedLabel); skipped++; }
      else notOurs++;
      continue;
    }
    siteLabeled++;

    var messages = thread.getMessages();
    var handledAny = false, considered = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      if (msg.getDate().getTime() <= cutoff) continue; // already covered by an earlier run
      considered++;
      var parsed = parseLeadBody_(msg.getPlainBody());
      if (!parsed.email && !parsed.phone) continue;
      if (postLead_(code, parsed, msg.getDate())) { sent++; handledAny = true; }
      // On failure, leave the watermark alone so a later run retries it.
    }
    // Nothing new in this thread — leave its labels exactly as they are, or an
    // old fully-handled thread would get re-flagged Unmatched on every run.
    if (considered === 0) continue;
    if (handledAny) thread.addLabel(processedLabel);
    else { thread.addLabel(skippedLabel); skipped++; }
  }

  // Safety net for the one failure the label model can't see: a genuine form
  // notification that carries NO site label at all — nobody filed it, or Gmail
  // threaded it somewhere unexpected. Found live: a zeecustomboxes enquiry
  // (Levi Lyons, 28 Jul) that never reached the dashboard.
  //
  // This does NOT relax the label-only rule into guessing from sender or
  // subject text. It keys off the form's own machine-generated footer — the
  // "Page URL: https://<site>/..." line the site itself writes — and only
  // accepts a host that is already one of ours in SITE_DOMAINS. Spam can't
  // manufacture that without genuinely being a submission on that site, and
  // the server's own spam rules still apply on top.
  if (noLabel > 0) Logger.log('no-label fallback: ingested ' + noLabel + ' form submission(s) whose thread carried NO site label — worth labelling those threads.');

  // Only advance the watermark on a complete pass. A run cut short by the time
  // budget must leave it where it was, so the next run re-covers the remainder.
  if (!stoppedEarly) saveWatermark_(start);
  Logger.log('processQuoteLeads: sent=' + sent + ' (' + noLabel + ' via no-label fallback) skipped=' + skipped +
    ' (scanned ' + threads.length + ' threads since the watermark, ' + siteLabeled + ' site-labeled, ' + notOurs + ' not ours)' +
    (stoppedEarly ? ' — stopped early (time budget); rest will be picked up on the next run.' : ' — done, nothing left to process.'));
}

// Pull the watermark back so the next processQuoteLeads run re-covers the last
// REWIND_DAYS days. Needed whenever the script gains a new way of finding mail
// — the watermark has already moved past the messages the OLD code couldn't
// see, so without this they stay invisible forever. Costs no Gmail quota at
// all (it only writes a property); everything already ingested comes straight
// back as `deduped` from the server.
var REWIND_DAYS = 7;

function rewindWatermark() {
  var target = Date.now() - REWIND_DAYS * 24 * 60 * 60 * 1000;
  saveWatermark_(target + WATERMARK_OVERLAP_MS); // readWatermark_ subtracts the overlap again
  Logger.log('Watermark rewound to ' + new Date(target) +
    '. Run processQuoteLeads once now — it will re-read everything since then.');
}

// Why did THIS email never become a lead? Put anything that identifies it in
// DIAGNOSE_QUERY (an address, a subject, "from:someone") and run this. It sends
// nothing and changes nothing — it just prints, for every matching thread: the
// labels Gmail actually has on it, whether those resolve to one of our site
// codes, and for each message whether it is newer than the watermark and what
// the parser can read out of it. Between those four facts, exactly one will be
// the reason.
var DIAGNOSE_QUERY = 'lyonslevi298@gmail.com';

function diagnoseThread() {
  var threads = GmailApp.search(DIAGNOSE_QUERY, 0, 5);
  if (!threads.length) { Logger.log('No thread matched: ' + DIAGNOSE_QUERY); return; }
  var cutoff = readWatermark_();
  Logger.log('watermark cutoff = ' + new Date(cutoff) + '  (messages at or before this are treated as already covered)');
  for (var i = 0; i < threads.length; i++) {
    var th = threads[i];
    var names = th.getLabels().map(function (l) { return l.getName(); });
    var code = matchSiteCode_(th);
    Logger.log('--- thread ' + (i + 1) + ': ' + th.getFirstMessageSubject());
    Logger.log('    labels    : ' + (names.join('  |  ') || '(none)'));
    Logger.log('    site code : ' + (code || 'NONE — this is why it is skipped'));
    var msgs = th.getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      var p = parseLeadBody_(m.getPlainBody());
      Logger.log('    msg ' + (j + 1) + '  ' + m.getDate() +
        '  | newer than watermark: ' + (m.getDate().getTime() > cutoff) +
        '  | email: ' + (p.email || 'NONE') +
        '  | phone: ' + (p.phone || 'NONE'));
    }
  }
}

// Re-try everything sitting in ZeeOps/Unmatched. That label means "carried one
// of your site labels but the parser found no email or phone", which is a
// permanent verdict — the thread is never looked at again. So whenever the
// parser gets BETTER, the mail it previously gave up on has to be released by
// hand; that's what this does. (It found five real leads the first time, all
// forwarded customer emails whose address lived only in the From: header.)
//
// Manual-only, never on a trigger. Threads it still can't read go straight back
// to Unmatched, so running it twice costs nothing and changes nothing.
function retryUnmatched() {
  var start = Date.now();
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);
  var threads = skippedLabel.getThreads(0, 200);
  var sent = 0, stillStuck = 0, stoppedEarly = false;

  for (var t = 0; t < threads.length; t++) {
    if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break; }
    var thread = threads[t];
    var code = matchSiteCode_(thread);
    if (!code) { stillStuck++; continue; } // no site label at all — leave it alone

    var messages = thread.getMessages();
    var handledAny = false;
    for (var m = 0; m < messages.length; m++) {
      var parsed = parseLeadBody_(messages[m].getPlainBody());
      if (!parsed.email && !parsed.phone) continue;
      if (postLead_(code, parsed, messages[m].getDate())) { sent++; handledAny = true; }
    }
    if (handledAny) { thread.removeLabel(skippedLabel); thread.addLabel(processedLabel); }
    else stillStuck++;
  }
  Logger.log('retryUnmatched: sent=' + sent + ' stillUnreadable=' + stillStuck + ' (of ' + threads.length + ' unmatched threads)' +
    (stoppedEarly ? ' — stopped early (time budget); run again to continue.' : ' — done.'));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function readWatermark_() {
  var v = parseInt(PropertiesService.getScriptProperties().getProperty(LAST_RUN_KEY), 10);
  if (!v) return Date.now() - FIRST_RUN_LOOKBACK_MS;
  return v - WATERMARK_OVERLAP_MS;
}

function saveWatermark_(ms) {
  PropertiesService.getScriptProperties().setProperty(LAST_RUN_KEY, String(ms));
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function isHandled_(thread) {
  var labels = thread.getLabels();
  for (var i = 0; i < labels.length; i++) {
    var n = labels[i].getName();
    if (n === PROCESSED_LABEL || n === SKIPPED_LABEL) return true;
  }
  return false;
}

// Every Gmail label (any nesting depth) whose LEAF name matches a site code.
// Uses label OBJECTS (GmailApp.getUserLabels() + label.getThreads()), not a
// text search string — Gmail's `label:` search operator does not reliably
// match nested labels by leaf name.
// Walk the flat `checkout` label directly instead of hoping the searches above
// reach it. BOTH entry points need this:
//   • processQuoteLeads searches the newest MAX_CANDIDATE_THREADS threads of the
//     last RECENT_DAYS days. A busy mailbox fills that cap with unrelated mail
//     (a real run scanned 500 and found 495 irrelevant), pushing older checkout
//     orders out of view — permanently, because unrelated threads are never
//     labeled and so never leave the candidate set.
//   • processQuoteLeadsBackfill only walks SITE_CODES labels, and `checkout`
//     isn't one of them, so it never saw these threads at all.
// Walking the label itself is bounded, can't be crowded out, and has no date
// window — which is exactly what a mailbox with a backlog of order mail needs.
function sweepCheckoutLabel_(start, processedLabel, skippedLabel, max) {
  var out = { sent: 0, skipped: 0, stoppedEarly: false };
  var label = findCheckoutLabel_();
  if (!label) return out; // no checkout label in this mailbox — nothing to do
  var cutoff = readWatermark_(); // same message-date rule as the main run
  var threads = label.getThreads(0, max);
  for (var t = 0; t < threads.length; t++) {
    if (Date.now() - start > TIME_BUDGET_MS) { out.stoppedEarly = true; return out; }
    var thread = threads[t];
    // A site-code label on the thread still wins over the subject's store name.
    var code = matchSiteCode_(thread);
    var messages = thread.getMessages();
    var handledAny = false, considered = 0;
    for (var m = 0; m < messages.length; m++) {
      if (messages[m].getDate().getTime() <= cutoff) continue;
      considered++;
      if (!code) continue;
      var parsed = parseLeadBody_(messages[m].getPlainBody());
      if (!parsed.email && !parsed.phone) continue;
      if (postLead_(code, parsed, messages[m].getDate())) { out.sent++; handledAny = true; }
    }
    if (considered === 0) continue;
    if (handledAny) thread.addLabel(processedLabel);
    else { thread.addLabel(skippedLabel); out.skipped++; }
  }
  return out;
}

// "Page URL: https://zeecustomboxes.com/product/..." -> "ZCB". Returns null for
// any host that isn't one of ours, so this can only ever resolve to a site we
// already own.
function codeFromBodyUrl_(body) {
  var m = String(body || '').match(/Page URL:\s*<?\s*(https?:\/\/[^\s>]+)/i);
  if (!m) return null;
  var host = m[1].replace(/^https?:\/\//i, '').split('/')[0].toLowerCase().replace(/^www\./, '');
  for (var code in SITE_DOMAINS) {
    if (SITE_DOMAINS[code].toLowerCase() === host) return code;
  }
  return null;
}

function findCheckoutLabel_() {
  var all = GmailApp.getUserLabels();
  for (var i = 0; i < all.length; i++) {
    var parts = all[i].getName().split('/');
    if (parts[parts.length - 1].trim().toLowerCase() === CHECKOUT_LABEL) return all[i];
  }
  return null;
}

function findSiteLabels_() {
  var all = GmailApp.getUserLabels();
  var found = {};
  for (var i = 0; i < all.length; i++) {
    var name = all[i].getName();
    var parts = name.split('/');
    var leaf = parts[parts.length - 1].trim().toUpperCase();
    if (SITE_CODES.indexOf(leaf) !== -1 && !found[leaf]) found[leaf] = all[i];
  }
  return found;
}

// Does this thread carry one of our site labels (any nesting depth, matched
// by LEAF name)? Returns the site code, or null. Checking the thread's own
// labels directly (not a text search) is what correctly handles nested
// labels — same reasoning as findSiteLabels_ above.
function matchSiteCode_(thread) {
  var labels = thread.getLabels();
  var hasCheckout = false;
  for (var i = 0; i < labels.length; i++) {
    var name = labels[i].getName();
    var parts = name.split('/');
    var leaf = parts[parts.length - 1].trim();
    if (SITE_CODES.indexOf(leaf.toUpperCase()) !== -1) return leaf.toUpperCase();
    if (leaf.toLowerCase() === CHECKOUT_LABEL) hasCheckout = true;
  }
  // No site label, but it is a checkout thread — read the store name out of the
  // subject instead (see STORE_NAME_CODES).
  if (hasCheckout) return codeFromSubject_(thread.getFirstMessageSubject());
  return null;
}

function hasCheckoutLabel_(thread) {
  var labels = thread.getLabels();
  for (var i = 0; i < labels.length; i++) {
    var parts = labels[i].getName().split('/');
    if (parts[parts.length - 1].trim().toLowerCase() === CHECKOUT_LABEL) return true;
  }
  return false;
}

// "[Shop Cardboard Boxes]: New order #6449" → "SCB". Returns null when the
// subject has no bracketed store name, or the name isn't one we know — the
// caller then sends the thread to ZeeOps/Unmatched rather than guessing.
function codeFromSubject_(subject) {
  var m = String(subject || '').match(/\[([^\]]+)\]/);
  if (!m) return null;
  var store = m[1].trim().toLowerCase();
  return STORE_NAME_CODES[store] || null;
}

// Lead-form emails list field VALUES one per line with no labels (e.g.
// "Rigid Boxes / suzanne@gmail.com / 8525144962"). We don't try to guess
// which line is which beyond email/phone (regex-detectable); the FULL raw
// body always rides along as `message` so nothing is ever lost even if a
// field gets mis-labeled — you can always read the original text on the
// dashboard (hover the 📧 Quote badge).
//
// Some leads get manually forwarded into a label instead of arriving there
// directly, which prepends Gmail's own "---------- Forwarded message
// ---------" / From: / Date: / Subject: / To: header block ABOVE the real
// form content. Those headers carry a notification address — USUALLY the
// site's own domain, but not always: The Paper Cups' form notifications
// actually send from an @zeecustomboxes.com address (same underlying
// WordPress setup), so checking only the CURRENT site's own domain missed
// it and grabbed zeecustomboxes.com's address as if it were the customer's.
// Check against EVERY one of our own site domains, not just the current
// one, since a forward's header can reference any of them. Skip the header
// block itself, and keep scanning until a real (non-self) address turns up.
function isOwnDomain_(email) {
  var lower = email.toLowerCase();
  for (var code in SITE_DOMAINS) {
    if (lower.indexOf('@' + SITE_DOMAINS[code].toLowerCase()) !== -1) return true;
  }
  return false;
}

// Anything that must never be mistaken for a customer's address: our site
// domains, this Gmail account itself, plus any extra addresses you forward
// from. The account's own address matters because YOU are the one forwarding
// these threads — without this the From-header fallback below would happily
// record your own address as the lead's.
var OWN_EMAILS = []; // add any other address you forward from, e.g. 'you@work.com'

function isOwnAddress_(email) {
  var lower = email.toLowerCase();
  if (isOwnDomain_(lower)) return true;
  for (var i = 0; i < OWN_EMAILS.length; i++) {
    if (lower === String(OWN_EMAILS[i]).toLowerCase()) return true;
  }
  try {
    var me = Session.getActiveUser().getEmail(); // no Gmail quota cost
    if (me && lower === me.toLowerCase()) return true;
  } catch (e) {}
  return false;
}

// Some forms LABEL their fields instead of listing bare values — Peptides
// Boxes sends "Full name: Joey Pannell / Business email: … / Phone: 12562210417".
// The bare-value logic below can't read those: "Phone: 12562210417" fails the
// digits-only test (it has letters), so the number was silently dropped, and
// the first junk line ("New enquiry from peptidesboxes.com") became the name.
// Labels win when present; anything unlabeled still falls through to the
// original positional handling, so the older forms behave exactly as before.
var FIELD_LABELS = {
  name: ['full name', 'name', 'your name', 'customer name', 'contact name'],
  email: ['business email', 'email', 'email address', 'e-mail', 'your email'],
  phone: ['phone', 'phone number', 'contact number', 'mobile', 'mobile number', 'telephone'],
  product: ['enquiry from page', 'inquiry from page', 'product', 'product name', 'interested in'],
};

function fieldForLabel_(label) {
  var k = label.toLowerCase().trim();
  for (var field in FIELD_LABELS) {
    if (FIELD_LABELS[field].indexOf(k) !== -1) return field;
  }
  return null;
}

function parseLeadBody_(body) {
  var lines = body.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  var emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var phoneRe = /^[+()\-.\s\d]{7,20}$/;
  var headerRe = /^(From|To|Cc|Bcc|Date|Subject|Sent):/i;
  var fwdMarkerRe = /^-+\s*Forwarded message\s*-+$/i;
  var labelRe = /^([A-Za-z][A-Za-z \-]{0,30}?)\s*:\s*(.*)$/;

  var email = '', phone = '', name = '', product = '', rest = [];
  // Fallback identity taken from a forward's "From:" header. Plenty of real
  // leads are not form submissions at all — a customer simply emails the site
  // and the thread gets forwarded here. In those the customer's address exists
  // ONLY in that header, which the loop skips, so the parser found nothing and
  // the thread was parked in ZeeOps/Unmatched. (Five real leads sat there:
  // "Box and foam insert interest", "Shipping boxes", "Plain Corrugated
  // Catering Boxes Inquiry", etc.) Used only when the body yields no address.
  var fromEmail = '', fromName = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (headerRe.test(line) || fwdMarkerRe.test(line)) {
      if (/^From:/i.test(line) && !fromEmail) {
        var fm = line.match(emailRe);
        if (fm && !isOwnAddress_(fm[0])) {
          fromEmail = fm[0];
          // "From: Diane Carter <diane@example.com>" → "Diane Carter"
          var nm = line.replace(/^From:\s*/i, '').replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
          if (nm && nm.indexOf('@') === -1) fromName = nm;
        }
      }
      continue;
    }

    var lm = line.match(labelRe);
    if (lm) {
      var field = fieldForLabel_(lm[1]);
      var value = lm[2].trim();
      if (field && value) {
        if (field === 'email' && !email) {
          var labeled = value.match(emailRe);
          if (labeled && !isOwnAddress_(labeled[0])) { email = labeled[0]; continue; }
        } else if (field === 'phone' && !phone) {
          var labeledDigits = value.replace(/\D/g, '');
          if (labeledDigits.length >= 7 && labeledDigits.length <= 15) { phone = value; continue; }
        } else if (field === 'name' && !name) {
          name = value; continue;
        } else if (field === 'product' && !product) {
          product = value; continue;
        }
      }
    }

    var emailMatch = line.match(emailRe);
    if (emailMatch && !email) {
      var candidate = emailMatch[0];
      if (!isOwnAddress_(candidate)) { email = candidate; continue; }
    }
    var digits = line.replace(/\D/g, '');
    if (!phone && phoneRe.test(line) && digits.length >= 7 && digits.length <= 15) { phone = line; continue; }
    rest.push(line);
  }
  return {
    name: name || fromName || rest[0] || '',
    product: product || rest[1] || '',
    email: email || fromEmail,
    phone: phone,
    message: lines.join('\n').slice(0, 2000), // full original text, capped
  };
}

function postLead_(siteCode, parsed, receivedDate) {
  try {
    var res = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-quote-secret': webhookSecret_() },
      payload: JSON.stringify({
        siteCode: siteCode,
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        product: parsed.product,
        message: parsed.message,
        receivedAt: receivedDate.toISOString(),
      }),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code === 200) return true;
    Logger.log('postLead_ failed (' + code + '): ' + res.getContentText());
    return false;
  } catch (err) {
    Logger.log('postLead_ error: ' + err);
    return false;
  }
}
