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

// Web Push: show the notification even when the app/dashboard is closed.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) {}
  event.waitUntil(self.registration.showNotification(data.title || 'ZeeOps', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'zeeops',
    renotify: true,
    data: { url: data.url || '/' },
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
