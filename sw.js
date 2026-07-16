// WIOS service worker: push + notification click + app badge + fast-open cache.
// Bump CACHE whenever cache behavior changes so old caches are dropped.
const CACHE = 'wios-v2';
// Only heavy third-party libs are safe to cache-first (they are versioned URLs).
// The app HTML is NEVER cache-first, so a redeploy always shows immediately.
const LIBS = [
  'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone@7.26.4/babel.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(LIBS.map((u) => c.add(u)))));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  const isLib =
    url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isIcon = url.origin === self.location.origin && url.pathname.startsWith('/icons/');

  // Cache-first ONLY for versioned libs and icons (they don't change without a URL change).
  if (isLib || isIcon) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res && res.status === 200) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    })());
    return;
  }

  // The app HTML (/, /index.html) is network-first so a redeploy always wins.
  // Fall back to cache only when offline.
  const isHtml =
    url.origin === self.location.origin &&
    (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.html'));
  if (isHtml) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.status === 200) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
        return res;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }
  // Everything else (Supabase API, Netlify functions): straight to network, untouched.
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  const title = data.title || 'WIOS';
  const options = {
    body: data.body || '',
    tag: data.tag || 'wios',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/', coopId: data.coopId || null },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    if (typeof data.badgeCount === 'number' && 'setAppBadge' in self.navigator) {
      try { await self.navigator.setAppBadge(data.badgeCount); } catch (e) {}
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const coopId = data.coopId || null;
  const url = data.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if (coopId) c.postMessage({ type: 'wios-open', coopId });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
