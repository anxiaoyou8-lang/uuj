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
  const deliveryToken = typeof payload.delivery_token === 'string' ? payload.delivery_token : '';
  const targetSessionId = typeof payload.target_session_id === 'string' ? payload.target_session_id : '';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: new URL('icon-192.png', scopeUrl).href,
      badge: new URL('favicon-32.png', scopeUrl).href,
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
  // 本地通知(纯前端版由页面自己调 showNotification)带的是会话 id,
  // 不走后端投递,所以用独立参数,免得触发向后端拉取。
  const localSessionId = event.notification.data?.localSessionId || '';
  const scopeUrl = self.registration.scope || self.location.origin + '/';
  const params = new URLSearchParams();
  if (activityId) params.set('activity_id', activityId);
  if (deliveryToken) params.set('delivery_token', deliveryToken);
  if (targetSessionId) params.set('target_session_id', targetSessionId);
  if (!activityId && localSessionId) params.set('local_session_id', localSessionId);
  const query = params.toString();
  const url = query ? `${scopeUrl}?${query}` : scopeUrl;

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        // 只有需要传 activity 参数时才 navigate。本地通知若也 navigate,
        // 会把已经开着的应用整页重载,内存里的会话状态全丢 —— 所以改用
        // postMessage 让活着的页面自己切会话。
        if (activityId && 'navigate' in client) {
          await client.navigate(url);
        } else if (localSessionId && 'postMessage' in client) {
          client.postMessage({ type: 'xsj-open-session', sessionId: localSessionId });
        }
        return;
      }
    }
    // 冷启动没有活着的页面可以 postMessage,只能靠 URL 参数带过去。
    await self.clients.openWindow(url);
  })());
});
