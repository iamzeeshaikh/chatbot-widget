/**
 * ZeeOps Custom-Quote Lead Intake — Google Apps Script
 *
 * Runs entirely inside your own Gmail account (script.google.com), completely
 * free, no third-party service, no cost regardless of volume.
 *
 * WHAT IT WILL TOUCH: an email that carries one of YOUR OWN site labels (SCB,
 * TTP, SFB, KBP, TBB, ZCB, TCP, TPC — see SITE_CODES below), or one whose own
 * machine-written footer names one of your domains ("Page URL: https://…",
 * "Submitted from: https://…", "New quote request from peptidesboxes.com").
 * That footer is written by the SITE, never typed by a sender, so it is
 * evidence in the same way a label is — and it is what lets a lead arrive
 * without waiting for anyone to file it by hand. It still never guesses from
 * sender or subject prose, so it cannot pick up spam.
 *
 * A thread it cannot place at all — reads like a lead, and names NO site
 * whatsoever — is labelled "ZeeOps/Needs a site label" rather than dropped in
 * silence. That silence is what let the same bug come back over and over: a
 * site whose mail template nobody had taught this script simply went unread for
 * weeks. Label such a thread with its site and the next run ingests it.
 *
 * Mail that names a site which is NOT ours (other packaging companies mail into
 * this inbox too) gets no label and no mention — it is not a lead of yours and
 * there is nothing to fix. Nothing from those was ever ingested; only hosts
 * listed in SITE_DOMAINS can resolve at all.
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
 *
 * A thread carrying NEITHER of those two labels has never been handled, and is
 * therefore read in full (its newest LOOKBACK_MESSAGES messages) regardless of
 * the watermark. That is what makes late labelling safe: file a thread hours or
 * days after the mail landed and it still gets ingested, instead of the
 * message's own date being behind the watermark forever.
 *
 * WHAT A RUN IS ALLOWED TO COST: a thread with no new mail is not opened at
 * all — not its labels, not its messages, not a body. Every 30-minute run
 * reading every thread in a two-day window is what ran the account out of
 * Gmail quota on 27 Aug 2026 and stopped ingest dead for 14 hours. So the
 * cheap routine run only looks at mail that has arrived since the last one,
 * and every DEEP_EVERY_N_RUNS-th run (plus dailyCatchUp) re-reads a wider
 * window to catch anything labelled by hand after it landed. See the "Gmail
 * call budget" section for the numbers.
 */

// ── Config ───────────────────────────────────────────────────────────────
// Printed on every run's summary line. Bump it with any change worth telling
// apart in a log. It exists because there is no other way to know WHICH copy
// of this file is actually running inside Apps Script — the editor's contents
// are invisible from here, a paste can silently not land, and several rounds
// of debugging were spent guessing at that.
var SCRIPT_VERSION = '2026-08-29a';

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
// Reads like a lead — a form's own field lines and a contactable customer —
// but nothing in it says WHICH of our sites it belongs to: no site label, no
// "Page URL:"/"Submitted from:" line, no domain we recognise. That combination
// used to end the run in silence (counted as `notOurs` and forgotten), which is
// why the same bug kept coming back: every site added with a new mail template
// went quietly unread until someone noticed a lead missing weeks later. It now
// gets a label instead, so the failure is sitting in the mailbox where it can
// be seen. Fix it by labelling the thread with that site's Gmail label (or
// adding its marker here) — the thread is never marked handled, so the very
// next run picks it up on its own.
var NEEDS_SITE_LABEL = 'ZeeOps/Needs a site label';
// Put this on any thread by hand to silence it for good — the script then
// treats it as dealt with and never reads, ingests or flags it again. The
// escape hatch for anything the rules below get wrong.
var IGNORE_LABEL = 'ZeeOps/Ignore';


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
var SITE_CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC', 'PB', 'TCS', 'TWP', 'CPB', 'TCSL',
  // 2026-08-29 — the five SPORTS sites. This file was deliberately clear of
  // them (they were chat-widget-only), and the user has since asked for their
  // quote-form leads too. Nothing here decides which dashboard a lead lands in:
  // the server maps the code to a site_id and the site_id belongs to the sports
  // workspace, so a sports lead cannot appear in the packaging dashboard even
  // though this one script ingests both.
  'TFU', 'TVU', 'CSJ', 'FBJ', 'TBJ'];

// The OFF SWITCH. A code listed here keeps its entry in SITE_CODES above but is
// not swept, not ingested and not counted — codeFromLeaf_ checks this list
// FIRST and returns null, so it wins over everything.
//
// Both entries are retired lead sites whose leads the server already drops with
// retired:true, so sweeping them burned Gmail quota and webhook calls for a
// guaranteed no-op. They are switched off here rather than deleted from
// SITE_CODES so that turning one back on is deleting one string from this line
// — nothing to remember, nothing to re-derive.
//
// NOTE: this switch is only HALF of it. The server has its own
// RETIRED_LEAD_SITES in lib/workspaces.ts holding 'thetubepackaging' and
// 'zeecustomboxes'. Bringing a site back needs BOTH: remove it here AND remove
// it there, then redeploy. Flipping only this one means the script forwards
// happily and the server silently drops every lead.
var IGNORED_LEAF_CODES = ['TTP', 'ZCB'];

function isIgnoredLeaf_(leaf) {
  return IGNORED_LEAF_CODES.indexOf(String(leaf || '').trim().toUpperCase()) !== -1;
}

// Labels whose leaf is a HUMAN-READABLE NAME rather than a short code. This
// mailbox turned out to use both conventions — "Extra Outsource Projects/tcs"
// is a code, "Extra Outsource Projects/ZEE Pack" is a name — and the matcher
// only ever compared the leaf against SITE_CODES, so every name-style label was
// dropped in silence however it was nested. (ZP was in SITE_DOMAINS and in the
// server's QUOTE_SITE_CODES the whole time; nothing but this lookup was missing.)
//
// Keys are lower-cased leaf names. Add one ONLY when the label has been
// confirmed to carry that site's form notifications — a wrong entry files real
// leads under the wrong site, which is worse than not ingesting them.
var LABEL_ALIASES = {
  'zee pack': 'ZP',
  // CPB was in SITE_CODES all along, but this mailbox files its mail under
  // "Extra Outsource Projects/Perfume" — a name, not the code — so it matched
  // nothing. Only NEW mail is affected: the label's existing threads are from
  // Feb 2026 and sit far outside the watermark window, so a normal run will not
  // touch them. Run processQuoteLeadsBackfill if you do want those 7 messages.
  'perfume': 'CPB',
  // The Candle Sleeves files under "Extra Outsource Projects/Candle Sleeves".
  // TCSL was in SITE_DOMAINS and in the server's QUOTE_SITE_CODES from the
  // start, so the site resolved fine everywhere EXCEPT this lookup — its very
  // first lead (13 Aug 2026) was labeled correctly and still never ingested.
  // Note this is NOT "candle": that name belongs to The Candle Packaging (TCP),
  // a different site, so the alias has to carry the word "sleeves".
  'candle sleeves': 'TCSL',
  // The sports labels, in both the short-code and the written-out form, so it
  // does not matter which one gets typed into Gmail. Every one of these is a
  // site name, not a word that means anything else in this mailbox.
  'texas football': 'TFU',
  'texas football uniforms': 'TFU',
  'volleyball': 'TVU',
  'volleyball uniforms': 'TVU',
  'the volleyball uniforms': 'TVU',
  'california soccer': 'CSJ',
  'california soccer jerseys': 'CSJ',
  'florida basketball': 'FBJ',
  'florida basketball jerseys': 'FBJ',
  'baseball jerseys': 'TBJ',
  'the baseball jerseys': 'TBJ',
};

