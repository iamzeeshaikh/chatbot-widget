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
 * Every email it successfully sends gets the Gmail label "ZeeOps/Processed"
 * (auto-created) so it's never sent twice. One that's labeled with a site
 * code but has no readable email/phone gets "ZeeOps/Unmatched" instead, so
 * it doesn't retry forever — check those by hand occasionally.
 */

// ── Config ───────────────────────────────────────────────────────────────
var WEBHOOK_URL = 'https://chat.zeeops.dev/api/quote-intake';
var WEBHOOK_SECRET = 'HX-2yZkO4BsWqO4fsv1SKyyr59WGgMTsjZ67jYbwvWA'; // matches QUOTE_INTAKE_SECRET on the server
var PROCESSED_LABEL = 'ZeeOps/Processed';
var SKIPPED_LABEL = 'ZeeOps/Unmatched'; // labeled with a site code, but no email/phone found in the body

// Your Gmail label names that mean "this is a real lead for this site" —
// matches lib/quoteintake.ts QUOTE_SITE_CODES on the server exactly. Matched
// by LEAF name (the part after the last "/"), so it doesn't matter which
// parent folder each one lives under. Add a line here the day you start
// labeling a new site (e.g. once TPC exists for The Paper Cups).
var SITE_CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC'];

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
var RECENT_DAYS = 30;
var MAX_CANDIDATE_THREADS = 500;

// ── Entry points ─────────────────────────────────────────────────────────

function testConnection() {
  var res = UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-quote-secret': WEBHOOK_SECRET },
    payload: JSON.stringify({ siteCode: 'SCB', email: '' }), // intentionally invalid — just checking auth wiring
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code === 400) Logger.log('OK: webhook reachable, auth accepted.');
  else if (code === 401) Logger.log('FAILED: webhook rejected the secret (401). Check WEBHOOK_SECRET matches the server.');
  else Logger.log('Unexpected response ' + code + ': ' + res.getContentText());
}

// Diagnostic: lists every Gmail label that matches one of SITE_CODES, and
// roughly how many threads sit under each (capped, time-budgeted the same
// way as the real run), WITHOUT sending anything.
function listSiteLabels() {
  var start = Date.now();
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

  outer:
  for (var code in siteLabels) {
    if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break outer; }
    var threads = siteLabels[code].getThreads(0, BACKFILL_MAX_THREADS_PER_LABEL);
    for (var t = 0; t < threads.length; t++) {
      if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break outer; }
      var thread = threads[t];
      var id = thread.getId();
      if (seen[id]) continue;
      seen[id] = true;
      if (isHandled_(thread)) continue;

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

  // ONE search across the whole mailbox for recent, not-yet-handled mail —
  // not scoped to any particular site label, so there's no nested-label
  // text-matching to get wrong (that's what broke v5's search). Excluding
  // Processed/Unmatched here is safe and cheap: those two are OUR OWN flat
  // "ZeeOps/…" labels, not the user's arbitrarily-nested site folders.
  var query = 'newer_than:' + RECENT_DAYS + 'd -label:"' + PROCESSED_LABEL + '" -label:"' + SKIPPED_LABEL + '"';
  var threads = GmailApp.search(query, 0, MAX_CANDIDATE_THREADS);

  for (var t = 0; t < threads.length; t++) {
    if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break; }

    var thread = threads[t];
    var code = matchSiteCode_(thread); // null if it doesn't carry one of our site labels
    if (!code) { notOurs++; continue; }

    var messages = thread.getMessages();
    var handledAny = false;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var parsed = parseLeadBody_(msg.getPlainBody());
      if (!parsed.email && !parsed.phone) continue;
      if (postLead_(code, parsed, msg.getDate())) { sent++; handledAny = true; }
      // On failure, leave the thread unlabeled so a later run retries it.
    }
    if (handledAny) thread.addLabel(processedLabel);
    else { thread.addLabel(skippedLabel); skipped++; }
  }
  Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped + ' (scanned ' + threads.length + ' recent threads, ' + notOurs + ' not site-labeled)' +
    (stoppedEarly ? ' — stopped early (time budget); rest will be picked up on the next run.' : ' — done, nothing left to process.'));
}

// ── Helpers ──────────────────────────────────────────────────────────────

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
  for (var i = 0; i < labels.length; i++) {
    var name = labels[i].getName();
    var parts = name.split('/');
    var leaf = parts[parts.length - 1].trim().toUpperCase();
    if (SITE_CODES.indexOf(leaf) !== -1) return leaf;
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

function parseLeadBody_(body) {
  var lines = body.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  var emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var phoneRe = /^[+()\-.\s\d]{7,20}$/;
  var headerRe = /^(From|To|Cc|Bcc|Date|Subject|Sent):/i;
  var fwdMarkerRe = /^-+\s*Forwarded message\s*-+$/i;

  var email = '', phone = '', rest = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (headerRe.test(line) || fwdMarkerRe.test(line)) continue;

    var emailMatch = line.match(emailRe);
    if (emailMatch && !email) {
      var candidate = emailMatch[0];
      if (!isOwnDomain_(candidate)) { email = candidate; continue; }
    }
    var digits = line.replace(/\D/g, '');
    if (!phone && phoneRe.test(line) && digits.length >= 7 && digits.length <= 15) { phone = line; continue; }
    rest.push(line);
  }
  return {
    name: rest[0] || '',
    product: rest[1] || '',
    email: email,
    phone: phone,
    message: lines.join('\n').slice(0, 2000), // full original text, capped
  };
}

function postLead_(siteCode, parsed, receivedDate) {
  try {
    var res = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-quote-secret': WEBHOOK_SECRET },
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
