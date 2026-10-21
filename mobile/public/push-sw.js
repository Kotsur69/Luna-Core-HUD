// LunaCore phone - Web Push in the service worker (REMOTE_HOST_PLAN H4).
// Imported by the generated workbox worker (vite.config.js importScripts).
// The payload is the `push` edge function's generic {title, body, tag, url}:
// shown as text, and a tap opens only a page of this app.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const url = /^\/#[a-z]{1,20}$/.test(data.url) ? data.url : '/';
  event.waitUntil(
    self.registration.showNotification(str(data.title, 60) || 'LunaCore', {
      body: str(data.body, 160),
      tag: str(data.tag, 80) || undefined,
      icon: '/icon-512.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
