/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/notifications/notifications.js */
/**
 * @module Modules/Notifications
 * @description Client-side controller for Notifications and Push Subscriptions.
 * Handles activity synchronization, push notification life cycle, and SSE intent management.
 * * * SECURITY ARCHITECTURE (v7.3.0):
 * - Encryption Key: Derived from profile._id (Private/Immutable).
 * - Indexing Key: Derived from profile.author (Public/Mutable).
 * This ensures multi-user segregation in shared environments while protecting
 * data persistence beyond session expiration.
 * * * ARCHITECTURE UPDATE:
 * Decoupled from physical file paths. Uses the Plugin Registry contract via
 * the global `QueloraApp.Modules` namespace for Enterprise feature detection.
 * * @version 7.7.0
 */
import handleLog from '../../core/logs.js'; 
import I18n from '../../core/i18n.js';
import SessionModule from '../../core/session.js';
import CoreModule from '../../core/core.js';
import UtilsModule from '../../core/utils.js';
import StorageModule from '../../core/storage.js';
import NotificationRouter from './notificationRouter.js';
import UiModule from '../../ui/ui.js';
import { eventBus } from '../../core/event.js';
import ProfileModule from '../profile/profile.js';
import ConfModule from '../../core/conf.js';

const CONFIG = {
    LOG_ICON: '🛎️',
    KEYS: {
        OPT_OUT: 'ql_push_opt_out',
        LAST_SYNC: 'ql_push_last_sync',
        POSTPONED: 'ql_push_session_postponed'
    },
    SYNC_INTERVAL_MS: 24 * 60 * 60 * 1000
};

/**
 * Known placeholder values written into `DEFAULT_CONFIG` in `conf.js`.
 * Any key matching one of these strings must be treated as "not configured"
 * even though it is truthy, preventing the push subscription flow from
 * being entered with an invalid application server key.
 *
 * @type {Set<string>}
 */
const VAPID_PLACEHOLDERS = new Set([
    'default-public-key',
    'YOUR_VAPID_PUBLIC_KEY',
    ''
]);

/**
 * Returns `true` only when a real VAPID public key has been supplied via
 * `window.QUELORA_CONFIG.vapid.publicKey`.
 *
 * Reads the key lazily at call-time so that `updateConfig()` calls made
 * after module load are always reflected without a page reload.
 *
 * @returns {boolean}
 */
function _isVapidConfigured() {
    const key = ConfModule.get('vapid.publicKey', '');
    return typeof key === 'string' && key.length > 0 && !VAPID_PLACEHOLDERS.has(key);
}

let _state = {
    activities: [], 
    lastActivityTime: null,
    isNotificationRunning: false,
    hasSSESupport: false,
    currentUser: null,
    realtimeActive: false,
    activityInterval: null,
    serviceWorkerRegistration: null,
    pendingPushHash: null,
    isCheckingStatus: false
};

// ============================================================
// EVENT BUS LISTENERS
// ============================================================

eventBus.on('SESSION_ESTABLISHED', async () => {
    const profile = await ProfileModule.getOwnProfile();
    
    if (profile && profile._id && profile.author) {
        _state.currentUser = {
            id: profile._id,
            author: profile.author
        };

        CoreModule.postWorkerMessage({ 
            action: 'setSessionUser', 
            payload: { user: _state.currentUser } 
        });
    }

    await NotificationModule.init();
    await NotificationModule.startService();
    
    if (_isVapidConfigured() && profile?.settings?.notifications?.push !== false) {
        NotificationModule.checkServerSubscription();
    } else if (!_isVapidConfigured()) {
        handleLog('Push notifications skipped: VAPID public key not configured.', 'Notifications', 'info', CONFIG.LOG_ICON);
    } else {
        handleLog('Push notifications disabled in user profile settings.', 'Notifications', 'info', CONFIG.LOG_ICON);
    }
});

eventBus.on('SESSION_CLEARED', () => {
    NotificationModule.stopService();
    CoreModule.postWorkerMessage({ action: 'setSessionUser', payload: { user: null } });
    _state.activities = [];
    _state.currentUser = null;
    _state.lastActivityTime = null;
    _state.pendingPushHash = null;
    StorageModule.removeSessionItem(CONFIG.KEYS.POSTPONED); 
    UiModule.renderActivitiesUI([]);
});

