/**
 * ZeeOps Custom-Quote Lead Intake — Google Apps Script
 *
 * Runs entirely inside your own Gmail account (script.google.com), completely
 * free, no third-party service, no cost regardless of volume. On a timer, it
 * scans Gmail for new lead-form emails from your packaging sites, parses the
 * name/email/phone/message, and POSTs each one to the dashboard so it shows
 * up in Billing → alongside chat leads, for month-end totals with your
 * partner.
 *
 * SETUP (5 minutes, one time):
 *   1. Go to https://script.google.com → New project.
 *   2. Delete the placeholder code, paste this whole file in.
 *   3. Run the `testConnection` function once (▶ button, pick it from the
 *      dropdown) — Google will ask you to authorize; allow it (it only reads
 *      Gmail and can only talk to chat.zeeops.dev, nothing else).
 *      Check the Execution log — it should say "OK: webhook reachable".
 *   4. Run `processQuoteLeads` once manually the same way, to do an initial
 *      pass and make sure a real lead comes through into the dashboard.
 *   5. Click the clock icon (Triggers) on the left → Add Trigger →
 *      function: processQuoteLeads, event source: Time-driven,
 *      type: Minutes timer, every 10 minutes → Save.
 *   Done. It now runs forever in the background, for free, inside your Gmail.
 *
 * Every email it successfully sends gets the Gmail label "ZeeOps/Processed"
 * (auto-created) so it's never processed twice — and you can see in Gmail
 * exactly which emails were picked up.
 */

// ── Config ───────────────────────────────────────────────────────────────
var WEBHOOK_URL = 'https://chat.zeeops.dev/api/quote-intake';
var WEBHOOK_SECRET = 'HX-2yZkO4BsWqO4fsv1SKyyr59WGgMTsjZ67jYbwvWA'; // matches QUOTE_INTAKE_SECRET on the server
var PROCESSED_LABEL = 'ZeeOps/Processed';
var SKIPPED_LABEL = 'ZeeOps/Unmatched'; // couldn't tell which site this email is for

// Which site an email belongs to. Matched (case-insensitive) against the
// sender name, subject, sender email domain, and any Gmail label already on
// the thread — first match wins. Add a line here for any new site.
var SITE_MAP = [
  { code: 'SCB', match: ['shopcardboardboxes', 'shop cardboard boxes'] },
  { code: 'TTP', match: ['thetubepackaging', 'tube packaging'] },
  { code: 'SFB', match: ['smallfoodboxes', 'small food boxes'] },
  { code: 'ZCB', match: ['zeecustomboxes', 'zee custom boxes'] },
  { code: 'TPC', match: ['thepapercups', 'paper cups'] },
  { code: 'KBP', match: ['kraftboxpack', 'kraft box pack'] },
  { code: 'TCP', match: ['thecandlepackaging', 'candle packaging'] },
  { code: 'TBB', match: ['theburgerboxes', 'burger boxes'] },
];

// How far back to search each run. Wider than the trigger interval on purpose
// (catches anything a slow run or a Gmail hiccup missed) — the Processed
// label is what actually prevents double-sending, not this window.
var SEARCH_WINDOW = 'newer_than:3d';

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

  var query = SEARCH_WINDOW + ' -label:"' + PROCESSED_LABEL + '" -label:"' + SKIPPED_LABEL + '"';
  var threads = GmailApp.search(query, 0, 100);
  var sent = 0, skipped = 0;

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m];
      var msgLabels = alreadyLabeled_(msg, processedLabel, skippedLabel);
      if (msgLabels) continue; // a previous run already handled this exact message

      var siteCode = matchSiteCode_(msg, threads[t]);
      if (!siteCode) {
        threads[t].addLabel(skippedLabel);
        skipped++;
        continue;
      }

      var parsed = parseLeadBody_(msg.getPlainBody());
      if (!parsed.email && !parsed.phone) {
        threads[t].addLabel(skippedLabel);
        skipped++;
        continue;
      }

      var ok = postLead_(siteCode, parsed, msg.getDate());
      if (ok) {
        threads[t].addLabel(processedLabel);
        sent++;
      }
      // On failure, leave unlabeled so the next run retries it.
    }
  }
  Logger.log('processQuoteLeads: sent=' + sent + ' skipped=' + skipped);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function alreadyLabeled_(msg, processedLabel, skippedLabel) {
  var labels = msg.getThread().getLabels();
  for (var i = 0; i < labels.length; i++) {
    var n = labels[i].getName();
    if (n === PROCESSED_LABEL || n === SKIPPED_LABEL) return true;
  }
  return false;
}

function matchSiteCode_(msg, thread) {
  var haystack = (
    msg.getFrom() + ' ' + msg.getSubject() + ' ' +
    thread.getLabels().map(function (l) { return l.getName(); }).join(' ')
  ).toLowerCase();
  for (var i = 0; i < SITE_MAP.length; i++) {
    var entry = SITE_MAP[i];
    for (var j = 0; j < entry.match.length; j++) {
      if (haystack.indexOf(entry.match[j].toLowerCase()) !== -1) return entry.code;
    }
  }
  return null;
}

// Lead-form emails from these sites list field VALUES one per line with no
// labels (e.g. "Rigid Boxes / suzanne@gmail.com / 8525144962"). We don't try
// to guess which line is which beyond email/phone (regex-detectable); the
// FULL raw body always rides along as `message` so nothing is ever lost even
// if a field gets mis-labeled — you can always read the original text on the
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
