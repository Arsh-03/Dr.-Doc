/* Dr.Doc service worker: offline cache + Web Share Target receiver. */
const CACHE = 'drdoc-v1';
const DB_NAME = 'drdoc';
const DB_VERSION = 1;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch('./precache.json', { cache: 'no-store' });
        const { files } = await res.json();
        await cache.addAll(files.map((f) => new URL(f, self.registration.scope).toString()));
      } catch (e) {
        // Dev server or partial network: runtime caching below still applies.
      }
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bucket')) db.createObjectStore('bucket', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeShared(files) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('bucket', 'readwrite');
    const store = tx.objectStore('bucket');
    const now = Date.now();
    files.forEach((file, i) => {
      store.put({
        id: `${now}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || `shared-${i + 1}`,
        type: file.type || '',
        size: file.size,
        blob: file,
        addedAt: now + i,
        source: 'shared',
      });
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        const form = await event.request.formData();
        const files = form.getAll('files').filter((f) => f instanceof File);
        if (files.length) await storeShared(files);
        return Response.redirect(new URL('./?shared=' + files.length, self.registration.scope).toString(), 303);
      })(),
    );
    return;
  }

  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (event.request.mode === 'navigate') {
        try {
          const fresh = await fetch(event.request);
          cache.put(event.request, fresh.clone());
          return fresh;
        } catch {
          return (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match(new URL('./index.html', self.registration.scope).toString()));
        }
      }
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res.ok) cache.put(event.request, res.clone());
      return res;
    })(),
  );
});