eventBus.on('SSE_MESSAGE', (rawData) => {
    const payload = rawData.payload || rawData;
    if (payload.type === 'resilience_handshake' || payload.type === 'keepalive') return; 
    
    NotificationRouter.dispatch(rawData, 'sse');
    
    const activity = NotificationRouter.normalize(rawData, 'sse');
    if (activity) {
        _state.activities.unshift(activity);
        if (_state.activities.length > 50) _state.activities.pop();
        UiModule.renderActivitiesUI(_state.activities);
        _state.lastActivityTime = activity.created_at;
    }
});

eventBus.on('PUSH_SUBSCRIPTION_STATUS', (payload) => {
    NotificationModule.handleServerStatus(payload);
});

eventBus.on('LOCAL_ACTIVITY_DETECTED', (payload) => {
    if (!payload || !payload.type) return;
    handleLog(`Persisting local event: ${payload.type}`, 'Notifications', 'log', CONFIG.LOG_ICON);
    NotificationModule.saveLocalActivity(payload);
});

// ============================================================
// PRIVATE SERVICES
// ============================================================

const _PrivateServices = {
    getSW: async () => {
        if (_state.serviceWorkerRegistration) return _state.serviceWorkerRegistration;
        if (!('serviceWorker' in navigator)) return null;

        const scriptPath = UtilsModule.getCurrentScriptPath() + 'sw.js';
        const scope = UtilsModule.getCurrentScriptPath();

        // Service Workers must be same-origin — return null when widget is cross-origin.
        try {
            if (new URL(scope, window.location.href).origin !== window.location.origin) return null;
        } catch (_) { return null; }

        try {
            let reg = await navigator.serviceWorker.getRegistration(scope);
            if (!reg) {
                reg = await navigator.serviceWorker.register(scriptPath, { scope });
            }
            _state.serviceWorkerRegistration = reg;
            return reg;
        } catch (e) {
            handleLog(e, 'Notifications', 'error', CONFIG.LOG_ICON, { action: 'getSW' });
            return null;
        }
    },

    generateSubscriptionHash: async (subscription) => {
        if (!subscription?.endpoint) return null;
        
        try {
            const authKey = subscription.getKey('auth');
            const p256dhKey = subscription.getKey('p256dh');
            
            if (!authKey || !p256dhKey) return null;

            const dataToHash = subscription.endpoint + 
                               UtilsModule.arrayBufferToBase64(authKey) + 
                               UtilsModule.arrayBufferToBase64(p256dhKey);
                               
            const encoder = new TextEncoder();
            const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(dataToHash));
            
            return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        } catch (e) {
            handleLog(e, 'Notifications', 'error', CONFIG.LOG_ICON, { action: 'generateSubscriptionHash' });
            return null;
        }
    },

    isLocallyBlocked: () => {
        if (StorageModule.getLocalItem(CONFIG.KEYS.OPT_OUT) === 'true') return true;
        if (StorageModule.getSessionItem(CONFIG.KEYS.POSTPONED) === 'true') return true;
        if (Notification.permission === 'denied') return true;
        return false;
    },

    fetchData: () => {
        if (!_state.currentUser) return;
    }
};

// ============================================================
// PUBLIC API
// ============================================================

