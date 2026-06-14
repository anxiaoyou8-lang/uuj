self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const scopeUrl = self.registration.scope || self.location.origin + '/';
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

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: new URL('icon-192.png', scopeUrl).href,
      badge: new URL('favicon-32.png', scopeUrl).href,
      data: { activityId },
      tag: activityId || 'xsj-active-message',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const activityId = event.notification.data?.activityId || '';
  const scopeUrl = self.registration.scope || self.location.origin + '/';
  const url = activityId
    ? `${scopeUrl}?activity_id=${encodeURIComponent(activityId)}`
    : scopeUrl;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) {
          await client.navigate(url);
        }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