// The one place a label leaf becomes a site code. Returns the code, or null.
function codeFromLeaf_(leaf) {
  var trimmed = String(leaf || '').trim();
  var code = SITE_CODES.indexOf(trimmed.toUpperCase()) !== -1
    ? trimmed.toUpperCase()
    : (LABEL_ALIASES[trimmed.toLowerCase()] || null);
  // Tested on the RESOLVED code, not the raw leaf, so switching a site off also
  // switches off any alias pointing at it.
  if (code && isIgnoredLeaf_(code)) return null;
  return code;
}

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
  // codeFromMessageText_ resolves a form's own footer host to one of these, and
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
  TFU: 'texasfootballuniforms.com',
  TVU: 'thevolleyballuniforms.com',
  CSJ: 'californiasoccerjerseys.com',
  FBJ: 'floridabasketballjerseys.com',
  TBJ: 'thebaseballjerseys.com',
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
// SIZED FOR THE GMAIL QUOTA, not for "as much as possible" — see the "Gmail
// call budget" section further down for the per-run cost model and for the
// 27 Aug 2026 outage that made it necessary.
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
// Listing them is one call; only the ones with new mail are then read.
var CHECKOUT_SWEEP_MAX = 150;

// ── Gmail call budget ────────────────────────────────────────────────────
// WHAT WENT WRONG ON 27 AUG 2026, so it isn't reintroduced: every run read
// every candidate thread in full — its labels (up to three separate reads of
// the same labels), its messages, and every message body — purely to discover
// that the thread was somebody else's mail. `after:` has DAY granularity, so
// the search hands back one to two days of the WHOLE mailbox on every run:
// hundreds of threads, ~99% of them unrelated. At four-plus Gmail calls each,
// 48 runs a day, that is tens of thousands of calls against a personal
// account's ~20,000/day allowance. One run failed with "Limit Exceeded:
// Gmail" at 20:27, and every run for the next 14 hours died with "Service
// invoked too many times for one day: gmail" — 19 consecutive runs, no leads
// ingested at all, and no error visible anywhere except Apps Script's own
// failure email.
//
// THE RULE THIS ESTABLISHES: a thread that cannot produce a lead this run must
// cost approximately nothing. Three mechanisms enforce it, all below:
//   1. a date gate on thread metadata BEFORE any thread is opened
//      (getLastMessageDate, already carried by the search result),
//   2. one labels read and one messages read per thread per run, cached
//      (labelNamesOf_ / messagesOf_ / prefetchMessages_),
//   3. messages fetched for the whole surviving batch in one call
//      (GmailApp.getMessagesForThreads) rather than one call per thread.
// A routine run now costs on the order of ten Gmail calls instead of a
// thousand.
//
// THE ONE THING THE DATE GATE COSTS, and how it is paid back: a thread
// labelled BY HAND hours after its mail arrived has an old last-message date,
// so a routine run skips it — and that is precisely the failure that lost
// three leads on 26 Aug. So every DEEP_EVERY_N_RUNS-th run widens the gate to
// DEEP_LOOKBACK_MS and re-reads everything in that window regardless of the
// watermark, and dailyCatchUp runs a deep pass over CATCHUP_DAYS once a day.
// Late labelling is therefore picked up within a few hours, not never.
// How many consecutive too-old threads end a routine run's walk through the
// search results. Only ever reached on a routine run; a deep run reads the
// whole window.
var STALE_RUN_LIMIT = 25;
var DEEP_EVERY_N_RUNS = 6;                        // 30-min trigger → a deep pass every ~3 hours
var DEEP_LOOKBACK_MS = 12 * 60 * 60 * 1000;       // how far back a deep pass re-reads
var RUN_COUNT_KEY = 'ZEEOPS_RUN_COUNT';
// Set by dailyCatchUp so its pass is always a deep one.
var FORCE_DEEP_SCAN = false;

