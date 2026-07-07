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
  var leadCaptured = false;
  var greetingSent = false;
  var config = { bot_name: 'Assistant', primary_color: '#2563eb', site_id: siteId, name: '' };

  // ─── Safety-net lead capture ────────────────────────────────────────────────
  // When the bot WON'T reply (scheduled off-hours OR manual human takeover) and a
  // human agent is slow to respond, a visitor can give up and leave — a lost lead.
  // To catch that, whenever the server tells us the bot stayed silent on a visitor
  // message (the X-Bot-Silent header), we arm a timer. If no agent reply arrives
  // within SAFETY_NET_DELAY_MS, we proactively show the lead form so the visitor
  // can leave their details. An agent reply (picked up by polling) cancels it, and
  // we never nag a visitor who already left an email.
  var SAFETY_NET_DELAY_MS = 2 * 60 * 1000; // 2 minutes — easy to edit
  var safetyNetTimer = null;

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

  // ─── Audio state ────────────────────────────────────────────────────────────
  // One shared AudioContext, reused for every sound and resumed on the visitor's
  // first interaction (browsers block audio until then). landingSoundPlayed makes
  // the "chat is available" ding fire at most once per page load.
  var audioCtx = null;
  var landingSoundPlayed = false;
  var interactionUnlockBound = false;

  // ─── CSS ──────────────────────────────────────────────────────────────────
  function injectCSS(primaryColor) {
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
#zee-chat-close { background: none; border: none; cursor: pointer; color: white; padding: 4px; border-radius: 6px; display: flex; align-items: center; justify-content: center; opacity: 0.8; transition: opacity 0.2s; }\
#zee-chat-close:hover { opacity: 1; }\
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
#zee-lead-form { padding: 14px 16px; background: #f0f9ff; border-top: 1px solid #bae6fd; flex-shrink: 0; }\
#zee-lead-form p { font-size: 13px; color: #0369a1; font-weight: 500; margin-bottom: 10px; }\
.zee-lead-input { width: 100%; border: 1.5px solid #e5e7eb; border-radius: 8px; padding: 8px 10px; font-size: 13px; margin-bottom: 8px; outline: none; transition: border-color 0.2s; }\
.zee-lead-input:focus { border-color: ' + primaryColor + '; }\
#zee-lead-submit { width: 100%; background: ' + primaryColor + '; color: white; border: none; border-radius: 8px; padding: 9px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }\
#zee-lead-submit:hover { opacity: 0.88; }\
@media (max-width: 767px) { #zee-chat-widget { bottom: 0; right: 0; width: 100%; height: 100%; border-radius: 0; } #zee-chat-widget-btn { bottom: 16px; right: 16px; } }';

    var style = document.createElement('style');
    style.id = 'zee-chat-widget-css';
    style.textContent = css;
    document.head.appendChild(style);
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
    <div id="zee-chat-avatar" style="color:' + escapeHtml(config.primary_color) + '">' + escapeHtml((config.bot_name || 'A')[0].toUpperCase()) + '</div>\
    <div><div id="zee-chat-title">' + escapeHtml(config.bot_name) + '</div><div id="zee-chat-subtitle">Online · Ready to help</div></div>\
  </div>\
  <button id="zee-chat-close" aria-label="Close chat"><svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>\
</div>\
<div id="zee-chat-messages"></div>\
<div id="zee-lead-form" style="display:none">\
  <p>Leave your details and we\'ll follow up with you!</p>\
  <input class="zee-lead-input" id="zee-lead-name" placeholder="Your Name *" type="text" />\
  <input class="zee-lead-input" id="zee-lead-email" placeholder="Email Address *" type="email" />\
  <input class="zee-lead-input" id="zee-lead-phone" placeholder="Phone (optional)" type="tel" />\
  <button id="zee-lead-submit">Submit & Continue Chat</button>\
</div>\
<div id="zee-chat-input-area">\
  <input id="zee-chat-file" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml,application/pdf" style="display:none" />\
  <button id="zee-chat-attach" aria-label="Attach a file" title="Attach a file"><svg viewBox="0 0 24 24"><path d="M16.5 6v11.5a4 4 0 01-8 0V5a2.5 2.5 0 015 0v10.5a1 1 0 01-2 0V6H10v9.5a2.5 2.5 0 005 0V5a4 4 0 00-8 0v12.5a5.5 5.5 0 0011 0V6h-1.5z"/></svg></button>\
  <textarea id="zee-chat-input" placeholder="Type your message..." rows="1"></textarea>\
  <button id="zee-chat-send" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>\
</div>';

    document.body.appendChild(btn);
    document.body.appendChild(widget);

    btn.addEventListener('click', function () {
      widget.classList.toggle('open');
      if (widget.classList.contains('open')) {
        sendBotGreeting();
        startPolling();
      } else {
        stopPolling();
      }
      btn.innerHTML = widget.classList.contains('open')
        ? '<svg viewBox="0 0 24 24" fill="white" width="26" height="26"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    });

    document.getElementById('zee-chat-close').addEventListener('click', function () {
      console.log('widget closed by user click');
      widget.classList.remove('open');
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

    // Auto-open after 5 seconds if visitor hasn't opened manually
    setTimeout(function () {
      console.log('widget auto-open timer fired, already open=' + widget.classList.contains('open'));
      if (!widget.classList.contains('open')) {
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
        out.push('<ol style="margin:6px 0 6px 18px;padding:0">' + listBuf.join('') + '</ol>');
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

  function showLeadForm() {
    var form = document.getElementById('zee-lead-form');
    if (form) form.style.display = 'block';
  }

  // Number of genuine user messages (excludes the '(session started)' sentinel).
  function genuineUserCount() {
    var n = 0;
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user' && messages[i].content !== '(session started)') n++;
    }
    return n;
  }

  // The bot keeps chatting normally; the lead form is shown inline as an
  // additional option. It appears once the user has sent a few genuine messages
  // (or explicitly asks to leave details). Showing it never interrupts the
  // conversation — the visitor can fill it in OR keep chatting, both work.
  var LEAD_FORM_MIN_USER_MSGS = 3;

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

  // ─── Safety-net timer ───────────────────────────────────────────────────────
  function clearSafetyNetTimer() {
    if (safetyNetTimer) { clearTimeout(safetyNetTimer); safetyNetTimer = null; }
  }

  // Arm (or restart) the no-reply timer after a visitor message the bot left
  // unanswered. Skips entirely if we already have the visitor's email.
  function armSafetyNetTimer() {
    clearSafetyNetTimer();
    if (leadCaptured || visitorHasProvidedEmail()) return;
    safetyNetTimer = setTimeout(function () {
      safetyNetTimer = null;
      // Re-check at fire time: an email may have arrived in the meantime.
      if (leadCaptured || visitorHasProvidedEmail()) return;
      showSafetyNetForm();
    }, SAFETY_NET_DELAY_MS);
  }

  // Show the lead form with a friendly "we'll follow up" message. Reuses the same
  // styled form as the inline capture so the look stays consistent.
  function showSafetyNetForm() {
    var form = document.getElementById('zee-lead-form');
    if (!form) return;
    var p = form.querySelector('p');
    if (p) p.textContent = "We'll get back to you shortly! Leave your details so our team can follow up.";
    form.style.display = 'block';
    scrollToBottom();
  }

  function maybeShowLeadForm() {
    if (leadCaptured) return;
    // Explicit intent shows it immediately; otherwise show it once the visitor
    // has sent at least LEAD_FORM_MIN_USER_MSGS genuine messages. Either way the
    // bot keeps chatting — the form is shown inline alongside the conversation.
    if (userWantsToLeaveDetails()) { showLeadForm(); return; }
    if (genuineUserCount() >= LEAD_FORM_MIN_USER_MSGS) showLeadForm();
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
            // A human agent replied — the conversation is being handled, so cancel
            // any pending safety-net prompt.
            clearSafetyNetTimer();
            playNotificationSound();
            maybeShowLeadForm();
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
    var ctx = getAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();

      var master = ctx.createGain();
      master.gain.value = 1.0;
      var shaper = ctx.createWaveShaper();
      var curve = new Float32Array(1024);
      for (var c = 0; c < 1024; c++) {
        var x = (c / 1023) * 2 - 1;
        curve[c] = Math.tanh(x * 1.6); // gentle saturation = loud but not crackly
      }
      shaper.curve = curve;
      master.connect(shaper);
      shaper.connect(ctx.destination);

      // Rising two-note chime: G5 (784Hz) then C6 (1047Hz), 130ms apart.
      [[784, 0], [1047, 0.13]].forEach(function (pair) {
        var freq = pair[0], delay = pair[1];
        var t = ctx.currentTime + delay;
        [['sine', freq, 1.0], ['triangle', freq * 2, 0.5]].forEach(function (layer) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(master);
          osc.type = layer[0];
          osc.frequency.value = layer[1];
          var peak = layer[2] * volume;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(peak, t + 0.015); // fast attack
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
          osc.start(t);
          osc.stop(t + 0.6);
        });
      });
    } catch (e) {}
  }

  // Incoming-message sound: full volume. Plays on EVERY incoming message (bot or
  // human agent), never on the visitor's own outgoing messages.
  function playNotificationSound() {
    playChime(1.0);
  }

  // "Chat is available" ding on landing — softer/pleasant, and only once. If
  // audio is still blocked (no interaction yet) it does nothing; the interaction
  // unlock below will fire it on the visitor's first click/scroll/move instead.
  function playLandingSound() {
    if (landingSoundPlayed) return;
    var ctx = getAudioCtx();
    if (!ctx) { landingSoundPlayed = true; return; }
    var resume = (ctx.state === 'suspended' && ctx.resume) ? ctx.resume() : null;
    var go = function () {
      if (landingSoundPlayed) return;
      if (ctx.state !== 'running') return; // still blocked — wait for interaction
      landingSoundPlayed = true;
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
  function sendBotGreeting() {
    console.log('sendBotGreeting called, greetingSent=' + greetingSent);
    if (greetingSent) return;
    // With the bot globally disabled (config.bot_enabled === false from
    // site-config), don't greet as a bot persona — a human team is replying.
    var greeting = config.bot_enabled === false
      ? 'Hi! How can we help you today?'
      : 'Hi! I\'m ' + config.bot_name + '. How can I help you today?';
    messages.push({ role: 'user', content: '(session started)' });
    appendMessage('bot', greeting);
    console.log('greeting appended to DOM');
    var msgsEl = document.getElementById('zee-chat-messages');
    console.log('messages div children count: ' + (msgsEl ? msgsEl.children.length : 'DIV NOT FOUND'));
    messages.push({ role: 'assistant', content: greeting });
    botMessageCount++;
    greetingSent = true;
    console.log('greeting sent');
    // The greeting chime doubles as the "chat is available" cue, so don't also
    // fire the separate landing ding afterward.
    landingSoundPlayed = true;
    playNotificationSound();
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
            // Bot won't reply (globally disabled, off-hours or human takeover).
            // If no human agent answers within the threshold, the safety-net form
            // will offer the visitor a way to leave their details so the lead
            // isn't lost.
            armSafetyNetTimer();
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
  function handleLeadSubmit() {
    var name = (document.getElementById('zee-lead-name').value || '').trim();
    var email = (document.getElementById('zee-lead-email').value || '').trim();
    var phone = (document.getElementById('zee-lead-phone').value || '').trim();

    if (!name || !email) {
      alert('Please enter your name and email.');
      return;
    }

    fetch(baseUrl + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteId, sessionId: sessionId, name: name, email: email, phone: phone, message: messages.map(function(m){return m.role+': '+m.content;}).join('\n') }),
    })
      .then(function () {
        leadCaptured = true;
        clearSafetyNetTimer();
        var form = document.getElementById('zee-lead-form');
        if (form) form.style.display = 'none';
        appendMessage('bot', 'Thanks ' + name + '! We\'ve saved your details and will be in touch. Feel free to keep chatting!');
        messages.push({ role: 'assistant', content: 'Lead captured for ' + name });
      })
      .catch(function () {
        appendMessage('bot', 'There was an issue saving your details. Please try again.');
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
    var body = { sessionId: sessionId, siteId: siteId, status: status || 'active' };
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

  // ─── Init ──────────────────────────────────────────────────────────────────
  function init() {
    fetch(baseUrl + '/api/site-config?siteId=' + encodeURIComponent(siteId))
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
        injectCSS(config.primary_color);
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
