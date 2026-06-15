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

  // ONE persistent sessionId per browser, generated once and reused. Uses
  // localStorage so it survives reloads, new tabs and multi-page navigation —
  // this is what stops the same visitor being counted multiple times.
  var SESSION_KEY = 'zee-session-' + siteId;
  var sessionId;
  try {
    sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = genUUID();
      localStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch (e) {
    // Storage blocked (e.g. private mode) — fall back to a single per-load id.
    sessionId = genUUID();
  }

  var messages = [];
  var botMessageCount = 0;
  var leadCaptured = false;
  var greetingSent = false;
  var config = { bot_name: 'Assistant', primary_color: '#2563eb', site_id: siteId, name: '' };

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

  function appendMessage(role, text) {
    var el = document.getElementById('zee-chat-messages');
    if (!el) return;
    var div = document.createElement('div');
    div.className = 'zee-msg ' + role;
    div.innerHTML = renderText(role, text);
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

  // The bot collects contact details conversationally, so the form is only a
  // fallback convenience. Show it when the user EXPLICITLY wants to leave
  // details, or only after a long genuine conversation AND clear buying intent.
  var LEAD_FORM_MIN_USER_MSGS = 6;

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

  // Genuine buying intent anywhere in the conversation.
  function hasBuyingIntent() {
    var t = '';
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') t += ' ' + (messages[i].content || '').toLowerCase();
    }
    return /\b(quote|price|pricing|cost|how much|order|buy|purchase|interested|quantity|bulk|moq|lead time|deliver|delivery|sample|samples|budget|get started|sign me up)\b/.test(t);
  }

  function maybeShowLeadForm() {
    if (leadCaptured) return;
    if (userWantsToLeaveDetails()) { showLeadForm(); return; }
    if (genuineUserCount() >= LEAD_FORM_MIN_USER_MSGS && hasBuyingIntent()) showLeadForm();
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
  // Plays on EVERY incoming message (bot, human agent, or any message the
  // visitor receives). It is never called for the visitor's own outgoing
  // messages. Loud but pleasant rising two-tone chime.
  function playNotificationSound() {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      var ctx = new AudioCtx();
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      // Pleasant rising chime: G5 (784Hz) then C6 (1047Hz), 130ms apart.
      [[784, 0], [1047, 0.13]].forEach(function (pair) {
        var freq = pair[0], delay = pair[1];
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        var t = ctx.currentTime + delay;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.6, t + 0.02);   // louder, more noticeable
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
        osc.start(t);
        osc.stop(t + 0.5);
      });
      setTimeout(function () { ctx.close(); }, 1300);
    } catch (e) {}
  }

  // ─── Greeting ─────────────────────────────────────────────────────────────
  function sendBotGreeting() {
    console.log('sendBotGreeting called, greetingSent=' + greetingSent);
    if (greetingSent) return;
    var greeting = 'Hi! I\'m ' + config.bot_name + '. How can I help you today?';
    messages.push({ role: 'user', content: '(session started)' });
    appendMessage('bot', greeting);
    console.log('greeting appended to DOM');
    var msgsEl = document.getElementById('zee-chat-messages');
    console.log('messages div children count: ' + (msgsEl ? msgsEl.children.length : 'DIV NOT FOUND'));
    messages.push({ role: 'assistant', content: greeting });
    botMessageCount++;
    greetingSent = true;
    console.log('greeting sent');
    playNotificationSound();
  }

  // ─── Send ──────────────────────────────────────────────────────────────────
  function handleSend() {
    var input = document.getElementById('zee-chat-input');
    var text = input.value.trim();
    if (!text) return;

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
      body: JSON.stringify({ siteId: siteId, name: name, email: email, phone: phone, message: messages.map(function(m){return m.role+': '+m.content;}).join('\n') }),
    })
      .then(function () {
        leadCaptured = true;
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
        if (data && data.bot_name) {
          config = data;
        }
        injectCSS(config.primary_color);
        buildWidget();
        sendPing('active');
        setInterval(function () { sendPing('active'); }, 30000);
        window.addEventListener('beforeunload', function () { sendPing('left'); });
      })
      .catch(function () {
        injectCSS(config.primary_color);
        buildWidget();
        sendPing('active');
        setInterval(function () { sendPing('active'); }, 30000);
        window.addEventListener('beforeunload', function () { sendPing('left'); });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