// Every Nth run, counted in Script Properties because each run is a fresh
// execution with no memory of the last one.
function isDeepRun_() {
  if (FORCE_DEEP_SCAN) return true;
  var props = PropertiesService.getScriptProperties();
  var n = (parseInt(props.getProperty(RUN_COUNT_KEY), 10) || 0) + 1;
  if (n >= DEEP_EVERY_N_RUNS) { props.setProperty(RUN_COUNT_KEY, '0'); return true; }
  props.setProperty(RUN_COUNT_KEY, String(n));
  return false;
}

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
    if (codeFromLeaf_(leafName) || isIgnoredLeaf_(leafName)) continue;
    if (leafName.toLowerCase() === CHECKOUT_LABEL) continue;
    unknown.push(full);   // no length filter — see matchSiteCode_ for why
  }
  Logger.log('Labels NOT recognised as site codes (add real ones to SITE_CODES or LABEL_ALIASES): ' +
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

// ── Dry run: what WOULD be ingested, without ingesting anything ──────────
// Run this BEFORE processQuoteLeadsBackfill on a mailbox whose labels are new.
// A backfill of a freshly-labelled account posts months of mail in one go, and
// a label put on the wrong search, or a form this parser reads badly, becomes
// hundreds of wrong leads that then have to be found and cleaned out by hand.
// This sends NOTHING and changes NOTHING: it walks each site label, parses the
// newest messages exactly as the real run would, and prints what the webhook
// would have received — including the ones it could not read, which are the
// ones worth looking at.
var PREVIEW_THREADS_PER_LABEL = 5;

function previewLeads() {
  var start = Date.now();
  var siteLabels = findSiteLabels_();
  var codes = Object.keys(siteLabels);
  if (!codes.length) {
    Logger.log('No site labels found in this mailbox. Create one per site (the leaf name ' +
      'can be the code — TFU, TVU, CSJ, FBJ, TBJ — or the site name), then run listSiteLabels.');
    return;
  }
  Logger.log('DRY RUN [' + SCRIPT_VERSION + '] — nothing is sent and nothing is labelled.');
  var readable = 0, unreadable = 0;
  for (var c = 0; c < codes.length; c++) {
    if (Date.now() - start > TIME_BUDGET_MS) { Logger.log('...stopped early (time budget).'); break; }
    var code = codes[c];
    var threads = siteLabels[code].getThreads(0, PREVIEW_THREADS_PER_LABEL);
    Logger.log('');
    Logger.log('=== ' + code + '  (' + siteLabels[code].getName() + ')  — newest ' + threads.length + ' thread(s)');
    prefetchMessages_(threads);
    for (var t = 0; t < threads.length; t++) {
      var msgs = messagesOf_(threads[t]);
      var msg = msgs[msgs.length - 1];               // newest message on the thread
      if (!msg) continue;
      var parsed = parseLeadBody_(msg.getPlainBody());
      var when = Utilities.formatDate(msg.getDate(), 'UTC', 'yyyy-MM-dd');
      if (parsed.email || parsed.phone) {
        readable++;
        Logger.log('  WOULD SEND  ' + when + '  name=' + (parsed.name || '(none)') +
          '  email=' + (parsed.email || '(none)') + '  phone=' + (parsed.phone || '(none)') +
          '  product=' + (parsed.product || '(none)'));
      } else {
        unreadable++;
        Logger.log('  NO CONTACT  ' + when + '  from=' + msg.getFrom() +
          '  subject=' + String(threads[t].getFirstMessageSubject() || '').slice(0, 60));
        Logger.log('              first lines: ' +
          String(msg.getPlainBody() || '').split('\n').slice(0, 4).join(' | ').slice(0, 200));
      }
    }
  }
  Logger.log('');
  Logger.log('DRY RUN total: ' + readable + ' would be sent, ' + unreadable +
    ' carry no readable email/phone. If the readable ones look right, run processQuoteLeadsBackfill.');
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
  var co = sweepCheckoutLabel_(start, processedLabel, skippedLabel, BACKFILL_MAX_THREADS_PER_LABEL, true);
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
  Logger.log('processQuoteLeadsBackfill [' + SCRIPT_VERSION + ']: sent=' + sent + ' skipped=' + skipped +
    (stoppedEarly ? ' — stopped early (time budget); run again to continue.' : ' — done, nothing left to process.'));
}

function processQuoteLeads() {
  var start = Date.now();
  // Cheap routine run, or the periodic deep one that re-reads the last
  // DEEP_LOOKBACK_MS regardless of the watermark? See "Gmail call budget".
  var deep = isDeepRun_();
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);

  var sent = 0, skipped = 0, notOurs = 0, stoppedEarly = false;
  var noLabel = 0, siteLabeled = 0; // for the summary line
  // Threads that read like a lead but name no site — see NEEDS_SITE_LABEL.
  var needsAttention = 0, needsAttentionHits = [];
  // Which threads came in via the no-label fallback, so the summary can NAME
  // them. A bare count says work is being rescued but not what to go and fix;
  // one site repeating here means that site's Gmail filter isn't labelling.
  var noLabelHits = [];

  // Checkout FIRST, before the general search spends the time budget — order
  // mail must never be starved by a mailbox full of unrelated threads.
  //
  // ON DEEP RUNS ONLY. A NEW order is not what this sweep finds: its mail is
  // recent, so the search below returns it and matchSiteCode_ reads the store
  // name out of the subject exactly as the sweep would. What the sweep alone
  // can reach is the OLD backlog, which by definition no date window ever
  // covers — and re-walking that backlog on all 48 runs a day was a fixed ~450
  // Gmail calls every 30 minutes spent re-reading orders handled last week.
  if (deep) {
    var co = sweepCheckoutLabel_(start, processedLabel, skippedLabel, CHECKOUT_SWEEP_MAX, true);
    sent += co.sent; skipped += co.skipped;
    if (co.stoppedEarly) {
      Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped +
        ' (checkout sweep only) — stopped early (time budget); rest will be picked up on the next run.');
      return;
    }
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

  // ── The date gate (see "Gmail call budget") ────────────────────────────
  // `after:` is day-granular, so the search above always returns one to two
  // days of the WHOLE mailbox — hundreds of threads on a run that has perhaps
  // two new messages to find. Opening each one to discover it is somebody
  // else's mail is what exhausted the daily Gmail allowance on 27 Aug 2026 and
  // stopped ingest completely for 14 hours.
  //
  // getLastMessageDate() is answered from the thread metadata the search
  // already returned. A thread whose newest message is older than the cutoff
  // holds nothing this run could post, so it is dropped here — before its
  // labels, its messages or any body are ever read.
  //
  // On a deep run the gate widens to DEEP_LOOKBACK_MS, which is what keeps the
  // "labelled by hand hours later" case working: those threads have an old
  // message date but have never been handled, and lookbackMessages_ still
  // reads them in full once the gate lets them through.
  //
  // A routine run STOPS walking rather than testing every thread, because
  // GmailApp.search returns newest first: once STALE_RUN_LIMIT threads in a row
  // are older than the cutoff, everything after them is older still. The limit
  // is a run of misses rather than the first one, so a thread out of order —
  // Gmail's ordering is dependable but not contractual — cannot end the scan on
  // its own. A deep run walks the whole window and skips nothing.
  var scanCutoff = deep ? Math.min(cutoff, Date.now() - DEEP_LOOKBACK_MS) : cutoff;
  var candidates = [];
  var stale = 0;
  for (var g = 0; g < threads.length; g++) {
    if (threads[g].getLastMessageDate().getTime() > scanCutoff) { candidates.push(threads[g]); stale = 0; }
    else if (!deep && ++stale >= STALE_RUN_LIMIT) break;
  }
  // One Gmail call for the whole batch, instead of one per thread below.
  prefetchMessages_(candidates);

  for (var t = 0; t < candidates.length; t++) {
    if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break; }

    var thread = candidates[t];
    if (isIgnored_(thread)) continue;  // silenced by hand — never read, ingested or flagged
    var code = matchSiteCode_(thread); // null if it doesn't carry one of our site labels
    if (!code) {
      // Not a last line of defence any more — for several sites it is the ONLY
      // line, because their mail is never auto-labelled at all. Decided from the
      // form's own machine-generated footer (see codeFromMessageText_), written
      // by the site itself, never from sender or subject prose — so the
      // guarantee against spam still holds, and only hosts already in
      // SITE_DOMAINS can match.
      //
      // Read here rather than via a separate `"Page URL:"` search: Gmail's
      // quoted-phrase search containing a colon is unreliable, and this is
      // exactly the path that must not fail quietly. It costs a body read per
      // unlabelled thread WITH NEW MESSAGES, which the watermark keeps to a
      // handful on a normal run.
      var fbAny = false;
      var umsgs = lookbackMessages_(thread, cutoff);
      for (var um = 0; um < umsgs.length; um++) {
        var ubody = umsgs[um].getPlainBody();
        var ucode = codeFromMessageText_(ubody, umsgs[um].getFrom());
        if (!ucode) continue;
        var uparsed = parseLeadBody_(ubody);
        if (!uparsed.email && !uparsed.phone) continue;
        if (postLead_(ucode, uparsed, umsgs[um].getDate())) {
          sent++; noLabel++; fbAny = true;
          noLabelHits.push(ucode + '  ' +
            Utilities.formatDate(umsgs[um].getDate(), 'UTC', 'yyyy-MM-dd') + '  ' +
            String(thread.getFirstMessageSubject() || '').slice(0, 70));
        }
      }
      if (fbAny) { addLabel_(thread, processedLabel); continue; }

      // A checkout thread whose store name isn't in STORE_NAME_CODES would
      // otherwise be re-scanned forever. Park it in Unmatched so it shows up as
      // something to fix (add the store name) rather than silently vanishing.
      if (hasCheckoutLabel_(thread) && !isHandled_(thread)) { addLabel_(thread, skippedLabel); skipped++; }
      else if (namesAForeignSite_(umsgs, thread.getFirstMessageSubject())) {
        // Somebody else's site, mailing into this inbox. It names its own
        // domain and that domain is not one of ours, so there is nothing to
        // fix and nothing to file — say nothing about it.
        notOurs++;
      }
      else if (!isHandled_(thread) && looksLikeUnfiledLead_(umsgs)) {
        // COUNTED AND LOGGED, NEVER LABELLED. This started as a Gmail label so
        // an unplaceable lead could not go unnoticed, and in this mailbox that
        // was simply the wrong instrument: 45,000+ threads, most of them other
        // packaging companies' form mail and cold sales pitches whose signature
        // block ("Name: … Phone: … Email: …") reads exactly like a submitted
        // form. Two rounds of narrowing still left it landing on a machinery
        // sales pitch and on mail belonging to another dashboard entirely. A
        // warning that is usually wrong costs more than the silence it was
        // meant to fix — and the silence itself is already fixed, by
        // codeFromMessageText_ reading these forms' own footers and by an
        // unhandled thread ignoring the watermark. So it stays in the run log,
        // where it costs nothing, and out of the mailbox.
        needsAttention++;
        needsAttentionHits.push(Utilities.formatDate(thread.getLastMessageDate(), 'UTC', 'yyyy-MM-dd') +
          '  ' + String(thread.getFirstMessageSubject() || '').slice(0, 70));
      }
      else notOurs++;
      continue;
    }
    siteLabeled++;

    var messages = lookbackMessages_(thread, cutoff);
    var handledAny = false, considered = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      considered++;
      var parsed = parseLeadBody_(msg.getPlainBody());
      if (!parsed.email && !parsed.phone) continue;
      if (postLead_(code, parsed, msg.getDate())) { sent++; handledAny = true; }
      // On failure, leave the watermark alone so a later run retries it.
    }
    // Nothing new in this thread — leave its labels exactly as they are, or an
    // old fully-handled thread would get re-flagged Unmatched on every run.
    if (considered === 0) continue;
    if (handledAny) addLabel_(thread, processedLabel);
    else { addLabel_(thread, skippedLabel); skipped++; }
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
  if (noLabel > 0) {
    Logger.log('no-label fallback: ingested ' + noLabel + ' form submission(s) whose thread carried NO site label — worth labelling those threads:');
    for (var nl = 0; nl < noLabelHits.length; nl++) Logger.log('    ' + noLabelHits[nl]);
  }

  if (needsAttention > 0) {
    Logger.log('FYI — ' + needsAttention + ' thread(s) read like a lead but name no site of ours. Nothing in Gmail ' +
      'was touched. Most are other companies\' mail or sales pitches; if one is genuinely yours, label the thread ' +
      'with its site and the next run ingests it:');
    for (var na = 0; na < needsAttentionHits.length; na++) Logger.log('    ' + needsAttentionHits[na]);
  }

  var unknownNames = Object.keys(UNKNOWN_SITE_LABELS);
  if (unknownNames.length > 0) {
    Logger.log('ACTION NEEDED — threads carrying a short label that is NOT a known site code, so nothing was ingested from them: ' +
      unknownNames.map(function (n) { return n + ' (' + UNKNOWN_SITE_LABELS[n] + ' threads)'; }).join('   |   ') +
      '. If any of those is a site, add its code to SITE_CODES and to QUOTE_SITE_CODES on the server.');
  }

  // Only advance the watermark on a complete pass. A run cut short by the time
  // budget must leave it where it was, so the next run re-covers the remainder.
  if (!stoppedEarly) saveWatermark_(start);
  Logger.log('processQuoteLeads [' + SCRIPT_VERSION + ']: ' + (deep ? 'DEEP pass — ' : '') + 'sent=' + sent +
    ' (' + noLabel + ' via no-label fallback) skipped=' + skipped +
    ' (search returned ' + threads.length + ' threads, ' + candidates.length + ' had new mail and were opened, ' +
    siteLabeled + ' site-labeled, ' + notOurs + ' not ours)' +
    (stoppedEarly ? ' — stopped early (time budget); rest will be picked up on the next run.' : ' — done, nothing left to process.'));
}

