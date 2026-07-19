/// <reference lib="webworker" />
import { notificationViewFrom } from './lib/pushNotification.js';

// ─── VIMES service worker (slice-2 step 3, injectManifest) ───────────────────
//
// Owns two things: web-push delivery (the `push` handler shows the notification)
// and the deep-link (`notificationclick` focuses-or-opens the exact session). The
// precache manifest is injected by vite-plugin-pwa at self.__WB_MANIFEST; a small
// manual precache (no workbox runtime dependency) makes the app shell load offline.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

const PRECACHE = 'vimes-precache-v1';
const precacheUrls = self.__WB_MANIFEST.map((entry) => entry.url);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(precacheUrls))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== PRECACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Cache-first for the precached shell; everything else falls through to network.
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});

self.addEventListener('push', (event) => {
  const view = notificationViewFrom(event.data?.text());
  event.waitUntil(
    self.registration.showNotification(view.title, {
      body: view.body,
      tag: view.url ?? 'vimes',
      data: { url: view.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data as { url?: string | null } | undefined)?.url ?? '/';
  event.waitUntil(focusOrOpen(targetUrl));
});

// Focus an existing VIMES window (routing it to the deep link) or open a new one.
async function focusOrOpen(url: string): Promise<void> {
  const absolute = new URL(url, self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    await client.focus();
    if (client.url !== absolute) {
      try {
        await client.navigate(absolute);
      } catch {
        // Some engines disallow navigate(); focusing the existing window is fine.
      }
    }
    return;
  }
  await self.clients.openWindow(absolute);
}
