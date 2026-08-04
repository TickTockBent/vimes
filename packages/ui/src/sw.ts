/// <reference lib="webworker" />
import { decideNavigationResponse } from './lib/navigationFallback.js';
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
  if (event.request.mode === 'navigate') {
    event.respondWith(navigationResponse(event.request));
    return;
  }
  // Cache-first for the precached shell; everything else falls through to network.
  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});

// Navigations are network-first with the precached shell as the fallback: a daemon
// restart behind the tunnel must not replace the open app with the infrastructure's
// 502 page — the shell boots and the store's backoff loop reconnects instead.
//
// 4xx passes through untouched. A 401/403 or a redirect landing from Cloudflare Access
// is the login flow; serving the cached shell over it would brick auth. A 404 is the
// origin speaking, and the origin is entitled to be heard.
//
// Accepted limitation: a hard reload (shift-refresh) bypasses the service worker by
// design, so that path still shows the infrastructure page. Normal reloads and
// in-app navigations get the shell.
async function navigationResponse(request: Request): Promise<Response> {
  let networkResponse: Response | undefined;
  let rejection: unknown;
  try {
    networkResponse = await fetch(request);
  } catch (error) {
    rejection = error;
  }
  const plan = decideNavigationResponse(
    networkResponse === undefined ? { fetchRejected: true } : { fetchRejected: false, status: networkResponse.status },
  );
  if (plan === 'network' && networkResponse !== undefined) {
    return networkResponse;
  }
  // The precache stored the shell under the relative key 'index.html'; resolve it the
  // same way. On a miss (first visit, incomplete precache) the network's answer is the
  // best truth available — never synthesize a response body of our own.
  const cachedShell = await caches.match('index.html');
  if (cachedShell !== undefined) {
    return cachedShell;
  }
  if (networkResponse !== undefined) {
    return networkResponse;
  }
  throw rejection;
}

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
