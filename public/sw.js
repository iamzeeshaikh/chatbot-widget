// Minimal service worker — required for the dashboard to be installable as a
// PWA. Network-first passthrough: NO caching of dashboard data (agents must
// always see live conversations), so it simply takes control and lets every
// request hit the network as usual.
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// ── the sound switch, mirrored from the dashboard ───────────────────────────
// A push notification is drawn by THIS worker and plays the OS notification
// sound. That happens outside the page, so neither the dashboard's
// AudioContext nor Chrome's per-tab mute can silence it — a muted tab still
// dinged, which is exactly the bug this exists to fix. The only lever we have
// on our side is the notification's own `silent` flag, so the header's sound
// toggle has to reach the worker.
//
// localStorage is invisible to a worker, so the page posts the value across
// and we persist it here. The Cache API (not the dashboard data the header
// comment rules out — one preference, one key) is what survives the worker
// being killed and respawned between pushes, which is the normal case.
var PREF_CACHE = 'zee-prefs';
var SOUND_KEY = '/__zee_sound';

function readSoundOn() {
  return caches.open(PREF_CACHE)
    .then(function (c) { return c.match(SOUND_KEY); })
    .then(function (res) { return res ? res.text() : null; })
    // Unset means the agent has never touched the switch — sound on, as the
    // dashboard itself defaults. Failing open is right: a missed customer
    // costs more than an unwanted ding.
    .then(function (v) { return v === null ? true : v === 'on'; })
    .catch(function () { return true; });
}

function writeSoundOn(on) {
  return caches.open(PREF_CACHE).then(function (c) {
    return c.put(SOUND_KEY, new Response(on ? 'on' : 'off'));
  }).catch(function () {});
}

self.addEventListener('message', function (event) {
  var d = event.data || {};
  if (d.type === 'zee-sound') event.waitUntil(writeSoundOn(d.on !== false));
});

// Web Push: show the notification even when the app/dashboard is closed.
// The banner still appears when muted — being told is the point, and it is the
// SOUND the toggle governs, not whether the agent finds out.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(readSoundOn().then(function (soundOn) {
    return self.registration.showNotification(data.title || 'ZeeOps', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'zeeops',
      silent: !soundOn,
      // `renotify` is what makes a repeat push on the same tag alert AGAIN
      // rather than quietly updating the existing banner — i.e. a second
      // sound. It only makes sense while sound is on, and Chrome rejects the
      // combination of renotify with silent outright.
      renotify: soundOn,
      data: { url: data.url || '/' },
    });
  }));
});

// Clicking the notification opens (or focuses) the dashboard on the chat.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if ('focus' in c) {
        if ('navigate' in c) c.navigate(url);
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
