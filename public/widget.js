(function () {
  'use strict';

  // ─── siteId extraction — must happen BEFORE the duplicate-execution guard ──
  // document.currentScript is null for async/defer scripts (common in WordPress).
  // querySelectorAll + last element handles pages where multiple widget.js tags
  // exist — we want the most recently added one, which is ours.
  var _scriptTag = document.currentScript || (function () {
    var tags = document.querySelectorAll('script[src*="widget.js"]');
    return tags.length ? tags[tags.length - 1] : null;
  })();

  var siteId = 'default';
  try {
    if (_scriptTag && _scriptTag.src) {
      siteId = new URL(_scriptTag.src).searchParams.get('siteId') || 'default';
    }
  } catch (e) {}

  console.log('WIDGET LOADED, siteId:', siteId);

  // ─── Duplicate-execution guard — keyed by siteId ─────────────────────────
  // Must come AFTER siteId is known. Keying by siteId allows two separate
  // sites on the same page to each initialize while still blocking the same
  // site from being initialized twice.
  var _guardKey = '__zeeWidget_' + siteId;
  if (window[_guardKey]) return;
  window[_guardKey] = true;

  var baseUrl = 'https://chat.zeeops.dev';

  function genUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────────
  // A "session" is ONE continuous visit. It rotates to a FRESH sessionId when the
  // visitor has been inactive past the gap (e.g. returning later/next day) or when
  // it exceeds a hard max age. Crucially, ONLY genuine activity (page load + real
  // interactions) extends a session — background pings do NOT. This is what stops
  // a forgotten open tab from keeping a days-old session (and its old conversation)
  // alive: such a tab stops pinging once idle, drops off "live", and the next real
  // interaction starts a fresh session. The live-visitor row and the conversation
  // it opens therefore always share the SAME current sessionId, with today's data.
  // A separate visitorId persists across sessions for repeat-visit counting.
  var SESSION_GAP_MS = 30 * 60 * 1000;        // 30 min of inactivity ends a session
  var SESSION_MAX_MS = 12 * 60 * 60 * 1000;   // hard cap so created_at never gets stale
  var SESSION_ID_KEY = 'zee-session-' + siteId;
  var SESSION_ACT_KEY = 'zee-session-act-' + siteId;     // last GENUINE activity (not pings)
  var SESSION_START_KEY = 'zee-session-start-' + siteId; // session creation time
  var VISITOR_ID_KEY = 'zee-visitor-' + siteId;
  var sessionId, visitorId;
  var lastActWriteMs = 0; // throttle for high-frequency activity events

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function startNewSession(now) {
    sessionId = genUUID();
    lsSet(SESSION_ID_KEY, sessionId);
    lsSet(SESSION_START_KEY, String(now));
    // A rotation means a NEW conversation: the agent side sees a fresh session,
    // so the widget must not keep showing "we've got your details" from the old
    // one, and the visitor becomes askable again. The localStorage keys are all
    // scoped by sessionId and so stop matching on their own; these are the page
    // variables and the two visible bands, which would otherwise persist.
    resetLeadStateForNewSession();
  }

  // Rotate to a fresh session if the visitor has been idle past the gap or the
  // session has outlived the max age. Never extends activity by itself.
  function ensureFreshSession() {
    var now = Date.now();
    if (!sessionId) sessionId = lsGet(SESSION_ID_KEY) || null;
    var last = parseInt(lsGet(SESSION_ACT_KEY), 10) || 0;
    var start = parseInt(lsGet(SESSION_START_KEY), 10) || 0;
    if (!sessionId || !last || (now - last) > SESSION_GAP_MS || !start || (now - start) > SESSION_MAX_MS) {
      startNewSession(now);
    }
  }

  // Time since the last GENUINE activity (interaction / load) — NOT pings.
  function idleMs() {
    var last = parseInt(lsGet(SESSION_ACT_KEY), 10) || 0;
    return last ? (Date.now() - last) : Infinity;
  }

  // Record genuine activity: rotate the session first if a gap elapsed, then stamp.
  function markActivity() {
    ensureFreshSession();
    lsSet(SESSION_ACT_KEY, String(Date.now()));
  }

  // Track genuine presence (interactions + tab becoming visible). When the
  // visitor was idle past the gap, this resumes a FRESH session and pings
  // immediately; otherwise it just refreshes the activity stamp (throttled).
  function bindActivityTracking() {
    function onActivity() {
      var wasIdle = idleMs() > SESSION_GAP_MS;
      if (wasIdle) {
        markActivity();
        lastActWriteMs = Date.now();
        sendPing('active'); // resume presence right away with the fresh session
      } else if (Date.now() - lastActWriteMs > 20000) {
        markActivity();
        lastActWriteMs = Date.now();
      }
    }
    ['pointerdown', 'keydown', 'scroll', 'mousemove', 'touchstart', 'click'].forEach(function (ev) {
      window.addEventListener(ev, onActivity, { capture: true, passive: true });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') onActivity();
    });
  }

  try {
    visitorId = lsGet(VISITOR_ID_KEY);
    if (!visitorId) { visitorId = genUUID(); lsSet(VISITOR_ID_KEY, visitorId); }
    sessionId = lsGet(SESSION_ID_KEY);
    ensureFreshSession();                 // reuse if recently active, else fresh
    lsSet(SESSION_ACT_KEY, String(Date.now())); // the page load itself is activity
  } catch (e) {
    // Storage blocked (e.g. private mode) — fall back to a single per-load id.
    sessionId = genUUID();
    visitorId = sessionId;
  }

  var messages = [];
  var botMessageCount = 0;

  // sessionId whose lead form was submitted, and (separately) whose confirmation
  // the visitor dismissed. Same per-session shape as AUTOOPEN_KEY/DING_KEY, but
  // declared HERE rather than with those keys further down: `var` hoisting would
  // otherwise make LEAD_KEY undefined at the line below and the restore would
  // silently never fire.
  //
  // The transcript is NOT rebuilt on reload (messages starts empty, pollSince is
  // "now"), so without this a visitor who refreshes gets the empty form again as
  // if they had never submitted. Client-side on purpose — the lead itself is
  // already written server-side, so this needs no new control role.
  var LEAD_KEY = 'zee-lead-' + siteId;
  var LEAD_ACK_KEY = 'zee-lead-ack-' + siteId;
  var LEAD_X_KEY = 'zee-lead-x-' + siteId;   // visitor dismissed the ASK

  // Scoped to the CURRENT sessionId: once the session rotates
  // (ensureFreshSession) that is a new conversation, and asking again is right.
  var leadCaptured = lsGet(LEAD_KEY) === sessionId;
  var greetingSent = false;
  var config = { bot_name: 'Assistant', primary_color: '#2563eb', site_id: siteId, name: '' };

  // ─── Lead prompt: WHEN we ask for contact details ───────────────────────────
  // EVERY THRESHOLD FOR ASKING LIVES IN THIS ONE OBJECT. Tune here, nowhere else.
  //
  // Why this was rebuilt: the form used to need a bot reply, an agent reply or a
  // file upload to even be considered, and then >= 3 visitor messages on top.
  // Measured over all 412 real conversations in chat_logs (see
  // scratch/trigger-coverage.mjs): 48.8% of conversations are a SINGLE message,
  // only 34.7% ever reach three, and with the bot globally disabled the only
  // live path left was a 2-minute timer. 46.4% of visitors were never asked for
  // their details at all.
  //
  // The rule now: the visitor said something and nobody answered → ask. Plus a
  // last chance when they leave. Both are non-blocking bands; the composer stays
  // usable the whole time.
  var LEAD_PROMPT = {
    // Ask this long after a visitor message that received no reply. 30s of
    // silence after asking a question is a real "nobody is there" moment.
    // 87% of visitors are still on the page at 30s (92% at 15s, 79% at 60s).
    idleMs: 30 * 1000,
    // Minimum genuine visitor messages before we will ask at all. 1 is
    // deliberate: half of all conversations never send a second message.
    minMessages: 1,
    // An agent replied this recently → the conversation is live, so wait rather
    // than cutting in. The prompt re-checks instead of being dropped.
    activeConvoMs: 60 * 1000,
    // How long to wait before re-checking when a fire was deferred.
    retryMs: 15 * 1000,
    // Stop re-deferring eventually so a timer cannot live forever.
    maxDefers: 8,
    // Catch visitors who leave before idleMs: desktop pointer leaving the top of
    // the viewport, or the tab being hidden/closed (the mobile equivalent —
    // 42% of these conversations are mobile, where there is no exit intent).
    exitIntent: true,
  };
  var leadPromptTimer = null;
  var leadPromptDefers = 0;
  var lastAgentReplyMs = 0;
  var leadPromptDismissed = lsGet(LEAD_X_KEY) === sessionId;

  // ─── Visit count + original referrer (persistent per browser/site) ──────────
  // visitCount increments on every page load; firstReferrer is captured once on
  // the very first visit so we always know where the visitor originally came
  // from (later same-site navigations don't overwrite it).
  var visitCount = 1;
  var firstReferrer = '';
  try {
    visitCount = (parseInt(localStorage.getItem('zee-visits-' + siteId), 10) || 0) + 1;
    localStorage.setItem('zee-visits-' + siteId, String(visitCount));
    firstReferrer = localStorage.getItem('zee-ref-' + siteId);
    if (firstReferrer === null) {
      firstReferrer = document.referrer || '';
      localStorage.setItem('zee-ref-' + siteId, firstReferrer);
    }
  } catch (e) {
    visitCount = 1;
    firstReferrer = document.referrer || '';
  }

  // ─── Polling state ────────────────────────────────────────────────────────
  var pollSince = new Date().toISOString();
  var pollTimer = null;
  var lastTypingPingMs = 0;      // throttle for visitor-typing pings
  var agentTypingShown = false;  // typing dots currently shown for agent typing

  // ─── Audio state ────────────────────────────────────────────────────────────
  // One shared AudioContext, reused for every sound and resumed on the visitor's
  // first interaction (browsers block audio until then). landingSoundPlayed makes
  // the "chat is available" ding fire at most once per page load.
  var audioCtx = null;
  var landingSoundPlayed = false;
  var interactionUnlockBound = false;

  // ─── Cross-page quiet rules ─────────────────────────────────────────────────
  // Everything below is stored in localStorage, NOT in page variables, because a
  // shopper browsing a store loads a new page every few seconds. Page-scoped
  // flags meant the greeting chime, the landing ding and the auto-open all fired
  // again on EVERY page — which reads to the visitor as a chat box that keeps
  // popping up and dinging no matter how often they close it. (A real visitor
  // left over exactly this: "if i close the popup it just keeps ringing anyway.")
  //
  //  • closing the chat = an explicit "leave me alone": silences ALL announcement
  //    sounds and stops auto-open for DISMISS_QUIET_MS. Re-opening it by hand
  //    clears the flag.
  //  • the landing ding and the auto-open happen at most ONCE per session, not
  //    once per page load.
  // Replies from an agent/bot inside an open chat still ding — that's the one
  // sound the visitor is actually waiting for.
  var DISMISS_KEY = 'zee-dismissed-' + siteId;  // ms timestamp of the last close
  var AUTOOPEN_KEY = 'zee-autoopen-' + siteId;  // sessionId that already auto-opened
  var DING_KEY = 'zee-ding-' + siteId;          // sessionId that already heard the ding
  var MUTE_KEY = 'zee-muted-' + siteId;         // visitor turned sound off (persistent)
  var DISMISS_QUIET_MS = 24 * 60 * 60 * 1000;   // stay quiet for 24h after a close

  // Visitor-controlled mute (speaker button in the chat header). Persisted per
  // site and never expires — if someone says "no sound", we don't ask again.
  function isMuted() { return lsGet(MUTE_KEY) === '1'; }
  function setMuted(on) { if (on) lsSet(MUTE_KEY, '1'); else lsDel(MUTE_KEY); }

  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function wasDismissed() {
    var t = parseInt(lsGet(DISMISS_KEY), 10) || 0;
    return t > 0 && (Date.now() - t) < DISMISS_QUIET_MS;
  }
  function markDismissed() { lsSet(DISMISS_KEY, String(Date.now())); }
  function clearDismissed() { lsDel(DISMISS_KEY); }

  // The landing ding is per SESSION, so navigating the site stays silent.
  function landingDingDone() { return landingSoundPlayed || lsGet(DING_KEY) === sessionId; }
  function markLandingDing() { landingSoundPlayed = true; lsSet(DING_KEY, sessionId); }

  // ─── CSS ──────────────────────────────────────────────────────────────────
  // `widgetOpts` comes from /api/site-config (see that route). Anything it
  // changes is appended as an OVERRIDE block after the base stylesheet rather
  // than branching inside it, so a site on the default size receives byte-for-
  // byte the CSS it received before this existed.
  function injectCSS(primaryColor, widgetOpts) {
    var existing = document.getElementById('zee-chat-widget-css');
    if (existing) existing.remove();

    var css = '\
#zee-chat-widget * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }\
#zee-chat-widget-btn { position: fixed; bottom: 24px; right: 24px; width: 60px; height: 60px; border-radius: 50%; background: ' + primaryColor + '; border: none; cursor: pointer; z-index: 999999; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 20px rgba(0,0,0,0.25); transition: transform 0.2s ease, box-shadow 0.2s ease; }\
#zee-chat-widget-btn:hover { transform: scale(1.08); box-shadow: 0 6px 28px rgba(0,0,0,0.3); }\
#zee-chat-widget-btn svg { width: 28px; height: 28px; fill: white; }\
#zee-chat-widget { position: fixed; bottom: 96px; right: 24px; width: 380px; height: 520px; background: #fff; border-radius: 16px; box-shadow: 0 10px 50px rgba(0,0,0,0.18); z-index: 999998; display: flex; flex-direction: column; overflow: hidden; transform: scale(0.95) translateY(10px); opacity: 0; pointer-events: none; transition: transform 0.25s ease, opacity 0.25s ease; }\
#zee-chat-widget.open { transform: scale(1) translateY(0); opacity: 1; pointer-events: all; }\
#zee-chat-header { background: ' + primaryColor + '; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }\
#zee-chat-header-left { display: flex; align-items: center; gap: 10px; }\
#zee-chat-avatar { width: 36px; height: 36px; border-radius: 50%; background: white; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700; line-height: 1; }\
#zee-chat-title { color: white; font-weight: 600; font-size: 15px; }\
#zee-chat-subtitle { color: rgba(255,255,255,0.8); font-size: 11px; }\
#zee-chat-header-actions { display: flex; align-items: center; gap: 2px; }\
#zee-chat-close, #zee-chat-mute { background: none; border: none; cursor: pointer; color: white; padding: 4px; border-radius: 6px; display: flex; align-items: center; justify-content: center; opacity: 0.8; transition: opacity 0.2s; }\
#zee-chat-close:hover, #zee-chat-mute:hover { opacity: 1; }\
#zee-chat-mute svg { width: 19px; height: 19px; fill: white; }\
#zee-chat-mute.muted { opacity: 0.55; }\
#zee-chat-messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #f9fafb; }\
#zee-chat-messages::-webkit-scrollbar { width: 4px; }\
#zee-chat-messages::-webkit-scrollbar-track { background: transparent; }\
#zee-chat-messages::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 4px; }\
.zee-msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; word-wrap: break-word; }\
.zee-msg.user { align-self: flex-end; background: ' + primaryColor + '; color: white; border-bottom-right-radius: 4px; }\
.zee-msg.bot { align-self: flex-start; background: white; color: #1f2937; border-bottom-left-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }\
.zee-typing { display: flex; gap: 5px; align-items: center; padding: 12px 16px; }\
.zee-typing span { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; animation: zeeTyping 1.2s infinite; }\
.zee-typing span:nth-child(2) { animation-delay: 0.2s; }\
.zee-typing span:nth-child(3) { animation-delay: 0.4s; }\
@keyframes zeeTyping { 0%,60%,100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-6px); opacity: 1; } }\
@keyframes zeeStreamBlink { 50% { opacity:0; } }\
.zee-stream-cursor { display:inline-block; width:2px; height:0.9em; background:#9ca3af; animation:zeeStreamBlink 0.6s step-end infinite; vertical-align:text-bottom; margin-left:1px; }\
#zee-chat-input-area { padding: 12px 14px; background: white; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0; }\
#zee-chat-input { flex: 1; border: 1.5px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; font-size: 14px; resize: none; outline: none; max-height: 100px; line-height: 1.4; transition: border-color 0.2s; }\
#zee-chat-input:focus { border-color: ' + primaryColor + '; }\
#zee-chat-send { background: ' + primaryColor + '; border: none; border-radius: 10px; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: opacity 0.2s; }\
#zee-chat-send:hover { opacity: 0.85; }\
#zee-chat-send svg { width: 18px; height: 18px; fill: white; }\
#zee-chat-attach { background: #f3f4f6; border: 1.5px solid #e5e7eb; border-radius: 10px; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.2s, border-color 0.2s; }\
#zee-chat-attach:hover { background: #e5e7eb; }\
#zee-chat-attach svg { width: 18px; height: 18px; fill: #6b7280; }\
#zee-chat-attach.uploading { opacity: 0.6; pointer-events: none; }\
.zee-msg-att { padding: 6px !important; }\
.zee-att-img img { display: block; max-width: 200px; max-height: 200px; border-radius: 8px; cursor: pointer; }\
.zee-att-file { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; max-width: 240px; }\
.zee-att-icon { font-size: 22px; flex-shrink: 0; }\
.zee-att-meta { display: flex; flex-direction: column; min-width: 0; }\
.zee-att-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: underline; }\
.zee-att-size { font-size: 11px; opacity: 0.7; }\
.zee-upload-err { align-self: center; font-size: 12px; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 6px 10px; }\
#zee-lead-form { padding: 14px 16px; background: #f0f9ff; border-top: 1px solid #bae6fd; flex-shrink: 0; position: relative; }\
#zee-lead-form p { font-size: 13px; color: #0369a1; font-weight: 500; margin-bottom: 10px; padding-right: 20px; }\
.zee-lead-x { position: absolute; top: 10px; right: 11px; background: none; border: none; cursor: pointer; padding: 3px; line-height: 0; border-radius: 4px; opacity: 0.55; }\
.zee-lead-x:hover { opacity: 1; background: rgba(3,105,161,0.1); }\
.zee-lead-x svg { width: 13px; height: 13px; fill: #0369a1; display: block; }\
.zee-lead-input { width: 100%; border: 1.5px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; font-size: 13px; margin-bottom: 8px; outline: none; transition: border-color 0.2s; }\
.zee-lead-input:focus { border-color: ' + primaryColor + '; }\
#zee-lead-submit { width: 100%; background: ' + primaryColor + '; color: white; border: none; border-radius: 8px; padding: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }\
#zee-lead-submit:hover { opacity: 0.88; }\
#zee-lead-submit:disabled { opacity: 0.6; cursor: default; }\
.zee-lead-input.zee-invalid { border-color: #dc2626; }\
/* Inline validation/submit error. Replaces an alert(), which on a phone is a\
   system modal over the whole page — it hides the widget, cannot be styled, and\
   reads as the SITE breaking rather than one field needing attention. */\
.zee-lead-err { font-size: 12px; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 6px 9px; margin-bottom: 8px; }\
/* Confirmation state. Same band as the form so the panel does not jump, but\
   green rather than the form blue — a visitor should be able to tell at a\
   glance that this is "done", not another thing to fill in. Kept to two lines\
   because on mobile this sits directly above the input area. */\
#zee-lead-done { padding: 12px 14px; background: #f0fdf4; border-top: 1px solid #bbf7d0; flex-shrink: 0; display: none; }\
#zee-lead-done.shown { display: block; }\
.zee-done-row { display: flex; align-items: flex-start; gap: 9px; }\
.zee-done-check { width: 20px; height: 20px; border-radius: 50%; background: #16a34a; flex-shrink: 0; display: flex; align-items: center; justify-content: center; margin-top: 1px; }\
.zee-done-check svg { width: 12px; height: 12px; fill: white; display: block; }\
.zee-done-text { min-width: 0; flex: 1; }\
.zee-done-title { font-size: 13px; font-weight: 600; color: #14532d; line-height: 1.35; }\
.zee-done-sub { font-size: 12px; color: #166534; line-height: 1.45; margin-top: 2px; }\
.zee-done-mail { font-weight: 600; overflow-wrap: anywhere; }\
.zee-done-x { background: none; border: none; cursor: pointer; padding: 2px; margin: -2px -2px 0 0; flex-shrink: 0; line-height: 0; border-radius: 4px; opacity: 0.65; }\
.zee-done-x:hover { opacity: 1; background: rgba(22,101,52,0.1); }\
.zee-done-x svg { width: 13px; height: 13px; fill: #166534; display: block; }\
.zee-ol { margin: 6px 0 6px 18px; padding: 0; }\
/* These three used to be style="" attributes on the markup. A site whose CSP\
   carries style hashes blocks inline style ATTRIBUTES too, which left the file\
   picker and the lead form visible and the avatar letter unbranded. Setting\
   them from the stylesheet keeps the JS toggles working — element.style.display\
   set from script is CSSOM and stays allowed. */\
#zee-chat-file { display: none; }\
#zee-lead-form { display: none; }\
#zee-chat-avatar { color: ' + primaryColor + '; }\
@media (max-width: 767px) { #zee-chat-widget { bottom: 0; right: 0; width: 100%; height: 100%; border-radius: 0; } #zee-chat-widget-btn { bottom: 16px; right: 16px; } }';

    // ── Optional "large" presentation ────────────────────────────────────────
    // Appended last so it wins, and the PANEL half is wrapped in a min-width
    // query: below 768px the base stylesheet makes the panel fullscreen, and an
    // unguarded width/height here would come after that rule and undo it.
    // The bubble keeps a plain background-color underneath — the sheen is a
    // background-IMAGE layer, so it needs no colour arithmetic on primaryColor.
    if (widgetOpts && widgetOpts.size === 'large') {
      css += '\
#zee-chat-widget-btn { width: 68px; height: 68px; background-image: linear-gradient(145deg, rgba(255,255,255,0.26), rgba(255,255,255,0) 62%); box-shadow: 0 6px 24px rgba(0,0,0,0.28); }\
#zee-chat-widget-btn:hover { transform: scale(1.06) translateY(-2px); box-shadow: 0 12px 34px rgba(0,0,0,0.34); }\
#zee-chat-widget-btn svg { width: 32px; height: 32px; }\
#zee-chat-header { padding: 16px 18px; background-image: linear-gradient(160deg, rgba(255,255,255,0.16), rgba(255,255,255,0) 70%); }\
#zee-chat-avatar { width: 40px; height: 40px; font-size: 16px; }\
#zee-chat-title { font-size: 16px; }\
#zee-chat-subtitle { font-size: 12px; }\
@media (min-width: 768px) { #zee-chat-widget { width: 420px; height: 580px; bottom: 104px; border-radius: 20px; box-shadow: 0 16px 60px rgba(0,0,0,0.22); } }';
    }

    var style = document.createElement('style');
    style.id = 'zee-chat-widget-css';
    style.textContent = css;
    document.head.appendChild(style);

    // A site with a strict style-src (hashes or a nonce, no 'unsafe-inline')
    // silently refuses this stylesheet: the <style> stays in the DOM but its
    // .sheet is null, so the widget renders completely unstyled and the visitor
    // sees nothing usable. A hash can't help — the CSS carries the site's brand
    // colour, so it differs per site and changes whenever that colour does.
    //
    // Constructed stylesheets are governed by CSSOM, not style-src, so this
    // fallback restores the CSS without asking the site to weaken its policy.
    if (!style.sheet && typeof CSSStyleSheet === 'function') {
      try {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
        style.remove();
      } catch (e) {
        // Pre-2023 browser without constructed stylesheets. Nothing further to
        // try — leave the blocked <style> in place rather than break the page.
      }
    }
  }

  // ─── DOM ──────────────────────────────────────────────────────────────────
  function buildWidget() {
    if (document.getElementById('zee-chat-widget')) {
      console.log('buildWidget: widget already in DOM, skipping');
      return;
    }
    var btn = document.createElement('button');
    btn.id = 'zee-chat-widget-btn';
    btn.setAttribute('aria-label', 'Open chat');
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';

    var widget = document.createElement('div');
    widget.id = 'zee-chat-widget';
    widget.setAttribute('role', 'dialog');
    widget.setAttribute('aria-label', 'Chat widget');
    widget.innerHTML = '\
<div id="zee-chat-header">\
  <div id="zee-chat-header-left">\
    <div id="zee-chat-avatar">' + escapeHtml((config.bot_name || 'A')[0].toUpperCase()) + '</div>\
    <div><div id="zee-chat-title">' + escapeHtml(config.bot_name) + '</div><div id="zee-chat-subtitle">Online · Ready to help</div></div>\
  </div>\
  <div id="zee-chat-header-actions">\
    <button id="zee-chat-mute" aria-label="Turn sound off" title="Turn sound off"></button>\
    <button id="zee-chat-close" aria-label="Close chat"><svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>\
  </div>\
</div>\
<div id="zee-chat-messages"></div>\
<div id="zee-lead-form">\
  <button class="zee-lead-x" id="zee-lead-dismiss" aria-label="Not now" title="Not now"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>\
  <p>Leave your details and we\'ll follow up with you!</p>\
  <div id="zee-lead-error" class="zee-lead-err" role="alert" hidden></div>\
  <input class="zee-lead-input" id="zee-lead-name" placeholder="Your Name *" type="text" autocomplete="name" />\
  <input class="zee-lead-input" id="zee-lead-email" placeholder="Email Address *" type="email" autocomplete="email" inputmode="email" />\
  <input class="zee-lead-input" id="zee-lead-phone" placeholder="Phone (optional)" type="tel" autocomplete="tel" inputmode="tel" />\
  <button id="zee-lead-submit">Submit & Continue Chat</button>\
</div>\
<div id="zee-lead-done" role="status" aria-live="polite">\
  <div class="zee-done-row">\
    <span class="zee-done-check"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>\
    <span class="zee-done-text">\
      <span class="zee-done-title" id="zee-done-title">Thanks — we\'ve got your details.</span>\
      <span class="zee-done-sub" id="zee-done-sub"></span>\
    </span>\
    <button class="zee-done-x" id="zee-lead-done-x" aria-label="Dismiss confirmation" title="Dismiss"><svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>\
  </div>\
</div>\
<div id="zee-chat-input-area">\
  <input id="zee-chat-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf" />\
  <button id="zee-chat-attach" aria-label="Attach a file" title="Attach a file"><svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 01-8 0V5a2.5 2.5 0 015 0v10.5a1 1 0 01-2 0V6H10v9.5a2.5 2.5 0 005 0V5a4 4 0 00-8 0v12.5a5.5 5.5 0 0011 0V6h-1.5z"/></svg></button>\
  <textarea id="zee-chat-input" placeholder="Type your message..." rows="1"></textarea>\
  <button id="zee-chat-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>\
</div>';

    document.body.appendChild(btn);
    document.body.appendChild(widget);

    btn.addEventListener('click', function () {
      widget.classList.toggle('open');
      if (widget.classList.contains('open')) {
        clearDismissed(); // opening it by hand undoes an earlier "leave me alone"
        sendBotGreeting();
        startPolling();
      } else {
        markDismissed();
        stopPolling();
      }
      btn.innerHTML = widget.classList.contains('open')
        ? '<svg viewBox="0 0 24 24" fill="white" width="26" height="26"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    });

    // ─── Sound on/off ────────────────────────────────────────────────────────
    // A visitor who dislikes the chime shouldn't have to close the chat (or the
    // whole site) to stop it. The speaker button silences every widget sound and
    // the choice sticks across pages and future visits.
    var SVG_SOUND_ON = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
    var SVG_SOUND_OFF = '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
    var muteBtn = document.getElementById('zee-chat-mute');
    function renderMuteBtn() {
      var off = isMuted();
      muteBtn.innerHTML = off ? SVG_SOUND_OFF : SVG_SOUND_ON;
      muteBtn.setAttribute('aria-label', off ? 'Turn sound on' : 'Turn sound off');
      muteBtn.setAttribute('title', off ? 'Sound off — click to turn on' : 'Turn sound off');
      muteBtn.setAttribute('aria-pressed', off ? 'true' : 'false');
      if (off) muteBtn.classList.add('muted'); else muteBtn.classList.remove('muted');
    }
    renderMuteBtn();
    muteBtn.addEventListener('click', function () {
      var turningOn = isMuted(); // currently muted → this click un-mutes
      setMuted(!turningOn);
      renderMuteBtn();
      // Unmuting plays a soft confirmation so they can hear what they turned on.
      if (turningOn) playChime(0.45);
    });

    document.getElementById('zee-chat-close').addEventListener('click', function () {
      console.log('widget closed by user click');
      widget.classList.remove('open');
      markDismissed(); // no more auto-opens or announcement sounds for 24h
      stopPolling();
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    });

    var input = document.getElementById('zee-chat-input');
    var sendBtn = document.getElementById('zee-chat-send');

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
      // Typing indicator: tell the server (throttled) so the agent dashboard
      // can show "visitor is typing…".
      var now = Date.now();
      if (this.value.trim() && now - lastTypingPingMs > 3000) {
        lastTypingPingMs = now;
        fetch(baseUrl + '/api/chat/typing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
          keepalive: true,
        }).catch(function () {});
      }
    });

    sendBtn.addEventListener('click', handleSend);

    var attachBtn = document.getElementById('zee-chat-attach');
    var fileInput = document.getElementById('zee-chat-file');
    attachBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) handleFileUpload(fileInput.files[0]);
      fileInput.value = ''; // allow re-selecting the same file
    });

    document.getElementById('zee-lead-submit').addEventListener('click', handleLeadSubmit);

    var leadDoneX = document.getElementById('zee-lead-done-x');
    if (leadDoneX) leadDoneX.addEventListener('click', dismissLeadConfirmation);

    var leadDismiss = document.getElementById('zee-lead-dismiss');
    if (leadDismiss) leadDismiss.addEventListener('click', dismissLeadPrompt);

    bindExitIntent();

    // Enter submits from any of the three fields — on a phone keyboard the "go"
    // key is far more reachable than the button once it scrolls under the
    // keyboard. Clearing the error on input stops a stale message sitting there
    // while the visitor is already fixing the field it refers to.
    ['zee-lead-name', 'zee-lead-email', 'zee-lead-phone'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); handleLeadSubmit(); }
      });
      el.addEventListener('input', clearLeadError);
    });

    // A lead captured earlier in this session: show the confirmation instead of
    // the form, so a refresh does not present an empty form as if nothing had
    // been submitted.
    if (leadCaptured) showLeadConfirmation('', '');

    // Auto-open after 5 seconds — but only ONCE per session, and never after the
    // visitor has closed it. Without these two guards every page load re-opened
    // the panel, so closing it appeared to do nothing at all.
    setTimeout(function () {
      console.log('widget auto-open timer fired, already open=' + widget.classList.contains('open'));
      if (wasDismissed()) { console.log('auto-open skipped: visitor closed the chat'); return; }
      if (lsGet(AUTOOPEN_KEY) === sessionId) { console.log('auto-open skipped: already auto-opened this session'); return; }
      if (!widget.classList.contains('open')) {
        lsSet(AUTOOPEN_KEY, sessionId);
        console.log('widget auto-opening');
        widget.classList.add('open');
        console.log('widget open class set: ' + widget.classList.contains('open'));
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="white" width="26" height="26"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        sendBotGreeting();
        startPolling();
      }
    }, 5000);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function scrollToBottom() {
    var el = document.getElementById('zee-chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function renderText(role, text) {
    if (role !== 'bot') return escapeHtml(text);

    var s = escapeHtml(text);

    // Use placeholders so bold markers are safe during italic pass
    s = s.replace(/\*\*(.+?)\*\*/g, '\x00$1\x01');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/\x00(.+?)\x01/g, '<strong>$1</strong>');

    // Numbered lists: collect consecutive `N. text` lines into <ol>
    var lines = s.split('\n');
    var out = [];
    var listBuf = [];

    function flushList() {
      if (listBuf.length) {
        out.push('<ol class="zee-ol">' + listBuf.join('') + '</ol>');
        listBuf = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^\d+\.\s+(.+)$/);
      if (m) {
        listBuf.push('<li>' + m[1] + '</li>');
      } else {
        flushList();
        out.push(lines[i]);
      }
    }
    flushList();

    // Join with <br>, but don't add <br> directly adjacent to block tags
    return out.join('<br>').replace(/<br>(<ol)/g, '$1').replace(/(<\/ol>)<br>/g, '$1');
  }

  // A file message stores a JSON marker {"__file":{url,name,mime,size}} as its
  // text. Detect + parse it so we can render a thumbnail / download link instead
  // of raw JSON. Mirrors lib/attachment.ts on the server.
  function parseFileMessage(text) {
    if (!text) return null;
    var t = String(text).replace(/^\s+/, '');
    if (t.charAt(0) !== '{' || t.indexOf('__file') === -1) return null;
    try {
      var o = JSON.parse(t);
      if (o && o.__file && typeof o.__file.url === 'string') return o.__file;
    } catch (e) {}
    return null;
  }

  function formatBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function attachmentHtml(file) {
    var url = escapeHtml(file.url);
    var name = escapeHtml(file.name || 'file');
    var isImage = (file.mime || '').indexOf('image/') === 0;
    if (isImage) {
      return '<a href="' + url + '" target="_blank" rel="noopener" class="zee-att-img">' +
        '<img src="' + url + '" alt="' + name + '" /></a>';
    }
    return '<a href="' + url + '" target="_blank" rel="noopener" class="zee-att-file">' +
      '<span class="zee-att-icon">📄</span>' +
      '<span class="zee-att-meta"><span class="zee-att-name">' + name + '</span>' +
      '<span class="zee-att-size">' + formatBytes(file.size) + '</span></span></a>';
  }

  function appendMessage(role, text) {
    var el = document.getElementById('zee-chat-messages');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'zee-msg ' + role;
    var file = parseFileMessage(text);
    if (file) {
      div.className += ' zee-msg-att';
      div.innerHTML = attachmentHtml(file);
    } else {
      div.innerHTML = renderText(role, text);
    }
    el.appendChild(div);
    scrollToBottom();
  }

  function showTyping() {
    var el = document.getElementById('zee-chat-messages');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'zee-msg bot zee-typing-wrapper';
    div.id = 'zee-typing-indicator';
    div.innerHTML = '<div class="zee-typing"><span></span><span></span><span></span></div>';
    el.appendChild(div);
    scrollToBottom();
  }

  function hideTyping() {
    var el = document.getElementById('zee-typing-indicator');
    if (el) el.remove();
  }

  // Number of genuine user messages (excludes the '(session started)' sentinel).
  function genuineUserCount() {
    var n = 0;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user' && messages[i].content !== '(session started)') n++;
    }
    return n;
  }

  function lastUserText() {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].content !== '(session started)') {
        return (messages[i].content || '').toLowerCase();
      }
    }
    return '';
  }

  // User explicitly asks to leave details / get contacted / typed an email.
  function userWantsToLeaveDetails() {
    var t = lastUserText();
    return /\b(my email|my number|my phone|contact me|call me|email me|reach me|send (me )?(a |the )?(quote|proposal|details|info)|here'?s my|you can reach me)\b/.test(t)
      || /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t);
  }

  // True once the visitor has given us an email — via the lead form (leadCaptured)
  // or by typing one into the chat. Used so the safety-net never nags for details
  // we already have.
  function visitorHasProvidedEmail() {
    if (leadCaptured) return true;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'user' && /[\w.+-]+@[\w-]+\.[\w.-]+/.test(m.content || '')) return true;
    }
    return false;
  }

  // ─── Lead prompt ────────────────────────────────────────────────────────────
  // Called by startNewSession when a session rotates (30+ min idle). Declared as
  // a function so hoisting makes it callable from there, which runs before this
  // point during init — the DOM does not exist yet on that first call, hence the
  // null guards.
  function resetLeadStateForNewSession() {
    leadCaptured = false;
    leadPromptDismissed = false;
    leadPromptDefers = 0;
    lastAgentReplyMs = 0;
    if (typeof cancelLeadPrompt === 'function') cancelLeadPrompt();
    var done = document.getElementById('zee-lead-done');
    if (done) done.classList.remove('shown');
    var form = document.getElementById('zee-lead-form');
    if (form) form.style.display = 'none';
  }

  function cancelLeadPrompt() {
    if (leadPromptTimer) { clearTimeout(leadPromptTimer); leadPromptTimer = null; }
  }

  // The single "may we ask right now?" gate. Everything that wants to show the
  // form goes through this, so the never-nag rules cannot be bypassed by adding
  // another trigger later.
  function leadPromptAllowed() {
    if (leadCaptured || leadPromptDismissed) return false;       // asked and answered
    if (visitorHasProvidedEmail()) return false;                 // we already have it
    if (genuineUserCount() < LEAD_PROMPT.minMessages) return false;
    var form = document.getElementById('zee-lead-form');
    if (!form) return false;
    if (form.style.display === 'block') return false;            // already up
    return true;
  }

  // True when cutting in would interrupt: an agent is mid-conversation, or the
  // visitor is part-way through typing and a band appearing under the composer
  // would shift what they are looking at.
  function leadPromptWouldInterrupt() {
    if (Date.now() - lastAgentReplyMs < LEAD_PROMPT.activeConvoMs) return true;
    var input = document.getElementById('zee-chat-input');
    if (input && input.value.trim()) return true;
    return false;
  }

  // Arm (or restart) the no-reply prompt. Called after every genuine visitor
  // message: the trigger is "you said something and nobody answered".
  function armLeadPrompt() {
    cancelLeadPrompt();
    leadPromptDefers = 0;
    if (!leadPromptAllowed()) return;
    leadPromptTimer = setTimeout(function fire() {
      leadPromptTimer = null;
      // Re-checked at fire time, not just at arm time — an email may have been
      // typed into the chat, or the lead captured, in the meantime.
      if (!leadPromptAllowed()) return;
      if (leadPromptWouldInterrupt() && leadPromptDefers < LEAD_PROMPT.maxDefers) {
        leadPromptDefers++;
        leadPromptTimer = setTimeout(fire, LEAD_PROMPT.retryMs);
        return;
      }
      showLeadPrompt('idle');
    }, LEAD_PROMPT.idleMs);
  }

  // Show the form. `reason` only picks the wording — an unanswered question and
  // someone on their way out want different sentences.
  function showLeadPrompt(reason) {
    if (!leadPromptAllowed()) return;
    cancelLeadPrompt();
    var form = document.getElementById('zee-lead-form');
    var p = form.querySelector('p');
    if (p) {
      p.textContent = reason === 'exit'
        ? 'Before you go — leave your details and our team will follow up.'
        : reason === 'asked'
          ? 'Happy to help — leave your details and our team will get back to you.'
          : "We'll get back to you shortly! Leave your details so our team can follow up.";
    }
    form.style.display = 'block';
    scrollToBottom();
  }

  // The visitor closed the ask. Never raise it again this session — that is the
  // whole point of a dismiss, and re-asking is what makes a widget hated.
  function dismissLeadPrompt() {
    cancelLeadPrompt();
    leadPromptDismissed = true;
    lsSet(LEAD_X_KEY, sessionId);
    var form = document.getElementById('zee-lead-form');
    if (form) form.style.display = 'none';
  }

  // ── Exit intent ─────────────────────────────────────────────────────────────
  // Last chance for the ~13% who leave before idleMs elapses. Desktop: the
  // pointer leaving through the top of the viewport. Mobile (42% of these
  // conversations, and no pointer to track): the tab being hidden or unloaded.
  function bindExitIntent() {
    if (!LEAD_PROMPT.exitIntent) return;
    document.addEventListener('mouseout', function (e) {
      if (e.relatedTarget || e.toElement) return;   // moved to another element, not out
      if ((e.clientY || 0) > 24) return;            // only out through the TOP
      showLeadPrompt('exit');
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') showLeadPrompt('exit');
    });
    // pagehide fires on mobile Safari where visibilitychange can be missed.
    window.addEventListener('pagehide', function () { showLeadPrompt('exit'); });
  }

  function maybeShowLeadForm() {
    // Explicit intent ("email me", "call me", or a typed address) is the one case
    // that shows immediately — the visitor just asked for this.
    if (userWantsToLeaveDetails()) { showLeadPrompt('asked'); return; }
    armLeadPrompt();
  }

  // ─── Polling ──────────────────────────────────────────────────────────────
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      fetch(baseUrl + '/api/chat/poll?sessionId=' + encodeURIComponent(sessionId) +
        '&siteId=' + encodeURIComponent(siteId) +
        '&since=' + encodeURIComponent(pollSince))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          var newMsgs = data.messages || [];
          for (var i = 0; i < newMsgs.length; i++) {
            appendMessage('bot', newMsgs[i].message);
            messages.push({ role: 'assistant', content: newMsgs[i].message });
            botMessageCount++;
            pollSince = newMsgs[i].created_at;
          }
          if (newMsgs.length > 0) {
            // A human agent replied, so the conversation is being handled: drop
            // the pending prompt entirely rather than re-arming it. Asking for
            // details 30s after an agent answers would be interrupting a live
            // conversation, and an agent who needs the details can ask. Exit
            // intent still covers this visitor if they leave.
            lastAgentReplyMs = Date.now();
            cancelLeadPrompt();
            playNotificationSound();
            // On another tab? Flash the title so the reply isn't missed.
            if (typeof document !== 'undefined' && document.hidden) flashTitle(newMsgs.length);
            // The reply arrived — drop the typing dots so they don't sit above it.
            if (agentTypingShown) { hideTyping(); agentTypingShown = false; }
          }
          // Agent-typing indicator: show/hide the dots based on the server flag.
          if (data.agentTyping && !agentTypingShown && !document.getElementById('zee-typing-indicator')) {
            showTyping();
            agentTypingShown = true;
          } else if (!data.agentTyping && agentTypingShown) {
            hideTyping();
            agentTypingShown = false;
          }
        })
        .catch(function () {});
    }, 4000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ─── Notification sound ───────────────────────────────────────────────────
  // One shared, long-lived AudioContext (never closed) so every sound reuses the
  // same context the visitor unlocked on their first interaction.
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      audioCtx = new AudioCtx();
    } catch (e) { return null; }
    return audioCtx;
  }

  // Play a pleasant rising two-tone chime at the given volume (0..1). Each note
  // layers a sine + a brighter triangle an octave up, driven through a soft
  // limiter so it's clearly audible without harsh clipping.
  function playChime(volume) {
    if (isMuted()) return; // single gate — covers landing, greeting and replies
    var ctx = getAudioCtx();
    if (!ctx) return;
    // Resume FIRST, then schedule. A suspended context has a frozen currentTime,
    // so scheduling before the resume completes silently drops the sound (the
    // note's start time ends up in the past). Waiting for resume fixes the
    // "no bell on the agent's reply" case.
    if (ctx.state === 'suspended' && ctx.resume) {
      try { ctx.resume().then(function () { playChimeNow(ctx, volume); }).catch(function () {}); } catch (e) {}
      return;
    }
    playChimeNow(ctx, volume);
  }

  function playChimeNow(ctx, volume) {
    try {
      var master = ctx.createGain();
      master.gain.value = 0.9;
      var shaper = ctx.createWaveShaper();
      var curve = new Float32Array(1024);
      for (var c = 0; c < 1024; c++) {
        var x = (c / 1023) * 2 - 1;
        curve[c] = Math.tanh(x * 1.1); // gentle saturation = warm, not harsh
      }
      shaper.curve = curve;
      master.connect(shaper);
      shaper.connect(ctx.destination);

      // Warm, pleasant rising bell: C6 (1047Hz) then E6 (1319Hz), sine body with
      // a soft triangle overtone — audible but easy on the ear.
      [[1047, 0], [1319, 0.14]].forEach(function (pair) {
        var freq = pair[0], delay = pair[1];
        var t = ctx.currentTime + delay;
        [['sine', freq, 0.95], ['triangle', freq * 2, 0.18]].forEach(function (layer) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(master);
          osc.type = layer[0];
          osc.frequency.value = layer[1];
          var peak = layer[2] * volume;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(peak, t + 0.02); // smooth attack
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
          osc.start(t);
          osc.stop(t + 0.65);
        });
      });
    } catch (e) {}
  }

  // Incoming-message sound: full volume. Plays on EVERY incoming message (bot or
  // human agent), never on the visitor's own outgoing messages.
  function playNotificationSound() {
    playChime(1.0);
  }

  // ─── Backgrounded-tab notice ──────────────────────────────────────────────
  // If the reply lands while the visitor is looking at another tab, sound alone
  // is easy to miss (and may be throttled). Flash the browser tab title so they
  // see a message is waiting; restore it the moment they come back.
  var originalTitle = null;
  var titleFlashTimer = null;
  var unreadAgentMsgs = 0;
  function flashTitle(count) {
    if (typeof document === 'undefined') return;
    if (originalTitle === null) originalTitle = document.title;
    unreadAgentMsgs += (count || 1);
    if (titleFlashTimer) return; // already flashing
    var on = true;
    titleFlashTimer = setInterval(function () {
      document.title = on ? ('💬 New message' + (unreadAgentMsgs > 1 ? ' (' + unreadAgentMsgs + ')' : '')) : (originalTitle || '');
      on = !on;
    }, 1000);
  }
  function clearTitleFlash() {
    if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
    if (originalTitle !== null) { document.title = originalTitle; }
    unreadAgentMsgs = 0;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') clearTitleFlash();
    });
  }

  // "Chat is available" ding on landing — softer/pleasant, and only once. If
  // audio is still blocked (no interaction yet) it does nothing; the interaction
  // unlock below will fire it on the visitor's first click/scroll/move instead.
  function playLandingSound() {
    if (landingDingDone() || wasDismissed()) return;
    var ctx = getAudioCtx();
    if (!ctx) { markLandingDing(); return; }
    var resume = (ctx.state === 'suspended' && ctx.resume) ? ctx.resume() : null;
    var go = function () {
      if (landingDingDone() || wasDismissed()) return;
      if (ctx.state !== 'running') return; // still blocked — wait for interaction
      markLandingDing();
      playChime(0.55);
    };
    if (resume && typeof resume.then === 'function') { resume.then(go).catch(function () {}); }
    else { go(); }
  }

  // Resume audio on the visitor's first interaction (required by autoplay
  // policies) and, if the landing ding hasn't sounded yet, play it then. Bound
  // once; the listeners remove themselves after the first gesture.
  function bindInteractionUnlock() {
    if (interactionUnlockBound) return;
    interactionUnlockBound = true;
    var events = ['pointerdown', 'click', 'keydown', 'scroll', 'mousemove', 'touchstart'];
    function onFirst() {
      var ctx = getAudioCtx();
      if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
      playLandingSound();
      events.forEach(function (ev) { window.removeEventListener(ev, onFirst, true); });
    }
    events.forEach(function (ev) { window.addEventListener(ev, onFirst, true); });
  }

  // ─── Greeting ─────────────────────────────────────────────────────────────
  // Derive the product the visitor is browsing from the page <title>, so the
  // opener can be "Are you looking for X?" instead of a generic hello. Takes the
  // part before the first separator (site name usually follows a | or -) and
  // rejects anything too short/long to be a product name.
  function pageProduct() {
    try {
      var t = (document.title || '').trim();
      if (!t) return '';
      // The site name usually follows a separator — keep the part before it.
      t = t.split(/\s[|\-–—:»]\s|·|\|/)[0].trim();
      // Drop a leading sales verb so "Buy Custom Boxes" → "Custom Boxes".
      t = t.replace(/^(buy|shop|order|get|browse)\s+/i, '').trim();
      if (t.length >= 3 && t.length <= 60) return t;
    } catch (e) {}
    return '';
  }

  function sendBotGreeting() {
    console.log('sendBotGreeting called, greetingSent=' + greetingSent);
    if (greetingSent) return;
    // Product-aware opener when we can tell what they're viewing — shown to the
    // customer the moment the chat opens. Falls back to a plain hello (no bot
    // persona; a human team replies here).
    var product = pageProduct();
    var greeting = product
      ? 'Hi! Are you looking for ' + product + '?'
      : (config.bot_enabled === false
        ? 'Hi! How can we help you today?'
        : 'Hi! I\'m ' + config.bot_name + '. How can I help you today?');
    messages.push({ role: 'user', content: '(session started)' });
    appendMessage('bot', greeting);
    console.log('greeting appended to DOM');
    var msgsEl = document.getElementById('zee-chat-messages');
    console.log('messages div children count: ' + (msgsEl ? msgsEl.children.length : 'DIV NOT FOUND'));
    messages.push({ role: 'assistant', content: greeting });
    botMessageCount++;
    greetingSent = true;
    console.log('greeting sent');
    // No sound here. The greeting is a canned line that appears the instant the
    // panel opens — the visitor is already looking straight at it, so a chime
    // adds nothing and, on an auto-open, fires without them asking for anything.
    // The once-per-session landing ding is the only "we're here" cue.
    markLandingDing();
  }

  // ─── Send ──────────────────────────────────────────────────────────────────
  function handleSend() {
    var input = document.getElementById('zee-chat-input');
    var text = input.value.trim();
    if (!text) return;

    markActivity(); // sending is genuine activity (rotates a stale session first)
    input.value = '';
    input.style.height = 'auto';
    appendMessage('user', text);
    messages.push({ role: 'user', content: text });

    // THE primary trigger. Armed on every visitor message, regardless of whether
    // the bot is enabled, whether an agent is around, or how many messages have
    // been sent — the old gate needed a reply to arrive first AND three messages,
    // which no-one hit once the bot was switched off. A reply cancels it, so an
    // answered question never produces a prompt.
    maybeShowLeadForm();

    showTyping(); // immediate — before fetch starts

    var chatUrl = baseUrl + '/api/chat';
    var requestBody = { siteId: siteId, messages: messages, sessionId: sessionId };
    console.log('Sending to:', chatUrl);
    console.log('Request body:', JSON.stringify(requestBody));

    try {
      fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
        .then(function (r) {
          console.log('Chat API response status:', r.status, 'ok:', r.ok);
          // Scheduled bot-off / human takeover: the server stays silent and sets
          // this header. Render NOTHING — no bubble, no ack, no sound. The visitor
          // just sees their own message; a human agent will reply from the dashboard.
          if (r.headers.get('X-Bot-Silent') === '1') {
            hideTyping();
            // The prompt is already armed by handleSend for every visitor
            // message, so nothing extra is needed here: a silent bot simply
            // means no reply arrives to cancel it.
            // Global bot-off only: the server sends a ONE-TIME static ack with
            // the visitor's first message so they know a human will follow up.
            // It's rendered here only — never stored server-side.
            if (r.headers.get('X-Bot-Ack') === '1') {
              r.text().then(function (ack) {
                if (!ack) return;
                appendMessage('bot', ack);
                messages.push({ role: 'assistant', content: ack });
                playNotificationSound();
              }).catch(function () {});
            }
            return;
          }
          if (!r.ok || !r.body) {
            hideTyping();
            appendMessage('bot', 'Sorry, I couldn\'t get a response. Please try again.');
            return;
          }

          hideTyping();

          // Create bot message bubble for live streaming
          var msgsEl = document.getElementById('zee-chat-messages');
          var msgDiv = document.createElement('div');
          msgDiv.className = 'zee-msg bot';
          msgsEl.appendChild(msgDiv);
          scrollToBottom();

          var reader = r.body.getReader();
          var decoder = new TextDecoder();
          var fullText = '';

          function pump() {
            reader.read().then(function (result) {
              if (result.done) {
                // Stream complete: apply full markdown rendering
                msgDiv.innerHTML = renderText('bot', fullText);
                scrollToBottom();
                messages.push({ role: 'assistant', content: fullText });
                botMessageCount++;
                maybeShowLeadForm();
                playNotificationSound();
                return;
              }
              var chunk = decoder.decode(result.value, { stream: true });
              fullText += chunk;
              // Raw escaped text + blinking cursor while streaming
              msgDiv.innerHTML = escapeHtml(fullText) + '<span class="zee-stream-cursor"></span>';
              scrollToBottom();
              pump();
            }).catch(function (err) {
              console.log('Stream read error:', err);
              msgDiv.innerHTML = renderText('bot', fullText || 'Oops! Something went wrong.');
              scrollToBottom();
            });
          }

          pump();
        })
        .catch(function (err) {
          console.log('Fetch error:', err, 'URL was:', chatUrl);
          hideTyping();
          appendMessage('bot', 'Oops! Something went wrong. Please try again.');
        });
    } catch (err) {
      console.log('Fetch threw synchronously:', err);
      hideTyping();
      appendMessage('bot', 'Oops! Something went wrong. Please try again.');
    }
  }

  // ─── File upload ────────────────────────────────────────────────────────────
  var ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'];
  var MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

  function showUploadError(msg) {
    var el = document.getElementById('zee-chat-messages');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'zee-upload-err';
    div.textContent = msg;
    el.appendChild(div);
    scrollToBottom();
    setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 5000);
  }

  function handleFileUpload(file) {
    if (!file) return;
    if (ALLOWED_UPLOAD_TYPES.indexOf(file.type) === -1) {
      showUploadError('That file type isn\'t supported. Please send an image (JPG, PNG, GIF, WEBP, SVG) or PDF.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showUploadError('That file is too large. Please keep it under 10MB.');
      return;
    }

    var attachBtn = document.getElementById('zee-chat-attach');
    if (attachBtn) attachBtn.classList.add('uploading');

    var fd = new FormData();
    fd.append('file', file);
    fd.append('siteId', siteId);
    fd.append('sessionId', sessionId);

    fetch(baseUrl + '/api/upload', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (attachBtn) attachBtn.classList.remove('uploading');
        if (!res.ok || !res.data || !res.data.file) {
          showUploadError((res.data && res.data.error) || 'Upload failed. Please try again.');
          return;
        }
        // Show the visitor their own attachment, and keep it in the message
        // history so the bot has context that a file was shared.
        var fileMsg = JSON.stringify({ __file: res.data.file });
        appendMessage('user', fileMsg);
        messages.push({ role: 'user', content: '[Sent a file: ' + (res.data.file.name || 'attachment') + ']' });
        maybeShowLeadForm();
      })
      .catch(function () {
        if (attachBtn) attachBtn.classList.remove('uploading');
        showUploadError('Upload failed. Please check your connection and try again.');
      });
  }

  // ─── Lead ──────────────────────────────────────────────────────────────────
  function showLeadError(msg) {
    var box = document.getElementById('zee-lead-error');
    if (!box) return;
    box.textContent = msg;
    box.hidden = false;
    scrollToBottom();
  }

  function clearLeadError() {
    var box = document.getElementById('zee-lead-error');
    if (box) { box.hidden = true; box.textContent = ''; }
    ['zee-lead-name', 'zee-lead-email'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('zee-invalid');
    });
  }

  function markInvalid(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.add('zee-invalid'); el.focus(); }
  }

  // Render the confirmation band and hide the form. `name`/`email` are optional:
  // on a restore after reload we only know that a lead was captured, not who by,
  // so the copy degrades to the impersonal version rather than inventing detail.
  //
  // Deliberately promises no timeframe. There is no per-site business-hours or
  // response-time data in the widget config (bot_name, primary_color,
  // bot_enabled) and lib/botschedule.ts describes when the BOT is on, which is
  // the inverse of when humans are around — so any "we reply within X" here
  // would be invented.
  function showLeadConfirmation(name, email) {
    var form = document.getElementById('zee-lead-form');
    var done = document.getElementById('zee-lead-done');
    if (form) form.style.display = 'none';
    if (!done) return;
    if (lsGet(LEAD_ACK_KEY) === sessionId) return; // visitor dismissed it earlier
    var title = document.getElementById('zee-done-title');
    var sub = document.getElementById('zee-done-sub');
    if (title) title.textContent = name ? 'Thanks, ' + name + ' — we’ve got your details.' : 'Thanks — we’ve got your details.';
    if (sub) {
      // textContent throughout, never innerHTML: name and email are visitor
      // input and this runs on customer sites.
      sub.textContent = '';
      if (email) {
        sub.appendChild(document.createTextNode('Our team will reply here in the chat, and can reach you at '));
        var strong = document.createElement('span');
        strong.className = 'zee-done-mail';
        strong.textContent = email;
        sub.appendChild(strong);
        sub.appendChild(document.createTextNode('. You can keep typing below.'));
      } else {
        sub.textContent = 'Our team will reply here in the chat. You can keep typing below.';
      }
    }
    done.classList.add('shown');
    scrollToBottom();
  }

  function dismissLeadConfirmation() {
    var done = document.getElementById('zee-lead-done');
    if (done) done.classList.remove('shown');
    lsSet(LEAD_ACK_KEY, sessionId);
  }

  function handleLeadSubmit() {
    var nameEl = document.getElementById('zee-lead-name');
    var emailEl = document.getElementById('zee-lead-email');
    var phoneEl = document.getElementById('zee-lead-phone');
    var btn = document.getElementById('zee-lead-submit');
    if (!nameEl || !emailEl || !btn) return;
    if (btn.disabled) return; // already in flight — never create a second lead

    var name = (nameEl.value || '').trim();
    var email = (emailEl.value || '').trim();
    var phone = ((phoneEl && phoneEl.value) || '').trim();

    clearLeadError();
    if (!name) { showLeadError('Please enter your name.'); markInvalid('zee-lead-name'); return; }
    if (!email) { showLeadError('Please enter your email address.'); markInvalid('zee-lead-email'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showLeadError('That email address does not look right. Please check it.');
      markInvalid('zee-lead-email');
      return;
    }

    var originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    var restore = function () { btn.disabled = false; btn.textContent = originalLabel; };

    fetch(baseUrl + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteId, sessionId: sessionId, name: name, email: email, phone: phone, message: messages.map(function(m){return m.role+': '+m.content;}).join('\n') }),
    })
      // The confirmation is gated on the response ACTUALLY succeeding. This
      // used to be `.then(function () { ...show thanks... })`, which ignored the
      // status entirely: a 400 or a 500 still told the visitor their details were
      // saved and set leadCaptured, so the form never came back and the lead was
      // lost silently. Nothing here may run before r.ok is confirmed.
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, data: d || {} }; });
      })
      .then(function (res) {
        if (!res.ok || !res.data.success) {
          restore();
          showLeadError(res.data.error === 'siteId required'
            ? 'Something went wrong on our side. Please try again.'
            : 'We could not save your details. Please try again.');
          return; // values stay in the inputs so nothing is retyped
        }
        leadCaptured = true;
        lsSet(LEAD_KEY, sessionId);
        cancelLeadPrompt();
        showLeadConfirmation(name, email);
        // Context for the bot only — not shown to the visitor, who now has the
        // confirmation band instead of a bot message claiming to have saved it
        // (which read oddly during human-only hours, when the bot is silent).
        messages.push({ role: 'assistant', content: 'Lead captured for ' + name });
      })
      .catch(function () {
        restore();
        showLeadError('We could not reach our server. Please check your connection and try again.');
      });
  }

  // ─── Visitor ping ─────────────────────────────────────────────────────────
  function sendPing(status) {
    if (!status || status === 'active') {
      // Don't keep a forgotten/idle tab "live": only ping while the visitor has
      // been genuinely active within the gap. Pings themselves never extend the
      // session — so an idle tab stops pinging and ages out of the live list.
      if (idleMs() > SESSION_GAP_MS) return;
      ensureFreshSession(); // rotates if the session outlived its max age
    }
    var body = { sessionId: sessionId, siteId: siteId, status: status || 'active', visitorId: visitorId };
    if (!status || status === 'active') {
      body.pageUrl = window.location.href;
      body.pageTitle = document.title || '';
      body.referrer = firstReferrer || '';
      body.visits = visitCount;
      body.userAgent = navigator.userAgent;
      body.screenWidth = window.screen.width;
    }
    fetch(baseUrl + '/api/visitor/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(function () {});
  }

  // ─── Preview mode ───────────────────────────────────────────────────────────
  // The geo-block hides the widget from South Asian visitors, which means the
  // site owners — who are in that region — cannot see their own widget to check
  // it works. Loading any page with ?zeechat=preview once sticks a flag in
  // localStorage that asks the server to skip the geo-check for this browser,
  // so they can click through the whole site normally. ?zeechat=off clears it.
  // Deliberately not a secret: it only reveals a chat bubble.
  var PREVIEW_KEY = 'zee-preview';
  function previewMode() {
    try {
      var q = String(window.location.search || '');
      if (q.indexOf('zeechat=preview') !== -1) lsSet(PREVIEW_KEY, '1');
      else if (q.indexOf('zeechat=off') !== -1) localStorage.removeItem(PREVIEW_KEY);
      return lsGet(PREVIEW_KEY) === '1';
    } catch (e) { return false; }
  }

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    fetch(baseUrl + '/api/site-config?siteId=' + encodeURIComponent(siteId)
      + (previewMode() ? '&preview=1' : ''))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        // Geo-gate: on packaging sites the server flags visitors from blocked
        // countries. When blocked, render nothing at all — no bubble, no popup,
        // no ping. The check happens here, before any UI is built, so a blocked
        // visitor never sees the widget flash. (Server defaults blocked=false on
        // any geo uncertainty, so we only ever hide on a definite match.)
        if (data && data.blocked) {
          return;
        }
        if (data && data.bot_name) {
          config = data;
        }
        // Per-site overrides for when the contact form is offered. Merged, not
        // replaced, so a key the server does not send keeps its default and the
        // never-nag rules in leadPromptAllowed() are untouched either way.
        if (data && data.widget && data.widget.leadPrompt) {
          for (var k in data.widget.leadPrompt) {
            if (Object.prototype.hasOwnProperty.call(LEAD_PROMPT, k)) {
              LEAD_PROMPT[k] = data.widget.leadPrompt[k];
            }
          }
        }
        injectCSS(config.primary_color, data && data.widget);
        buildWidget();
        startSounds();
        startPresence();
      })
      .catch(function () {
        injectCSS(config.primary_color);
        buildWidget();
        startSounds();
        startPresence();
      });
  }

  // Begin presence tracking: an immediate ping, the 30s heartbeat (which pauses
  // itself when idle), activity tracking, and a "left" ping on unload.
  function startPresence() {
    sendPing('active');
    setInterval(function () { sendPing('active'); }, 30000);
    bindActivityTracking();
    window.addEventListener('beforeunload', function () { sendPing('left'); });
  }

  // Announce the chat shortly after it loads: arm the first-interaction unlock,
  // then attempt the landing ding (plays now if audio is already allowed, else
  // on the visitor's first interaction — exactly once per page load).
  function startSounds() {
    bindInteractionUnlock();
    setTimeout(function () { playLandingSound(); }, 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