// Pull the watermark back so the next processQuoteLeads run re-covers the last
// REWIND_DAYS days. Needed whenever the script gains a new way of finding mail
// — the watermark has already moved past the messages the OLD code couldn't
// see, so without this they stay invisible forever. Costs no Gmail quota at
// all (it only writes a property); everything already ingested comes straight
// back as `deduped` from the server.
var REWIND_DAYS = 7;

// ── Daily catch-up (label-it-later insurance) ────────────────────────────────
// The watermark asks "is this MESSAGE newer than the last run?". That is the
// right question for mail that is already labelled when it lands, and the wrong
// one for mail labelled BY HAND hours later: by then the message date is behind
// the watermark and no ordinary 30-minute run will ever look at it again.
//
// Three real leads were lost that way on 26 Aug 2026 (SFB 24 Aug, and SCB's
// 12:29am/4:01am/7:19am enquiries), all recovered only by a manual rewind.
//
// So once a day, re-cover the last CATCHUP_DAYS days: pull the watermark back
// and run the normal pass. Everything already ingested comes straight back as
// `deduped` from the server, so the cost is only the extra Gmail reads — and it
// is bounded, because the window is a couple of days rather than the whole
// label history (that is what processQuoteLeadsBackfill is for, and why that
// one stays manual).
//
// TRIGGER: Triggers → Add Trigger → function `dailyCatchUp`, Time-driven, Day
// timer, e.g. 2am–3am. KEEP the 30-minute processQuoteLeads trigger as well —
// this is a safety net under it, not a replacement.
var CATCHUP_DAYS = 2;

function dailyCatchUp() {
  var target = Date.now() - CATCHUP_DAYS * 24 * 60 * 60 * 1000;
  // The whole point of this run is to re-read mail whose own date is old —
  // exactly what the routine date gate drops — so it always runs deep.
  FORCE_DEEP_SCAN = true;
  saveWatermark_(target + WATERMARK_OVERLAP_MS); // readWatermark_ subtracts the overlap again
  Logger.log('dailyCatchUp: watermark pulled back to ' + new Date(target) +
    ' — re-covering ' + CATCHUP_DAYS + ' day(s), then running the normal pass.');
  processQuoteLeads();
}

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
var DIAGNOSE_QUERY = 'peptidesboxes.com';

function diagnoseThread() {
  var threads = GmailApp.search(DIAGNOSE_QUERY, 0, 5);
  if (!threads.length) { Logger.log('No thread matched: ' + DIAGNOSE_QUERY); return; }
  var cutoff = readWatermark_();
  Logger.log('watermark cutoff = ' + new Date(cutoff) + '  (messages at or before this are treated as already covered)');
  for (var i = 0; i < threads.length; i++) {
    var th = threads[i];
    var names = th.getLabels().map(function (l) { return l.getName(); });
    var code = matchSiteCode_(th);
    var handled = isHandled_(th);
    Logger.log('--- thread ' + (i + 1) + ': ' + th.getFirstMessageSubject());
    Logger.log('    labels    : ' + (names.join('  |  ') || '(none)'));
    Logger.log('    site code : ' + (code || 'none from a label'));
    Logger.log('    handled   : ' + handled +
      (handled ? ' (so only messages newer than the watermark are read)'
               : ' (so every recent message is read, watermark or not)'));
    var msgs = th.getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      var p = parseLeadBody_(m.getPlainBody());
      // What the message says about itself, which is what decides an
      // unlabelled thread — printed per message because a forward and its
      // original can disagree.
      var bodyCode = codeFromMessageText_(m.getPlainBody(), m.getFrom());
      Logger.log('    msg ' + (j + 1) + '  ' + m.getDate() +
        '  | newer than watermark: ' + (m.getDate().getTime() > cutoff) +
        '  | site from body: ' + (bodyCode || 'NONE') +
        '  | email: ' + (p.email || 'NONE') +
        '  | phone: ' + (p.phone || 'NONE'));
    }
    if (!code && !handled) {
      Logger.log('    verdict   : ' + (msgs.length ? 'ingested only if "site from body" above is not NONE' : 'no messages'));
    }
  }
}

