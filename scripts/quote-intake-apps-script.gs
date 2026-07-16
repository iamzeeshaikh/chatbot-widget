/**
 * ZeeOps Custom-Quote Lead Intake — Google Apps Script
 *
 * Runs entirely inside your own Gmail account (script.google.com), completely
 * free, no third-party service, no cost regardless of volume.
 *
 * LABEL-ONLY: this only ever touches emails that already carry one of YOUR
 * OWN site labels (SCB, TTP, SFB, KBP, TBB, ZCB, TCP, TPC — see SITE_CODES
 * below). It never guesses from sender/subject text, so it can never pick up
 * spam — if you haven't labeled it, it's invisible to this script. Delete
 * spam as you already do; label the real ones and they'll be picked up on
 * the next run.
 *
 * SETUP (5 minutes, one time):
 *   1. Go to https://script.google.com → New project.
 *   2. Select all the placeholder code, delete it, paste this whole file in.
 *   3. Save (Cmd/Ctrl+S).
 *   4. Run `testConnection` once (▶ Run, pick it from the function dropdown)
 *      — Google will ask you to authorize; allow it (Advanced → Go to
 *      [project] (unsafe) → Allow — this warning is normal for a script you
 *      wrote yourself, it just means Google hasn't reviewed it, which is
 *      only needed for apps published to other people). Execution log
 *      should say "OK: webhook reachable".
 *   5. Run `processQuoteLeads` once — sweeps every already-labeled email you
 *      have right now.
 *   6. Clock icon (Triggers) on the left → Add Trigger → function
 *      processQuoteLeads, Time-driven, Minutes timer, every N minutes → Save.
 *
 * Every email it successfully sends gets the Gmail label "ZeeOps/Processed"
 * (auto-created) so it's never sent twice — you can see in Gmail exactly
 * which emails were picked up. One that's labeled with a site code but has
 * no readable email/phone gets "ZeeOps/Unmatched" instead, so it doesn't
 * retry forever; check those by hand occasionally.
 */

// ── Config ───────────────────────────────────────────────────────────────
var WEBHOOK_URL = 'https://chat.zeeops.dev/api/quote-intake';
var WEBHOOK_SECRET = 'HX-2yZkO4BsWqO4fsv1SKyyr59WGgMTsjZ67jYbwvWA'; // matches QUOTE_INTAKE_SECRET on the server
var PROCESSED_LABEL = 'ZeeOps/Processed';
var SKIPPED_LABEL = 'ZeeOps/Unmatched'; // labeled with a site code, but no email/phone found in the body

// Your Gmail label names that mean "this is a real lead for this site" —
// matches lib/quoteintake.ts QUOTE_SITE_CODES on the server exactly. Only
// emails carrying one of these labels are ever touched. Add a line here the
// day you start labeling a new site (e.g. once TPC exists for The Paper Cups).
var SITE_CODES = ['SCB', 'TTP', 'SFB', 'KBP', 'TBB', 'ZCB', 'TCP', 'TPC'];

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
  // 400 (missing email/phone) means auth passed and the server is reachable —
  // that's success for a connectivity test. 401 means the secret is wrong.
  if (code === 400) Logger.log('OK: webhook reachable, auth accepted.');
  else if (code === 401) Logger.log('FAILED: webhook rejected the secret (401). Check WEBHOOK_SECRET matches the server.');
  else Logger.log('Unexpected response ' + code + ': ' + res.getContentText());
}

function processQuoteLeads() {
  var processedLabel = getOrCreateLabel_(PROCESSED_LABEL);
  var skippedLabel = getOrCreateLabel_(SKIPPED_LABEL);

  // Only threads that ALREADY carry one of your site labels — nothing else
  // is ever looked at. No date window: it sweeps everything you've ever
  // labeled that hasn't been sent yet (the Processed/Unmatched labels are
  // what stop it from reprocessing, not time).
  var query = buildLabelQuery_() + ' -label:"' + PROCESSED_LABEL + '" -label:"' + SKIPPED_LABEL + '"';
  var threads = GmailApp.search(query, 0, 100);
  var sent = 0, skipped = 0;

  for (var t = 0; t < threads.length; t++) {
    var siteCode = siteCodeFromLabels_(threads[t]);
    if (!siteCode) continue; // shouldn't happen given the query, but be safe

    var messages = threads[t].getMessages();
    var handledAny = false;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var parsed = parseLeadBody_(msg.getPlainBody());
      if (!parsed.email && !parsed.phone) continue;

      var ok = postLead_(siteCode, parsed, msg.getDate());
      if (ok) { sent++; handledAny = true; }
      // On failure, leave unlabeled so the next run retries the whole thread.
    }
    if (handledAny) threads[t].addLabel(processedLabel);
    else { threads[t].addLabel(skippedLabel); skipped++; }
  }
  Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function buildLabelQuery_() {
  var parts = SITE_CODES.map(function (c) { return 'label:' + c; });
  return '(' + parts.join(' OR ') + ')';
}

// Which of YOUR OWN labels (not sender/subject text) is on this thread.
// Handles nested labels (e.g. "Extra Outsource Projects/SCB") by matching the
// leaf name after the last "/".
function siteCodeFromLabels_(thread) {
  var labels = thread.getLabels();
  for (var i = 0; i < labels.length; i++) {
    var parts = labels[i].getName().split('/');
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