const NotificationModule = {
    
    init: async () => {
        await I18n.loadModuleTranslations('notifications');
        CoreModule.postWorkerMessage({ action: 'fetchActivitiesFromDB' });
    },

    saveLocalActivity: (activityPayload) => {
        if (!activityPayload) return;
        const payload = { ...activityPayload };
        if (!payload.created_at) payload.created_at = new Date().toISOString();
        
        CoreModule.postWorkerMessage({ action: 'saveActivity', payload: payload });
        
        const normalized = NotificationRouter.normalize(payload, 'local');
        if (normalized) {
            _state.activities.unshift(normalized);
            if (_state.activities.length > 50) _state.activities.pop();
            UiModule.renderActivitiesUI(_state.activities);
        }
    },

    startService: async () => {
        if (_state.isNotificationRunning) return;
        _state.isNotificationRunning = true;

        if (ConfModule.get('features.sse', false)) {
            const SSEModule = window.QueloraApp?.Modules?.SSEService;

            if (SSEModule) {
                _state.hasSSESupport = true; 
                if (typeof SSEModule.addIntent === 'function') {
                    SSEModule.addIntent('notifications_module');
                } else if (typeof SSEModule.connect === 'function') {
                    SSEModule.connect(); 
                }
            } else {
                _state.hasSSESupport = false;
                handleLog('SSE service not present in Registry (Community Edition). Degrading to Polling.', 'Notifications', 'info', CONFIG.LOG_ICON);
                NotificationModule._startPollingLoop(); 
            }
        } else {
            _state.hasSSESupport = false;
            handleLog('SSE service disabled via config (Community Edition). Degrading to Polling.', 'Notifications', 'info', CONFIG.LOG_ICON);
            NotificationModule._startPollingLoop(); 
        }
    },

    stopService: () => {
        _state.isNotificationRunning = false;
        if (_state.activityInterval) {
            clearTimeout(_state.activityInterval);
            _state.activityInterval = null;
        }
        
        if (_state.hasSSESupport && ConfModule.get('features.sse', false)) {
            const SSEModule = window.QueloraApp?.Modules?.SSEService;
            if (SSEModule) {
                if (typeof SSEModule.removeIntent === 'function') {
                    SSEModule.removeIntent('notifications_module');
                } else if (typeof SSEModule.disconnect === 'function') {
                    SSEModule.disconnect();
                }
            }
        }
    },

    checkServerSubscription: () => {
        if (_state.isCheckingStatus) return;
        _state.isCheckingStatus = true;
        CoreModule.postWorkerMessage({ action: 'checkPushSubscription' });
    },

    handleServerStatus: (payload) => {
        _state.isCheckingStatus = false;
        if (payload && payload.isValid) {
            StorageModule.setLocalItem(CONFIG.KEYS.LAST_SYNC, Date.now().toString());
        } else {
            NotificationModule.checkAndSubscribePush();
        }
    },

    checkAndSubscribePush: () => {
        if (_PrivateServices.isLocallyBlocked()) return;

        if (Notification.permission === 'granted') {
             NotificationModule.subscribeToPushNotifications(false);
             return;
        }

        if (Notification.permission === 'default') {
             NotificationModule.subscribeToPushNotifications(true); 
        }
    },

    subscribeToPushNotifications: async (requiresInteraction = true) => {
        if (!_isVapidConfigured()) {
            handleLog('Push subscription aborted: VAPID public key is not configured.', 'Notifications', 'error', CONFIG.LOG_ICON);
            return;
        }

        if (Notification.permission === 'granted') {
            requiresInteraction = false;
        } else if (Notification.permission === 'denied') {
            return;
        }

        if (requiresInteraction) {
            const uiResult = await UiModule.showPermissionModalUI();
            if (!uiResult) {
                StorageModule.setSessionItem(CONFIG.KEYS.POSTPONED, 'true');
                return;
            }
        }

        if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return;
        }

        try {
            const reg = await _PrivateServices.getSW();
            if (!reg) return;

            if (!reg.active && reg.installing) {
                await new Promise(resolve => {
                    const worker = reg.installing;
                    worker.addEventListener('statechange', () => {
                        if (worker.state === 'activated') resolve();
                    });
                });
            }

            let sub = await reg.pushManager.getSubscription();
            if (!sub) {
                 sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: UtilsModule.urlBase64ToUint8Array(ConfModule.get('vapid.publicKey'))
                });
            }
            
            const hash = await _PrivateServices.generateSubscriptionHash(sub);
            if (!hash) return;

            _state.pendingPushHash = hash;
            const token = SessionModule.getTokenIfAvailable();
            
            CoreModule.postWorkerMessage({
                action: 'subscribePush',
                payload: {
                    subscriptionData: {
                        subscriptionId: hash, 
                        platform: 'web',
                        endpoint: sub.endpoint,
                        keys: {
                            p256dh: UtilsModule.arrayBufferToBase64(sub.getKey('p256dh')),
                            auth: UtilsModule.arrayBufferToBase64(sub.getKey('auth'))
                        }
                    },
                    token,
                    clientHash: hash 
                }
            });

            StorageModule.removeLocalItem(CONFIG.KEYS.OPT_OUT);
            StorageModule.removeSessionItem(CONFIG.KEYS.POSTPONED);
        } catch (e) {
            handleLog(e, 'Notifications', 'error', CONFIG.LOG_ICON, { action: 'subscribePush' });
        }
    },
    
    pushSubscriptionConfirmed: (payload) => {
        const confirmedHash = payload?.hash || _state.pendingPushHash;
        if (confirmedHash) {
            CoreModule.postWorkerMessage({ 
                action: 'registerPushSuccess', 
                payload: { hash: confirmedHash } 
            });
            _state.pendingPushHash = null;
            StorageModule.setLocalItem(CONFIG.KEYS.LAST_SYNC, Date.now().toString());
        }
    },

    unsubscribeFromPushNotifications: async () => {
        try {
            StorageModule.setLocalItem(CONFIG.KEYS.OPT_OUT, 'true');
            StorageModule.removeLocalItem(CONFIG.KEYS.LAST_SYNC);
            
            const token = SessionModule.getTokenIfAvailable(null, true);
            const reg = await _PrivateServices.getSW();

            if (!reg) return true;

            const sub = await reg.pushManager.getSubscription();
            if (sub) {
                const hash = await _PrivateServices.generateSubscriptionHash(sub);
                if (hash && token) {
                    CoreModule.postWorkerMessage({
                        action: 'unsubscribePush',
                        payload: { subscriptionId: hash, token } 
                    });
                }
                await sub.unsubscribe();
            }
            return true;
        } catch (e) {
            handleLog(e, 'Notifications', 'error', CONFIG.LOG_ICON);
            return false;
        }
    },

    handleNetworkRecovery: async () => {
        if (_state.hasSSESupport && ConfModule.get('features.sse', false)) {
             const SSEModule = window.QueloraApp?.Modules?.SSEService;
             if (SSEModule && typeof SSEModule.addIntent === 'function') {
                 SSEModule.addIntent('notifications_module');
             }
        } else {
             handleLog('Network recovered. Resuming polling.', 'Notifications', 'info', CONFIG.LOG_ICON);
        }
    },

    setRealtimeActive: (isActive) => {
        _state.realtimeActive = isActive;
        if (isActive) {
            if (_state.activityInterval) clearTimeout(_state.activityInterval);
        } else {
            if (_state.isNotificationRunning) NotificationModule._startPollingLoop();
        }
    },

    handleActivitiesFromWorker: (payload) => {
        const list = Array.isArray(payload) ? payload : [];
        _state.activities = list.map(a => NotificationRouter.normalize(a, 'db')).filter(Boolean);
        if (_state.activities.length > 0) {
            _state.lastActivityTime = _state.activities[0].created_at;
            requestAnimationFrame(() => {
                UiModule.renderActivitiesUI(_state.activities);
            });
        } else {
            UiModule.renderActivitiesUI([]);
        }
    },

    handleActivitiesFetched: (payload) => {
        if (payload && payload.activities) {
            const normalized = payload.activities.map(a => NotificationRouter.normalize(a, 'polling')).filter(Boolean);
            if (normalized.length > 0) {
                _state.activities = [...normalized, ..._state.activities].slice(0, 100);
                UiModule.renderActivitiesUI(_state.activities);
                _state.lastActivityTime = normalized[0].created_at;
            }
        }
    },

    _startPollingLoop: () => {
        if (_state.activityInterval) clearTimeout(_state.activityInterval);
        if (_state.realtimeActive) return;

        const loop = () => {
            if (!_state.isNotificationRunning || _state.realtimeActive) return;
            const notificationDrawer = document.getElementById('ql-notification-list');
            const isDrawerOpen = notificationDrawer && notificationDrawer.classList.contains('active');
            const delay = isDrawerOpen ? 15000 : 60000;

            _state.activityInterval = setTimeout(() => {
                if (!_state.isNotificationRunning || _state.realtimeActive) return;
                CoreModule.postWorkerMessage({ action: 'fetchActivitiesFromDB' });
                loop();
            }, delay);
        };
        loop();
    }
};

export default NotificationModule;