// Strip "ZeeOps/Needs a site label" off every thread carrying it.
//
// Manual-only. Run it once after any change to what earns that label — the
// first version of the rule put it on other companies' mail (packagingbee,
// theproductboxes), and a warning label nobody trusts is worse than no label.
// Clearing is free of consequence: the label is a note to a human, never an
// input to ingestion, and any thread that still deserves it gets it back on the
// next run.
function clearNeedsSiteLabel() {
  var label = GmailApp.getUserLabelByName(NEEDS_SITE_LABEL);
  if (!label) { Logger.log('No "' + NEEDS_SITE_LABEL + '" label in this mailbox — nothing to clear.'); return; }
  var start = Date.now(), cleared = 0;
  while (Date.now() - start < TIME_BUDGET_MS) {
    var threads = label.getThreads(0, 100);
    if (!threads.length) break;
    for (var i = 0; i < threads.length; i++) { threads[i].removeLabel(label); cleared++; }
  }
  if (Date.now() - start >= TIME_BUDGET_MS) {
    Logger.log('clearNeedsSiteLabel: removed the label from ' + cleared +
      ' thread(s) — stopped on the time budget, run again to finish.');
    return;
  }
  // Off the threads is not enough: the label itself stays in the sidebar,
  // empty, as a leftover of a feature that no longer exists. Delete it.
  label.deleteLabel();
  Logger.log('clearNeedsSiteLabel: removed the label from ' + cleared +
    ' thread(s), then deleted the label itself. Nothing left of it.');
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

// ── One read per thread per run ──────────────────────────────────────────
// Both caches are per EXECUTION — Apps Script starts every trigger run with a
// fresh global scope, so there is nothing to invalidate between runs and no
// risk of serving a stale answer to the next one.
//
// They exist because the same thread used to be read three or four times
// inside a single run: matchSiteCode_, isHandled_ and hasCheckoutLabel_ each
// called thread.getLabels() independently, and the checkout sweep re-read
// threads the main loop then read again. Every one of those was a Gmail call
// against a daily allowance the run had already exhausted.
var THREAD_LABELS_CACHE = {};
var THREAD_MESSAGES_CACHE = {};

// The label NAMES on a thread. One Gmail call the first time, free after that.
function labelNamesOf_(thread) {
  var id = thread.getId();                    // carried by the thread, not a fetch
  var hit = THREAD_LABELS_CACHE[id];
  if (hit) return hit;
  var labels = thread.getLabels();
  var names = [];
  for (var i = 0; i < labels.length; i++) names.push(labels[i].getName());
  THREAD_LABELS_CACHE[id] = names;
  return names;
}

// Label a thread and keep the cache honest, so a thread the checkout sweep has
// just marked Processed is seen as handled by the main loop later in the same
// run instead of being read and re-posted all over again.
function addLabel_(thread, label) {
  thread.addLabel(label);
  var id = thread.getId();
  var names = THREAD_LABELS_CACHE[id];
  if (names && names.indexOf(label.getName()) === -1) names.push(label.getName());
}

// The messages on a thread. Served from whatever prefetchMessages_ already
// pulled; falls back to a single-thread fetch so every caller is safe.
function messagesOf_(thread) {
  var id = thread.getId();
  var hit = THREAD_MESSAGES_CACHE[id];
  if (hit) return hit;
  var msgs = thread.getMessages();
  THREAD_MESSAGES_CACHE[id] = msgs;
  return msgs;
}

// Fetch the messages for a whole batch of threads in ONE Gmail call instead of
// one call per thread — this is what GmailApp.getMessagesForThreads is for, and
// it is the single biggest saving in the run. Chunked because the batch itself
// has a practical size limit.
var MESSAGE_PREFETCH_CHUNK = 100;
// A ceiling on how much a single prefetch pulls into memory at once. The
// backfill sweeps thousands of threads in one go, and holding every message of
// every one of them is how a run dies of memory or of the 6-minute limit before
// it has posted anything. Past this point messagesOf_ just fetches per thread,
// exactly as it used to.
var MESSAGE_PREFETCH_MAX = 300;

function prefetchMessages_(threads) {
  var pending = [];
  for (var i = 0; i < threads.length && pending.length < MESSAGE_PREFETCH_MAX; i++) {
    if (!THREAD_MESSAGES_CACHE[threads[i].getId()]) pending.push(threads[i]);
  }
  for (var off = 0; off < pending.length; off += MESSAGE_PREFETCH_CHUNK) {
    var chunk = pending.slice(off, off + MESSAGE_PREFETCH_CHUNK);
    var batch = GmailApp.getMessagesForThreads(chunk);
    for (var c = 0; c < chunk.length; c++) {
      THREAD_MESSAGES_CACHE[chunk[c].getId()] = batch[c] || [];
    }
  }
}

/**
 * The messages on this thread a run should actually look at.
 *
 * The watermark asks "is this MESSAGE newer than the last run?". That is the
 * right question for a thread we have already dealt with — a form-notification
 * thread keeps receiving submissions, and re-reading its whole history every 30
 * minutes would be pure waste.
 *
 * It is the WRONG question for a thread that has never been handled at all. A
 * thread reaches that state whenever the site label arrived after the mail did
 * — someone filed it by hand hours later, or the code that could recognise it
 * only shipped today — and by then the message's own date is behind the
 * watermark, so no ordinary run will ever look at it again. Three real leads
 * were lost that way on 26 Aug 2026, and peptidesboxes/thecoffeesleeves mail
 * had been reaching the dashboard ONLY as manual forwards for a month for the
 * same reason: the forward was a new message, so it cleared the watermark that
 * the original no longer could.
 *
 * So: handled thread -> watermark. Never-handled thread -> its whole recent
 * history, newest LOOKBACK_MESSAGES of it. Re-posting is free (the server
 * dedupes), the cost is bounded, and the loop still converges — a thread that
 * posts anything becomes Processed, one that cannot becomes Unmatched, and
 * either way it is "handled" from the next run on.
 */
var LOOKBACK_MESSAGES = 10;

function lookbackMessages_(thread, cutoff) {
  var messages = messagesOf_(thread);
  var i, out = [];
  if (isHandled_(thread)) {
    for (i = 0; i < messages.length; i++) {
      if (messages[i].getDate().getTime() > cutoff) out.push(messages[i]);
    }
    return out;
  }
  // Never handled: the watermark does not apply, but two ceilings still do, so
  // one long-running unread thread can't eat the run's Gmail budget. Both are
  // cheap where it matters — genuinely new mail is one message inside both.
  var floor = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  for (i = 0; i < messages.length; i++) {
    if (messages[i].getDate().getTime() > floor) out.push(messages[i]);
  }
  return out.length > LOOKBACK_MESSAGES ? out.slice(out.length - LOOKBACK_MESSAGES) : out;
}

// ZeeOps/Ignore is documented as "silenced for good", and it was not: it counts
// as handled, and handled only means "apply the watermark", so a silenced thread
// that went on receiving mail had every new message ingested anyway. That is the
// whole point of the label — the escape hatch for a thread the rules get wrong —
// so it is now checked before anything else reads the thread.
function isIgnored_(thread) {
  return labelNamesOf_(thread).indexOf(IGNORE_LABEL) !== -1;
}

function isHandled_(thread) {
  var names = labelNamesOf_(thread);
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (n === PROCESSED_LABEL || n === SKIPPED_LABEL || n === IGNORE_LABEL) return true;
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
function sweepCheckoutLabel_(start, processedLabel, skippedLabel, max, deep) {
  var out = { sent: 0, skipped: 0, stoppedEarly: false };
  var label = findCheckoutLabel_();
  if (!label) return out; // no checkout label in this mailbox — nothing to do
  var cutoff = readWatermark_(); // same message-date rule as the main run
  var threads = label.getThreads(0, max);
  // Listing the label is one call; OPENING all of it was CHECKOUT_SWEEP_MAX × 3
  // Gmail calls on every single run — a fixed ~450 calls every 30 minutes, the
  // largest single item in the bill that ran the account out of quota on
  // 27 Aug 2026, and almost always spent re-reading orders handled days ago.
  //
  // So a routine run opens only the threads with mail newer than the watermark,
  // and a DEEP run (every DEEP_EVERY_N_RUNS-th, and every backfill) still walks
  // the label in full. That distinction matters here more than in the main run:
  // an old, never-handled order thread is exactly what this sweep exists for,
  // and no date window would ever reach it again.
  if (!deep) {
    var recent = [];
    for (var f = 0; f < threads.length; f++) {
      if (threads[f].getLastMessageDate().getTime() > cutoff) recent.push(threads[f]);
    }
    threads = recent;
  }
  prefetchMessages_(threads);
  for (var t = 0; t < threads.length; t++) {
    if (Date.now() - start > TIME_BUDGET_MS) { out.stoppedEarly = true; return out; }
    var thread = threads[t];
    if (isIgnored_(thread)) continue;  // silenced by hand — never read, ingested or flagged
    // A site-code label on the thread still wins over the subject's store name.
    var code = matchSiteCode_(thread);
    var messages = lookbackMessages_(thread, cutoff);
    var handledAny = false, considered = 0;
    for (var m = 0; m < messages.length; m++) {
      considered++;
      if (!code) continue;
      var parsed = parseLeadBody_(messages[m].getPlainBody());
      if (!parsed.email && !parsed.phone) continue;
      if (postLead_(code, parsed, messages[m].getDate())) { out.sent++; handledAny = true; }
    }
    if (considered === 0) continue;
    if (handledAny) addLabel_(thread, processedLabel);
    else { addLabel_(thread, skippedLabel); out.skipped++; }
  }
  return out;
}

// A hostname -> our site code, or null for any host that isn't one of ours.
// The off switch has to be honoured HERE too. Turning TTP/ZCB off in
// codeFromLeaf_ only closed the label path: an unlabelled thread then fell
// through to this fallback, which resolved the same site from its "Page URL:"
// host and posted it anyway. The first run after the switch went in proved it
// — 24 no-label-fallback ingests, every one of them TTP or ZCB.
function codeFromHost_(host) {
  var h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/[.,;:)\]}>'"]+$/, '');
  if (!h) return null;
  for (var code in SITE_DOMAINS) {
    if (SITE_DOMAINS[code].toLowerCase() === h) return isIgnoredLeaf_(code) ? null : code;
  }
  return null;
}

