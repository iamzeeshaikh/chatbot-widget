/**
 * ZeeOps quote intake — LOADER. Paste this ONCE, replacing everything in Code.gs.
 *
 * The real engine lives in the ZeeOps repo and is fetched from
 * https://chat.zeeops.dev/api/intake/script on every run, so changes ship with
 * a ZeeOps deploy and this file never has to be pasted again. The last good
 * copy is kept in Script Properties, so a ZeeOps outage never stops a run.
 *
 * Keep the existing triggers (processQuoteLeads every 30 min, dailyCatchUp
 * daily) and the ZEEOPS_WEBHOOK_SECRET script property — nothing else changes.
 */
var ENGINE_URL = 'https://chat.zeeops.dev/api/intake/script';

// NEVER CALLED. Apps Script decides which permissions to ask for by reading
// THIS file's code, and the engine's Gmail calls live on the server — without
// these lines saving the loader silently dropped the Gmail permission and every
// run failed with "Specified permissions are not sufficient" (24 Oct 2026).
// Keep one call for every Google service the engine uses.
function permissionsTheEngineNeeds_() {
  GmailApp.search('in:inbox', 0, 1);
  GmailApp.getMessagesForThreads(GmailApp.getInboxThreads(0, 1));
  GmailApp.getUserLabels();
  GmailApp.getUserLabelByName('ZeeOps/Processed');
  GmailApp.createLabel('ZeeOps/Processed').addToThread(GmailApp.getInboxThreads(0, 1)[0]);
  UrlFetchApp.fetch(ENGINE_URL);
  Session.getActiveUser().getEmail();
  Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy');
}
var ENGINE_CHUNK = 8000;

function engineFetch_() {
  var secret = PropertiesService.getScriptProperties().getProperty('ZEEOPS_WEBHOOK_SECRET');
  try {
    var r = UrlFetchApp.fetch(ENGINE_URL, { headers: { 'x-quote-secret': secret }, muteHttpExceptions: true });
    var code = r.getResponseCode() === 200 ? r.getContentText() : '';
    if (code.indexOf('function processQuoteLeads') !== -1) { engineSave_(code); return code; }
    Logger.log('Engine fetch returned ' + r.getResponseCode() + ' — using the saved copy.');
  } catch (e) {
    Logger.log('Engine fetch failed (' + e + ') — using the saved copy.');
  }
  return engineLoad_();
}

function engineSave_(code) {
  var props = PropertiesService.getScriptProperties();
  var n = Math.ceil(code.length / ENGINE_CHUNK), out = {};
  for (var i = 0; i < n; i++) out['ENGINE_' + i] = code.slice(i * ENGINE_CHUNK, (i + 1) * ENGINE_CHUNK);
  out.ENGINE_N = String(n);
  props.setProperties(out, false);
}

function engineLoad_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('ENGINE_N') || 0), code = '';
  for (var i = 0; i < n; i++) code += props.getProperty('ENGINE_' + i) || '';
  if (!code) throw new Error('No ZeeOps intake engine available (fetch failed and nothing saved yet).');
  return code;
}

var ENGINE_ = null;
function engine_() {
  if (ENGINE_) return ENGINE_;
  var names = ['processQuoteLeads', 'dailyCatchUp', 'rewindWatermark', 'processQuoteLeadsBackfill', 'testConnection',
    'listSiteLabels', 'diagnoseThread', 'clearNeedsSiteLabel', 'retryUnmatched'];
  var body = engineFetch_() + '\nreturn {' + names.map(function (f) { return f + ': typeof ' + f + " === 'function' ? " + f + ' : null'; }).join(', ') + '};';
  ENGINE_ = new Function(body)();
  return ENGINE_;
}
function run_(name) {
  var f = engine_()[name];
  if (!f) throw new Error('The ZeeOps engine has no function ' + name);
  return f();
}

function processQuoteLeads() { return run_('processQuoteLeads'); }
function dailyCatchUp() { return run_('dailyCatchUp'); }
function rewindWatermark() { return run_('rewindWatermark'); }
function processQuoteLeadsBackfill() { return run_('processQuoteLeadsBackfill'); }
function testConnection() { return run_('testConnection'); }
function listSiteLabels() { return run_('listSiteLabels'); }
function diagnoseThread() { return run_('diagnoseThread'); }
function clearNeedsSiteLabel() { return run_('clearNeedsSiteLabel'); }
function retryUnmatched() { return run_('retryUnmatched'); }
