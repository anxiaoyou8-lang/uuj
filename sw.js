const OWNED_CACHE_PREFIX = 'xsj-';

// Per-message receipts survive dismissing a banner, SW restarts and push retries.
async function showMessageNotification(title, options) {
  const id = options.data?.messageId;
  if (!id) { await self.registration.showNotification(title, options); return true; }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('xsj-notification-receipts-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('receipts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const claimed = await new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', 'readwrite'), store = tx.objectStore('receipts');
      let accepted = false;
      const get = store.get(id);
      get.onsuccess = () => {
        if (!get.result || (get.result.state !== 'shown' && get.result.at < Date.now() - 60000)) {
          store.put({ state: 'pending', at: Date.now() }, id); accepted = true;
        }
      };
      tx.oncomplete = () => resolve(accepted); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    if (!claimed) return true;
    await self.registration.showNotification(title, { ...options, tag: 'xsj-message-' + id });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', 'readwrite');
      tx.objectStore('receipts').put({ state: 'shown', at: Date.now() }, id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    return true;
  } finally { db.close(); }
}
self.addEventListener('message', event => {
  if (event.data?.type !== 'xsj-notify-message') return;
  event.waitUntil(showMessageNotification(event.data.title, event.data.options)
    .then(ok => event.ports[0]?.postMessage({ ok })).catch(() => event.ports[0]?.postMessage({ ok: false })));
});

// Keep installation deliberately small and deterministic. The app previously
// cached whole HTML/JS shells here; on iOS Safari an interrupted update could
// leave a page from one release paired with scripts from another and reopen as
// a blank screen. Hashed assets remain cacheable by the browser itself.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(OWNED_CACHE_PREFIX))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('push', (event) => {
  const scopeUrlValue = self.registration.scope || self.location.origin + '/';
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title = typeof payload.role_name === 'string' && payload.role_name
    ? payload.role_name
    : '幽幽机';
  const body = typeof payload.preview === 'string' && payload.preview
    ? payload.preview
    : '有一条新的主动消息';
  const activityId = typeof payload.activity_id === 'string' ? payload.activity_id : '';
  const deliveryToken = typeof payload.delivery_token === 'string' ? payload.delivery_token : '';
  const targetSessionId = typeof payload.target_session_id === 'string' ? payload.target_session_id : '';
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : '';

  event.waitUntil(
    showMessageNotification(title, {
      body,
      icon: new URL('icon-192.png', scopeUrlValue).href,
      badge: new URL('favicon-32.png', scopeUrlValue).href,
      data: { activityId, deliveryToken, targetSessionId, messageId },
      tag: activityId || 'xsj-active-message',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const activityId = event.notification.data?.activityId || '';
  const deliveryToken = event.notification.data?.deliveryToken || '';
  const targetSessionId = event.notification.data?.targetSessionId || '';
  const localSessionId = event.notification.data?.localSessionId || '';
  const scopeUrlValue = self.registration.scope || self.location.origin + '/';
  const params = new URLSearchParams();
  if (activityId) params.set('activity_id', activityId);
  if (deliveryToken) params.set('delivery_token', deliveryToken);
  if (targetSessionId) params.set('target_session_id', targetSessionId);
  if (!activityId && localSessionId) params.set('local_session_id', localSessionId);
  const query = params.toString();
  const url = query ? `${scopeUrlValue}?${query}` : scopeUrlValue;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if (activityId && 'navigate' in client) {
          await client.navigate(url);
        } else if (localSessionId && 'postMessage' in client) {
          client.postMessage({ type: 'xsj-open-session', sessionId: localSessionId });
        }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
