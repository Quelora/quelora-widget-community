/* filepath: quelora/js/sw.js */

// =============================================================================
// CONSTANTS
// =============================================================================

/** @type {string} Cache namespace for this SW version */
const CACHE_NAME = 'ql-notifications-v3';

/** @type {string} Canonical app origin used for client matching and fallback links */
const APP_URL = 'https://quelora.localhost.ar';

/** @type {string} Fallback icon path relative to APP_URL */
const FALLBACK_ICON = `${APP_URL}/assets/icon.png`;

/** @type {number} Maximum milliseconds to wait for client message delivery */
const CLIENT_POST_TIMEOUT_MS = 3000;

// =============================================================================
// LIFECYCLE EVENTS
// =============================================================================

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      pruneStaleCache(),
    ])
  );
});

// =============================================================================
// PUSH EVENT
// =============================================================================

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

/**
 * Orchestrates the full push-notification pipeline:
 * parse → resolve assets → toast active tab → show system notification.
 *
 * @param {PushEvent} event
 * @returns {Promise<void>}
 */
async function handlePush(event) {
  const payload = parsePushPayload(event.data);
  const link    = buildDeepLink(payload);
  const icon    = await resolveIcon(payload.icon);

  await broadcastToast({ title: payload.title, body: payload.body, url: link, icon });

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon,
    data: { link },
  });
}

// =============================================================================
// NOTIFICATION CLICK EVENT
// =============================================================================

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const link = event.notification.data?.link ?? APP_URL;

  event.waitUntil(focusOrOpenTab(link));
});

/**
 * Focuses an existing app tab navigating it to `link`,
 * or opens a new window when none is found.
 *
 * @param {string} link  Absolute URL to navigate to.
 * @returns {Promise<WindowClient>}
 */
async function focusOrOpenTab(link) {
  const appOrigin  = new URL(APP_URL).origin;
  const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const appClient  = allClients.find((c) => c.url.startsWith(appOrigin));

  if (!appClient) {
    return self.clients.openWindow(link);
  }

  try {
    await appClient.navigate(link);
  } catch {
    // navigate() is not allowed on non-focused clients in some browsers;
    // fall back to postMessage so the app can handle routing itself.
    appClient.postMessage({ type: 'UPDATE_HASH', hash: new URL(link).hash });
  }

  return appClient.focus();
}

// =============================================================================
// PAYLOAD PARSING
// =============================================================================

/**
 * @typedef {Object} PushPayload
 * @property {string}      title
 * @property {string}      body
 * @property {string}      type
 * @property {string|null} icon
 * @property {string|null} entity
 * @property {string|null} commentId
 * @property {string|null} replyId
 * @property {string|null} followId
 */

/**
 * Parses a raw {@link PushMessageData} object into a normalised {@link PushPayload}.
 * Gracefully degrades to a plain-text body when the data is not JSON.
 *
 * @param {PushMessageData|null} data
 * @returns {PushPayload}
 */
function parsePushPayload(data) {
  /** @type {PushPayload} */
  const defaults = {
    title:     'Quelora',
    body:      'Nueva notificación',
    type:      'generic',
    icon:      null,
    entity:    null,
    commentId: null,
    replyId:   null,
    followId:  null,
  };

  if (!data) return defaults;

  const raw = data.text();

  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    // Plain-text push (e.g. DevTools "Test push message")
    return { ...defaults, body: raw || defaults.body };
  }
}

// =============================================================================
// DEEP-LINK BUILDER
// =============================================================================

/**
 * Derives the in-app deep-link URL from a parsed push payload.
 *
 * Hash format conventions:
 *   - User profile : `#QUELORA-U-{followId}`
 *   - Comment      : `#QUELORA-Q-{entity}-{commentId}`
 *   - Reply        : `#QUELORA-Q-{entity}-{commentId}-{replyId}`
 *   - Like         : `#QUELORA-L-{entity}-{commentId}[-{replyId}]`
 *
 * @param {PushPayload} payload
 * @returns {string} Absolute URL with the appropriate hash fragment.
 */
