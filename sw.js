/* Offline app shell. Never touches GitHub API traffic — only same-origin GETs. */
const VERSION = '__BUILD__';
const CACHE = `ledgerly-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './css/tokens.css',
  './css/app.css',
  './js/theme-init.js',
  './js/main.js',
  './js/core/categorize.js',
  './js/core/crypto.js',
  './js/core/csv.js',
  './js/core/dates.js',
  './js/core/demo.js',
  './js/core/finance.js',
  './js/core/ids.js',
  './js/core/insights.js',
  './js/core/merge.js',
  './js/core/money.js',
  './js/core/recurring.js',
  './js/core/redact.js',
  './js/core/schema.js',
  './js/services/github.js',
  './js/services/storage.js',
  './js/services/sync.js',
  './js/services/vault.js',
  './js/state/store.js',
  './js/ui/actions.js',
  './js/ui/autolock.js',
  './js/ui/charts.js',
  './js/ui/components.js',
  './js/ui/dom.js',
  './js/ui/forms.js',
  './js/ui/icons.js',
  './js/ui/lock.js',
  './js/ui/shell.js',
  './js/ui/theme.js',
  './js/ui/views/accounts.js',
  './js/ui/views/analytics.js',
  './js/ui/views/budgets.js',
  './js/ui/views/dashboard.js',
  './js/ui/views/goals.js',
  './js/ui/views/recurring.js',
  './js/ui/views/settings.js',
  './js/ui/views/shared.js',
  './js/ui/views/transactions.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ledgerly-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network-first for the document so deployments show up immediately.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }
  // Cache-first for versioned static assets, refreshed in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
