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