function buildDeepLink({ type, entity, commentId, replyId, followId }) {
  switch (type) {
    case 'follower':
      return followId
        ? `${APP_URL}#QUELORA-U-${followId}`
        : APP_URL;

    case 'comment':
      return entity && commentId
        ? `${APP_URL}#QUELORA-Q-${entity}-${commentId}`
        : APP_URL;

    case 'reply':
      return entity && commentId && replyId
        ? `${APP_URL}#QUELORA-Q-${entity}-${commentId}-${replyId}`
        : APP_URL;

    case 'like':
      if (!entity || !commentId) return APP_URL;
      return replyId
        ? `${APP_URL}#QUELORA-L-${entity}-${commentId}-${replyId}`
        : `${APP_URL}#QUELORA-L-${entity}-${commentId}`;

    default:
      return APP_URL;
  }
}

// =============================================================================
// CLIENT MESSAGING
// =============================================================================

/**
 * @typedef {Object} ToastMessage
 * @property {'SHOW_TOAST'} type
 * @property {string}       title
 * @property {string}       body
 * @property {string}       url
 * @property {string}       icon
 */

/**
 * Posts a `SHOW_TOAST` message to the first matching app-origin tab.
 *
 * Chrome restricts `clients.matchAll()` visibility during push events;
 * we therefore iterate *all* clients (including uncontrolled ones) and
 * post to the first whose URL shares the app origin.
 *
 * A resolved Promise is always returned — delivery is best-effort
 * and must not block `showNotification`.
 *
 * @param {{ title: string, body: string, url: string, icon: string }} options
 * @returns {Promise<void>}
 */
async function broadcastToast({ title, body, url, icon }) {
  let allClients;

  try {
    allClients = await Promise.race([
      self.clients.matchAll({ includeUncontrolled: true, type: 'window' }),
      timeout(CLIENT_POST_TIMEOUT_MS, []),
    ]);
  } catch {
    return;
  }

  const appOrigin = new URL(APP_URL).origin;

  for (const client of allClients) {
    if (!client.url.startsWith(appOrigin)) continue;

    try {
      client.postMessage({ type: 'SHOW_TOAST', title, body, url, icon });
    } catch (err) {
      console.warn('[SW] postMessage failed for client', client.url, err);
    }

    break; // Only the first matching tab receives the toast.
  }
}

// =============================================================================
// ICON RESOLUTION
// =============================================================================

/**
 * Returns the best available notification icon URL.
 * Priority: custom icon → cached `/icon.png` → static fallback.
 *
 * @param {string|null} customIcon  URL provided by the push payload.
 * @returns {Promise<string>}
 */
async function resolveIcon(customIcon) {
  if (customIcon) return customIcon;

  try {
    const cache    = await caches.open(CACHE_NAME);
    const response = await cache.match('/icon.png');
    if (response?.url) return response.url;
  } catch (err) {
    console.warn('[SW] Cache lookup for icon failed:', err);
  }

  return FALLBACK_ICON;
}

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

/**
 * Removes all caches whose keys do not match {@link CACHE_NAME}.
 *
 * @returns {Promise<boolean[]>}
 */
async function pruneStaleCache() {
  const keys = await caches.keys();
  return Promise.all(
    keys
      .filter((key) => key !== CACHE_NAME)
      .map((key) => caches.delete(key))
  );
}

// =============================================================================
// UTILITIES
// =============================================================================

/**
 * Returns a Promise that resolves to `fallback` after `ms` milliseconds.
 * Intended for use with {@link Promise.race} to add a ceiling to async ops.
 *
 * @template T
 * @param {number} ms
 * @param {T}      fallback
 * @returns {Promise<T>}
 */
function timeout(ms, fallback) {
  return new Promise((resolve) => setTimeout(() => resolve(fallback), ms));
}