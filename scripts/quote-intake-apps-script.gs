/**
 * ZeeOps Custom-Quote Lead Intake — Google Apps Script
 *
 * Runs entirely inside your own Gmail account (script.google.com), completely
 * free, no third-party service, no cost regardless of volume.
 *
 * LABEL-ONLY: this only ever touches emails that already carry one of YOUR
 * OWN site labels (SCB, TTP, SFB, KBP, TBB, ZCB, TCP, TPC — see SITE_CODES
 * below), found by walking your actual Gmail label list (not a text search —
 * Gmail's `label:` search string doesn't reliably match NESTED labels like
 * "Extra Outsource Projects/SCB", which is why an earlier version of this
 * script found nothing). It never guesses from sender/subject text, so it
 * can never pick up spam — if you haven't labeled it, it's invisible here.
 * Delete spam as you already do; label the real ones and they'll be picked
 * up on the next run, no matter how deeply the label is nested.
 *
 * SETUP (5 minutes, one time):
 *   1. Go to https://script.google.com → New project.
 *   2. Select all the placeholder code, delete it, paste this whole file in.
 *   3. Save (Cmd/Ctrl+S).
 *   4. Run `testConnection` once (▶ Run, pick it from the function dropdown)
 *      — Google will ask you to authorize; allow it (Advanced → Go to
 *      [project] (unsafe) → Allow — normal for a script you wrote yourself).
 *      Execution log should say "OK: webhook reachable".
 *   5. Run `processQuoteLeads` once — sweeps every already-labeled email you
 *      have right now.
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
// parent folder each one lives under (Extra Outsource Projects/SCB, Our
// Projects/ZCB, top-level TCP — all found the same way). Add a line here the
// day you start labeling a new site (e.g. once TPC exists for The Paper Cups).
var SITE_CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC'];

// Max threads pulled per label per run. Generous — the Processed/Unmatched
// labels are what keep runs fast after the first backlog sweep.
var MAX_THREADS_PER_LABEL = 200;

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

// Diagnostic: lists every Gmail label that matches one of SITE_CODES, and how
// many threads sit under each, WITHOUT sending anything. Run this if
// processQuoteLeads ever reports sent=0 unexpectedly, to confirm the labels
// are actually being found.
function listSiteLabels() {
  var found = findSiteLabels_();
  var codes = Object.keys(found);
  if (codes.length === 0) {
    Logger.log('No Gmail labels matched any of: ' + SITE_CODES.join(', '));
    return;
  }
  for (var i = 0; i < codes.length; i++) {
    var label = found[codes[i]];
    Logger.log(codes[i] + ' → "' + label.getName() + '" (' + label.getThreads(0, 500).length + ' threads)');
  }
}

function processQuoteLeads() {
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);
  var siteLabels = findSiteLabels_(); // { CODE: GmailLabel }

  var sent = 0, skipped = 0, seen = {};

  for (var code in siteLabels) {
    var threads = siteLabels[code].getThreads(0, MAX_THREADS_PER_LABEL);
    for (var t = 0; t < threads.length; t++) {
      var thread = threads[t];
      var id = thread.getId();
      if (seen[id]) continue; // a thread carrying two site labels — already handled
      seen[id] = true;

      if (alreadyHandled_(thread)) continue;

      var messages = thread.getMessages();
      var handledAny = false;
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        var parsed = parseLeadBody_(msg.getPlainBody());
        if (!parsed.email && !parsed.phone) continue;
        if (postLead_(code, parsed, msg.getDate())) { sent++; handledAny = true; }
        // On failure, leave the thread unlabeled so the next run retries it.
      }
      if (handledAny) thread.addLabel(processedLabel);
      else { thread.addLabel(skippedLabel); skipped++; }
    }
  }
  Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// Every Gmail label (any nesting depth) whose LEAF name matches a site code.
// Uses label OBJECTS (GmailApp.getUserLabels() + label.getThreads()), not a
// text search string — Gmail's `label:` search operator does not reliably
// match nested labels by leaf name, which is why the previous version of
// this script found zero threads even for correctly labeled emails.
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
function parseLeadBody_(body) {
  var lines = body.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  var emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  var phoneRe = /^[+()\-.\s\d]{7,20}$/;

  var email = '', phone = '', rest = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var emailMatch = line.match(emailRe);
    if (emailMatch && !email) { email = emailMatch[0]; continue; }
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