function hostOfUrl_(url) {
  return String(url || '').replace(/^https?:\/\//i, '').split(/[\/?#]/)[0];
}

// Every machine-generated line a site's own form mailer writes to say which
// site it came from. One entry per real template seen in this mailbox — these
// are written BY THE SITE, never typed by a sender, which is what keeps the
// spam guarantee: nothing here can be manufactured by someone emailing in.
//
// "Page URL:" alone was the whole list until 27 Aug 2026, and that is the hole
// this recurring bug kept falling through: the check is only as wide as the
// templates it knows, and every site added since has mailed a different line.
// Measured against 600 stored leads at the time: peptidesboxes writes "New
// quote request from peptidesboxes.com" and never a Page URL at all, and
// thecoffeesleeves writes "Submitted from: https://...". Both were invisible
// here, so an unlabelled thread from either site could only ever be rescued by
// hand — which is exactly what was happening, one manual forward at a time.
// The colon is optional throughout: several of these forms mail the label
// bare ("Submitted from https://theburgersleeves.com/"), which is the same
// line without its punctuation.
var SITE_URL_MARKERS = [
  /Page URL:?\s*<?\s*(https?:\/\/[^\s>]+)/i,
  /Submitted from:?\s*<?\s*(https?:\/\/[^\s>]+)/i,
  /Sent from:?\s*<?\s*(https?:\/\/[^\s>]+)/i,
  /(?:Form|Source|Referring)\s*(?:URL|page|Page):?\s*<?\s*(https?:\/\/[^\s>]+)/i,
];

// "New quote request from peptidesboxes.com", "New enquiry from ..." — a bare
// domain rather than a URL, so it needs its own pattern.
var SITE_NAMED_MARKERS = [
  /New (?:quote request|enquiry|inquiry|message|submission)\s+from\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})/i,
  /(?:Submitted|Sent) from:?\s+([A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*$/im,
];

// The sender's DISPLAY NAME -> our site code, for sites whose form mail goes
// out through a Gmail account: "The Volleyball Uniforms <something@gmail.com>".
// The domain in that address is gmail.com, which identifies nothing, and these
// forms carry no domain-bearing footer either — so without this the only thing
// that can place them is a Gmail label somebody remembered to apply.
//
// A display name is WEAKER EVIDENCE than everything else in this file: unlike a
// label or a form's own "Page URL:" footer, anyone can put any name in a From
// header. So it is the only resolver that is not trusted on its own — the body
// must also have the shape of a submitted form (looksLikeFormSubmission_,
// two-plus field lines) before a display name is allowed to name a site. A
// spammer would have to both impersonate the site's own mailer AND send a
// filled-in quote form, at which point the server's spam rules are what stands
// in the way, as they do for every other path here.
var SENDER_NAME_CODES = {
  'texas football uniforms': 'TFU',
  'the texas football uniforms': 'TFU',
  'the volleyball uniforms': 'TVU',
  'volleyball uniforms': 'TVU',
  'california soccer jerseys': 'CSJ',
  'florida basketball jerseys': 'FBJ',
  'the baseball jerseys': 'TBJ',
  'baseball jerseys': 'TBJ',
};

// The display-name half of a From header: `Name <addr@host>` -> `name`.
function senderDisplayName_(fromHeader) {
  return String(fromHeader || '').replace(/<[^>]*>/g, '').replace(/["']/g, '').trim().toLowerCase();
}

function codeFromSenderName_(fromHeader) {
  var code = SENDER_NAME_CODES[senderDisplayName_(fromHeader)];
  return code && !isIgnoredLeaf_(code) ? code : null;
}

/**
 * Which of OUR sites did this message come from, judged from the message
 * itself rather than from a Gmail label?
 *
 * Every step resolves through SITE_DOMAINS, so it can only ever name a site we
 * already own — an unknown host is null, never a guess.
 *
 * Ordered most-trustworthy first:
 *   1. a form's own "this is the page it was submitted from" line
 *   2. a form's own "new quote request from <domain>" line
 *   3. the sending address's domain (noreply@thecoffeesleeves.com)
 *   4. the sender's display name, for sites that mail through Gmail — and only
 *      when the body is a filled-in form (see SENDER_NAME_CODES)
 *   5. LAST RESORT: any URL in the body pointing at one of our domains — and
 *      only when the whole body points at exactly ONE of them. Two different
 *      sites in one body is ambiguous, and filing a lead under the wrong site
 *      is worse than not filing it, so ambiguity returns null.
 */
function codeFromMessageText_(body, fromHeader) {
  var text = String(body || '');
  var i, m, code;

  for (i = 0; i < SITE_URL_MARKERS.length; i++) {
    m = text.match(SITE_URL_MARKERS[i]);
    if (m) { code = codeFromHost_(hostOfUrl_(m[1])); if (code) return code; }
  }

  for (i = 0; i < SITE_NAMED_MARKERS.length; i++) {
    m = text.match(SITE_NAMED_MARKERS[i]);
    if (m) { code = codeFromHost_(m[1]); if (code) return code; }
  }

  var sender = String(fromHeader || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  if (sender) { code = codeFromHost_(sender[1]); if (code) return code; }

  // 5. The sender's display name — only for a body that is actually a filled-in
  //    form. See SENDER_NAME_CODES for why this one alone needs that guard.
  code = codeFromSenderName_(fromHeader);
  if (code && looksLikeFormSubmission_(text)) return code;

  // Guarded, because "a link to one of our sites" on its own is not evidence
  // of a lead — a deploy notification, an invoice or our own newsletter all
  // carry one. The body has to have the SHAPE of a submitted form as well.
  if (!looksLikeFormSubmission_(text)) return null;
  var urls = text.match(/https?:\/\/[^\s>)\]"']+/g) || [];
  var found = null;
  for (i = 0; i < urls.length; i++) {
    code = codeFromHost_(hostOfUrl_(urls[i]));
    if (!code) continue;
    if (found && found !== code) return null; // ambiguous — do not guess
    found = code;
  }
  return found;
}

// Free mailbox providers, whose domain says nothing about which site a mail
// belongs to — these sites all send through a Gmail account.
var FREE_MAIL_HOSTS = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
  'yahoo.com', 'live.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com'];

// Domains a message claims as ITS OWN — the host of any link it contains, and
// the domain in a "New Enquiry From <domain>" style subject or heading. A
// customer's own email domain is deliberately NOT counted: that is who wrote
// in, not which site they wrote to.
var SITE_CLAIM_RE = /\b(?:enquiry|inquiry|quote|request|message|order|submission)\s+from\s+([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/ig;

function claimedHosts_(text) {
  var out = [], m;
  var urls = String(text || '').match(/https?:\/\/[^\s>)\]"']+/g) || [];
  for (var i = 0; i < urls.length; i++) out.push(hostOfUrl_(urls[i]).toLowerCase().replace(/^www\./, ''));
  SITE_CLAIM_RE.lastIndex = 0;
  while ((m = SITE_CLAIM_RE.exec(String(text || '')))) {
    out.push(m[1].toLowerCase().replace(/^www\./, '').replace(/[.,;:]+$/, ''));
  }
  return out;
}

/**
 * Is this plainly ANOTHER company's mail?
 *
 * Other packaging businesses' form notifications land in this mailbox too
 * (packagingbee.com.au, theproductboxes.co.uk). They read exactly like a lead,
 * because they are one — just not one of ours. Labelling those
 * "ZeeOps/Needs a site label" was wrong: it put a ZeeOps sticker on mail that
 * has nothing to do with ZeeOps and made it look like the site had been added.
 * Nothing was ever ingested from them (codeFromMessageText_ only resolves hosts
 * in SITE_DOMAINS), but the label alone was noise, and noise in the one place
 * the alarm has to stay trustworthy.
 *
 * So: a message that names its own site, where that site is not ours, is
 * someone else's and is passed over in silence. Only mail that names NO site
 * at all is genuinely ambiguous, and only that gets the label.
 */
function namesAForeignSite_(messages, subject) {
  var hosts = claimedHosts_(subject);
  for (var i = 0; i < messages.length; i++) {
    hosts = hosts.concat(claimedHosts_(messages[i].getPlainBody()));
    // The sender's domain is read ONLY to test against the two lists we
    // already know — a site of ours, or a site of ours we do not ingest here.
    // An unrecognised sender domain is not evidence of anything (a customer
    // writing in from their own company address is the common case), so it is
    // never allowed to declare a thread foreign on its own.
    var from = String(messages[i].getFrom() || '').match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    if (from) {
      var fh = from[1].toLowerCase().replace(/^www\./, '');
      if (codeFromHost_(fh) || SITE_DOMAIN_HOSTS.indexOf(fh) !== -1) return false;
    }
  }
  var foreign = false;
  for (var h = 0; h < hosts.length; h++) {
    var host = hosts[h];
    if (!host || FREE_MAIL_HOSTS.indexOf(host) !== -1) continue;
    if (codeFromHost_(host)) return false;   // one of ours after all
    // A retired site of ours is still ours — do not call it foreign, or
    // turning it back on would need this to be re-reasoned.
    if (SITE_DOMAIN_HOSTS.indexOf(host) !== -1) return false;
    foreign = true;
  }
  return foreign;
}

// Every host in SITE_DOMAINS, including the switched-off ones.
var SITE_DOMAIN_HOSTS = (function () {
  var out = [];
  for (var code in SITE_DOMAINS) out.push(SITE_DOMAINS[code].toLowerCase());
  return out;
})();

// Does this thread hold a message that reads like a real, contactable lead?
// Deliberately the same two tests the ingest itself applies — the form shape
// and a parseable email or phone — so the label only ever appears on mail the
// script WOULD have ingested if it knew which site it belonged to.
function looksLikeUnfiledLead_(messages) {
  for (var i = 0; i < messages.length; i++) {
    var body = messages[i].getPlainBody();
    if (!looksLikeFormSubmission_(body)) continue;
    var p = parseLeadBody_(body);
    if (p.email || p.phone) return true;
  }
  return false;
}

// Two or more of a form's own field labels, at the start of their own lines.
// Every real template in this mailbox clears this easily (Name / Email / Phone
// / Product / Message), and machine mail that merely links to one of our sites
// does not.
var FORM_FIELD_LINE_RE = /^\s*(full name|first name|last name|name|business email|email address|e-?mail|phone number|phone|mobile|telephone|company( name)?|product( name)?|message|quantity|required quantity|enquiry from page)\b\s*:?\s*\S/i;

function looksLikeFormSubmission_(text) {
  var lines = String(text || '').split('\n');
  var hits = 0;
  for (var i = 0; i < lines.length; i++) {
    if (FORM_FIELD_LINE_RE.test(lines[i]) && ++hits >= 2) return true;
  }
  return false;
}

// Kept as the old name so nothing that only has a body has to change.
function codeFromBodyUrl_(body) {
  return codeFromMessageText_(body, '');
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
    var leaf = codeFromLeaf_(parts[parts.length - 1]);
    if (leaf && !found[leaf]) found[leaf] = all[i];
  }
  return found;
}

// Does this thread carry one of our site labels (any nesting depth, matched
// by LEAF name)? Returns the site code, or null. Checking the thread's own
// labels directly (not a text search) is what correctly handles nested
// labels — same reasoning as findSiteLabels_ above.
// Labels seen during a run that LOOK like a site code but aren't one. A new
// site gets a new Gmail label the day its first lead lands, and until that
// code is added here the lead is dropped in silence — exactly how The Coffee
// Sleeves' "tcs" was missed. Collected here (the labels are already fetched,
// so it costs nothing) and reported at the end of the run, so a new label
// announces itself the first time it appears instead of weeks later.
var UNKNOWN_SITE_LABELS = {};

function matchSiteCode_(thread) {
  var names = labelNamesOf_(thread);
  var hasCheckout = false;
  var unknown = null;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var parts = name.split('/');
    var leaf = parts[parts.length - 1].trim();
    var code = codeFromLeaf_(leaf);
    if (code) return code;
    if (leaf.toLowerCase() === CHECKOUT_LABEL) hasCheckout = true;
    // NO length filter. There used to be a `leaf.length <= 5` test here, on the
    // assumption that an unmapped label would look like a code — so "Mylar" (5)
    // and "CS" (2) were reported while "ZEE Pack" (8) was not. The alarm built
    // to catch a missing label was itself blind to the label that went missing.
    else if (name.indexOf('ZeeOps/') !== 0 && !isIgnoredLeaf_(leaf)) unknown = name;
  }
  if (unknown) UNKNOWN_SITE_LABELS[unknown] = (UNKNOWN_SITE_LABELS[unknown] || 0) + 1;
  // No site label, but it is a checkout thread — read the store name out of the
  // subject instead (see STORE_NAME_CODES).
  if (hasCheckout) return codeFromSubject_(thread.getFirstMessageSubject());
  return null;
}

function hasCheckoutLabel_(thread) {
  var names = labelNamesOf_(thread);
  for (var i = 0; i < names.length; i++) {
    var parts = names[i].split('/');
    if (parts[parts.length - 1].trim().toLowerCase() === CHECKOUT_LABEL) return true;
  }
  return false;
}

// "[Shop Cardboard Boxes]: New order #6449" → "SCB". Returns null when the
// subject has no bracketed store name, or the name isn't one we know — the
// caller then sends the thread to ZeeOps/Unmatched rather than guessing.
function codeFromSubject_(subject) {
  var subj = String(subject || '');
  var m = subj.match(/\[([^\]]+)\]/);
  if (m) {
    var store = m[1].trim().toLowerCase();
    if (STORE_NAME_CODES[store]) return STORE_NAME_CODES[store];
  }
  // The Astro storefronts (COD cart) don't put the store name anywhere in the
  // subject — theirs reads "New COD order — SCB-1787700487431", where the site
  // code is the order id's own prefix. Read it from there.
  // Found live: SCB-1787700487431 (26 Aug) sat in ZeeOps/Unmatched because the
  // bracketed-store-name match above was the only way in, and a COD order has
  // no brackets. Validated through codeFromLeaf_, so it can only ever resolve
  // to a code we already own and the off switch still applies.
  var order = subj.match(/\b([A-Za-z]{2,5})-\d{6,}\b/);
  if (order) {
    var code = codeFromLeaf_(order[1]);
    if (code) return code;
  }
  return null;
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

// Is this rest-line plausible as a person's name? Guards the positional
// fallback: without it a greeting ("Hello,") or a subject line pasted into
// the body ("New Quote Request — The Wax Papers") becomes the lead's name.
function looksLikeName_(line) {
  if (!line || line.indexOf('@') !== -1) return false;
  if (/^(hi|hello|hey|dear|greetings|good (morning|afternoon|evening))\b/i.test(line)) return false;
  if (/(quote request|enquiry|inquiry|form submission|new message|thank you|submitted|website)/i.test(line)) return false;
  if (/[:—–]/.test(line)) return false;
  var words = line.split(/\s+/);
  if (words.length > 5) return false;
  return /[A-Za-z]/.test(line);
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
  var firstName = '', lastName = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // A form that mails an HTML TABLE with bold labels reaches us as Gmail's
    // plain-text rendering of it: "*Name* Amanda Mead", "*Phone* 8609893221",
    // "*Message:*". There is no colon after the label at all, so neither the
    // labelled matcher nor the colon-less Wax Papers one below could see a
    // field — the first Candle Sleeves lead landed with the literal string
    // "*Name* Amanda Mead" as its name AND its product, and no phone, even
    // though every field was right there. Rewriting the line to the canonical
    // "Label: value" shape here fixes every matcher below at once.
    // A bullet ("* Item") can't match: the closing asterisk is required.
    var em = line.match(/^\*{1,2}\s*([A-Za-z][A-Za-z \-&]{0,30}?)\s*:?\s*\*{1,2}\s*(.*)$/);
    if (em) {
      var emValue = em[2].trim();
      // The other half of the same table rendering: a wider table wraps, so
      // the bold label sits ALONE on its line and its value is the next one
      // ("*Name*\nEric"). Zee Custom Boxes' and The Candle Packaging's "Get A
      // Free Quote" forms are all like this, which is why every one of their
      // leads was named "New submission from Get A Free Quote" — the real name
      // was one line further down and nothing ever looked there.
      // Only consumed when the label's own line is empty and the next line is
      // not itself a label, so "*Length*\n*Width*" can't eat the next field.
      if (!emValue && i + 1 < lines.length) {
        var next = lines[i + 1];
        if (next && !/^\*{1,2}\s*[A-Za-z]/.test(next) && !headerRe.test(next) && !fwdMarkerRe.test(next)) {
          emValue = next;
          i++;
        }
      }
      line = em[1] + ': ' + emValue;
    }

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
      // Split-field forms ("First Name: Katie" / "Last Name: Armstrong")
      // carry the name across two labeled lines; collect both halves and
      // merge after the loop. Without this they fell through to the
      // positional fallback and became name + product respectively.
      var half = lm[1].toLowerCase().trim();
      if (half === 'first name' && lm[2].trim()) { firstName = firstName || lm[2].trim(); continue; }
      if (half === 'last name' && lm[2].trim()) { lastName = lastName || lm[2].trim(); continue; }
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

    // The Wax Papers form emits colon-LESS labeled fields ("Name Jose
    // Rodriguez", "Email x@y.com", "Product custom-deli-papers"). Only exact
    // capitalized field words are matched so ordinary sentences never trigger.
    var bm = line.match(/^(Name|Email|Phone|Product|Company)\s+(\S.*)$/);
    if (bm) {
      var bv = bm[2].trim();
      if (bm[1] === 'Name' && !name && bv) { name = bv; continue; }
      if (bm[1] === 'Email' && !email) {
        var be = bv.match(emailRe);
        if (be && !isOwnAddress_(be[0])) { email = be[0]; continue; }
      }
      if (bm[1] === 'Phone' && !phone) {
        var bd = bv.replace(/\D/g, '');
        if (bd.length >= 7 && bd.length <= 15) { phone = bv; continue; }
      }
      if (bm[1] === 'Product' && !product && bv) { product = bv; continue; }
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
  if (!name && (firstName || lastName)) name = (firstName + ' ' + lastName).trim();
  // Positional name fallback only accepts a line that plausibly IS a name;
  // junk (greetings, subject lines) leaves the field empty rather than wrong —
  // the dashboard falls back to showing the email, which is more useful.
  var restName = '';
  for (var r = 0; r < rest.length; r++) {
    if (looksLikeName_(rest[r])) { restName = rest[r]; break; }
  }
  return {
    name: name || fromName || restName || '',
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
