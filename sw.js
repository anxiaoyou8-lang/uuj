const OWNED_CACHE_PREFIX = 'xsj-';

function validNotificationScope(scope) {
  if (!scope || ![1, 2].includes(scope.schemaVersion) || typeof scope.switching !== 'boolean'
    || ![scope.primaryAccountId, scope.activeAccountId].every(id => id === null || (typeof id === 'string' && id.length > 0 && id.length <= 200))) return false;
  if (scope.schemaVersion === 1) return true;
  if (!Array.isArray(scope.accounts) || scope.accounts.length > 64) return false;
  const ids = new Set();
  for (const account of scope.accounts) {
    if (!account || typeof account.id !== 'string' || !account.id || account.id.length > 200 || ids.has(account.id)
      || typeof account.name !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(account.name)) return false;
    ids.add(account.id);
  }
  return scope.primaryAccountId === null ? scope.accounts.length === 0 && scope.activeAccountId === null
    : ids.has(scope.primaryAccountId) && (scope.activeAccountId === null || ids.has(scope.activeAccountId));
}

// Per-message receipts survive dismissing a banner, SW restarts and push retries.
async function showMessageNotification(title, options) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) return locks.request('xsj-player-notification', () => showMessageNotificationUnderLock(title, options));
  if (options.data?.playerAccountId) return false;
  return showMessageNotificationUnderLock(title, options);
}

async function showMessageNotificationUnderLock(title, options) {
  const id = options.data?.messageId;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('xsj-notification-receipts-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('receipts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (options.data?.playerPushVersion !== undefined) {
      const binding = await new Promise((resolve, reject) => {
        const request = db.transaction('receipts').objectStore('receipts').get('player-push-binding-v1');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (options.data.playerPushVersion !== 1 || binding?.version !== 1 || !binding.binding
        || binding.binding !== options.data.playerPushBinding || !options.data.playerAccountId) return false;
    }
    const scope = await new Promise((resolve, reject) => {
      const request = db.transaction('receipts').objectStore('receipts').get('player-scope');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    // An explicitly scoped notification must never fall back to a legacy
    // unscoped display when the worker has no verified login cache.
    if (options.data?.playerAccountId && (!scope || !id)) return false;
    if (options.data?.expiresAt !== undefined && (!Number.isFinite(options.data.expiresAt) || options.data.expiresAt <= Date.now())) return false;
    const recipient = options.data?.playerAccountId || scope?.primaryAccountId;
    if (scope) {
      if (!validNotificationScope(scope)) return false;
      if (scope.schemaVersion === 1 || options.data?.expiresAt !== undefined) {
        // Old workers/caches remain login-only. Calls are always login-only.
        if (scope.switching || !scope.activeAccountId || scope.activeAccountId !== recipient) return false;
      }
      if (scope.schemaVersion === 2) {
        const account = scope.accounts.find(account => account.id === recipient);
        if (!account) return false;
        title = `to：${account.name} · ${title}`;
        options = { ...options, data: { ...options.data, playerAccountId: recipient } };
      }
    }
    if (!id) { await self.registration.showNotification(title, options); return true; }
    const claimed = await new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', 'readwrite'), store = tx.objectStore('receipts');
      let status = 'busy';
      const get = store.get(id);
      get.onsuccess = () => {
        if (get.result?.state === 'shown') status = 'shown';
        else if (!get.result || get.result.at < Date.now() - 60000) {
          store.put({ state: 'pending', at: Date.now() }, id); status = 'claimed';
        }
      };
      tx.oncomplete = () => resolve(status); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    if (claimed === 'shown') return true;
    if (claimed !== 'claimed') return false;
    const latestScope = await new Promise((resolve, reject) => {
      const request = db.transaction('receipts').objectStore('receipts').get('player-scope');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (JSON.stringify(latestScope) !== JSON.stringify(scope)
      || (options.data?.expiresAt !== undefined && options.data.expiresAt <= Date.now())) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('receipts', 'readwrite'); tx.objectStore('receipts').delete(id);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      return false;
    }
    if (!options.presentedInApp) await self.registration.showNotification(title, { ...options, tag: 'xsj-message-' + id });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', 'readwrite');
      tx.objectStore('receipts').put({ state: 'shown', at: Date.now() }, id);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    return true;
  } finally { db.close(); }
}
self.addEventListener('message', event => {
  if (event.data?.type === 'xsj-player-push-capability') {
    event.ports[0]?.postMessage({ playerPushVersion: 1 }); return;
  }
  if (event.data?.type === 'xsj-notification-seen') {
    // Only the local app can record actual journal presentation. Push payloads
    // never get this control and older workers ignore the new message type.
    if (!event.data.options?.data?.playerAccountId || !event.data.options.data.messageId) return;
    event.waitUntil(showMessageNotification('', { ...event.data.options, presentedInApp: true })
      .then(ok => event.ports[0]?.postMessage({ ok })).catch(() => event.ports[0]?.postMessage({ ok: false })));
    return;
  }
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
      data: { activityId, deliveryToken, targetSessionId, messageId,
        ...(payload.expires_at !== undefined ? { expiresAt: payload.expires_at } : {}),
        ...(typeof payload.player_account_id === 'string' ? { playerAccountId: payload.player_account_id,
          playerPushVersion: payload.player_push_version ?? 0, playerPushBinding: payload.player_push_binding } : {}) },
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
  const playerAccountId = event.notification.data?.playerAccountId || '';
  const scopeUrlValue = self.registration.scope || self.location.origin + '/';
  const params = new URLSearchParams();
  if (activityId) params.set('activity_id', activityId);
  if (deliveryToken) params.set('delivery_token', deliveryToken);
  if (targetSessionId) params.set('target_session_id', targetSessionId);
  if (!activityId && localSessionId) params.set('local_session_id', localSessionId);
  if (playerAccountId) params.set('player_account_id', playerAccountId);
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
          client.postMessage({ type: 'xsj-open-session', sessionId: localSessionId, playerAccountId });
        }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
