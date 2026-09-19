const OWNED_CACHE_PREFIX = 'xsj-';

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

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: new URL('icon-192.png', scopeUrlValue).href,
      badge: new URL('favicon-32.png', scopeUrlValue).href,
      data: { activityId, deliveryToken, targetSessionId },
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
