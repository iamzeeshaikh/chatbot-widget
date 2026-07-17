/**
 * ZeeOps Custom-Quote Lead Intake — Google Apps Script
 *
 * Runs entirely inside your own Gmail account (script.google.com), completely
 * free, no third-party service, no cost regardless of volume.
 *
 * LABEL-ONLY: this only ever touches emails that already carry one of YOUR
 * OWN site labels (SCB, TTP, SFB, KBP, TBB, ZCB, TCP, TPC — see SITE_CODES
 * below), found by walking your actual Gmail label list (a plain `label:SCB`
 * TEXT SEARCH doesn't reliably match NESTED labels like "Extra Outsource
 * Projects/SCB" — a `GmailApp.search()` query still doesn't either, even
 * quoted with the label's full path, which is why this walks label OBJECTS
 * instead and calls .getThreads() on each one directly). It never guesses
 * from sender/subject text, so it can never pick up spam — if you haven't
 * labeled it, it's invisible here. Delete spam as you already do; label the
 * real ones and they'll be picked up on a later run, no matter how deeply
 * nested.
 *
 * QUOTA: a personal Gmail account gets a modest daily allowance of Gmail API
 * calls from Apps Script. Running this MUCH more often than the recommended
 * 30-minute trigger (e.g. "every minute") re-scans the same threads far more
 * often than needed and can burn through that allowance in a few hours,
 * failing with "Service invoked too many times for one day: gmail" for the
 * rest of the day. If you ever see that error, widen the trigger interval
 * (Triggers → edit → every 30 min, not more often) and wait for the quota to
 * reset (~24h from when it started failing) — nothing is lost either way,
 * since whatever a run can't get to just waits for the next one.
 *
 * TIME BUDGET: Apps Script kills any run after 6 minutes, and a mailbox with
 * years of backlog under these labels can't be swept in one go. This script
 * checks the clock as it works and stops itself cleanly at ~4.5 minutes,
 * logging how far it got. Nothing is lost — whatever it finished is marked
 * Processed, and your recurring trigger (every 30 min) picks up the rest
 * next time. After the first few runs burn down the backlog, each run
 * finishes in seconds.
 *
 * SETUP (5 minutes, one time):
 *   1. Go to https://script.google.com → New project.
 *   2. Select all the placeholder code, delete it, paste this whole file in.
 *   3. Save (Cmd/Ctrl+S).
 *   4. Run `testConnection` once (▶ Run, pick it from the function dropdown)
 *      — Google will ask you to authorize; allow it (Advanced → Go to
 *      [project] (unsafe) → Allow — normal for a script you wrote yourself).
 *      Execution log should say "OK: webhook reachable".
 *   5. Run `processQuoteLeads` — may need a few manual runs back-to-back at
 *      first if you have a big backlog (each one chips away ~4.5 minutes'
 *      worth); after that the trigger keeps it caught up automatically.
 *   6. Clock icon (Triggers) on the left → Add Trigger → function
 *      processQuoteLeads, Time-driven, Minutes timer, every N minutes → Save.
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
// How many threads to list per label per run — kept moderate so just listing
// them (before any processing) can't itself eat the time budget.
var MAX_THREADS_PER_LABEL = 150;

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

function processQuoteLeads() {
  var start = Date.now();
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);
  var siteLabels = findSiteLabels_(); // { CODE: GmailLabel }

  var sent = 0, skipped = 0, seen = {}, stoppedEarly = false;

  outer:
  for (var code in siteLabels) {
    if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break outer; }

    // Walk the label object's own threads directly — a `GmailApp.search()`
    // text query with a quoted nested label path (tried as an optimization
    // to cut quota use) turned out to silently match nothing for these
    // nested labels, which is why leads stopped arriving even though the
    // script kept reporting "sent=0 skipped=0" with no errors. This object
    // method is the one already proven to find nested labels correctly.
    var threads = siteLabels[code].getThreads(0, MAX_THREADS_PER_LABEL);

    for (var t = 0; t < threads.length; t++) {
      if (Date.now() - start > TIME_BUDGET_MS) { stoppedEarly = true; break outer; }

      var thread = threads[t];
      var id = thread.getId();
      if (seen[id]) continue; // a thread carrying two site labels — already handled
      seen[id] = true;

      if (alreadyHandled_(thread)) continue;

      var messages = thread.getMessages();
      var handledAny = false;
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var parsed = parseLeadBody_(msg.getPlainBody(), SITE_DOMAINS[code]);
        if (!parsed.email && !parsed.phone) continue;
        if (postLead_(code, parsed, msg.getDate())) { sent++; handledAny = true; }
        // On failure, leave the thread unlabeled so a later run retries it.
      }
      if (handledAny) thread.addLabel(processedLabel);
      else { thread.addLabel(skippedLabel); skipped++; }
    }
  }
  Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped +
    (stoppedEarly ? ' — stopped early (time budget); rest will be picked up on the next run.' : ' — done, nothing left to process.'));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
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

function alreadyHandled_(thread) {
  var labels = thread.getLabels();
  for (var i = 0; i < labels.length; i++) {
    var n = labels[i].getName();
    if (n === PROCESSED_LABEL || n === SKIPPED_LABEL) return true;
  }
  return false;
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
// form content. Those headers carry the SITE's own notification address
// (e.g. "From: The Burger Boxes <info@theburgerboxes.com>"), which used to
// get grabbed as "the lead's email" — dropping the real customer's email
// that was sitting a few lines further down. Skip the header block itself,
// and never accept the site's own domain as a candidate email — keep
// scanning until a real (non-self) address turns up.
function parseLeadBody_(body, ownDomain) {
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
      var isOwn = ownDomain && candidate.toLowerCase().indexOf('@' + ownDomain.toLowerCase()) !== -1;
      if (!isOwn) { email = candidate; continue; }
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
