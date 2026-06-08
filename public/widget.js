(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────────────────
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var scriptSrc = script ? script.src : '';
  var urlParams = new URLSearchParams(scriptSrc.split('?')[1] || '');
  var siteId = urlParams.get('siteId') || 'default';

  var baseUrl = scriptSrc ? scriptSrc.split('/widget.js')[0] : '';

  function genUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  var sessionId = genUUID();
  var messages = [];
  var botMessageCount = 0;
  var leadCaptured = false;
  var config = { bot_name: 'Assistant', primary_color: '#2563eb', site_id: siteId, name: '' };

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
#zee-chat-avatar { width: 36px; height: 36px; border-radius: 50%; background: rgba(255,255,255,0.25); display: flex; align-items: center; justify-content: center; font-size: 16px; }\
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
    <div id="zee-chat-avatar">🤖</div>\
    <div><div id="zee-chat-title">' + escapeHtml(config.bot_name) + '</div><div id="zee-chat-subtitle">Online · Ready to help</div></div>\
  </div>\
  <button id="zee-chat-close" aria-label="Close chat"><svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>\
</div>\
<div id="zee-chat-messages"></div>\
<div id="zee-lead-form" style="display:none">\
  <p>✨ Leave your details and we\'ll follow up with you!</p>\
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
      if (widget.classList.contains('open') && messages.length === 0) {
        sendBotGreeting();
      }
      btn.innerHTML = widget.classList.contains('open')
        ? '<svg viewBox="0 0 24 24" fill="white" width="26" height="26"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>';
    });

    document.getElementById('zee-chat-close').addEventListener('click', function () {
      widget.classList.remove('open');
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

    setTimeout(function () {
      if (!widget.classList.contains('open')) {
        widget.classList.add('open');
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="white" width="26" height="26"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        sendBotGreeting();
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
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
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

  // ─── Greeting ─────────────────────────────────────────────────────────────
  function sendBotGreeting() {
    var greeting = 'Hi! I\'m ' + config.bot_name + '. How can I help you today?';
    messages.push({ role: 'user', content: '(session started)' });
    showTyping();
    setTimeout(function () {
      hideTyping();
      appendMessage('bot', greeting);
      messages.push({ role: 'assistant', content: greeting });
      botMessageCount++;
    }, 600);
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

    showTyping();

    fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: siteId, messages: messages, sessionId: sessionId }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        var reply = data.reply || 'Sorry, I couldn\'t get a response. Please try again.';
        appendMessage('bot', reply);
        messages.push({ role: 'assistant', content: reply });
        botMessageCount++;
        if (botMessageCount >= 2 && !leadCaptured) {
          showLeadForm();
        }
      })
      .catch(function () {
        hideTyping();
        appendMessage('bot', 'Oops! Something went wrong. Please try again.');
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
      })
      .catch(function () {
        injectCSS(config.primary_color);
        buildWidget();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
