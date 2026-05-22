/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/quelora.js */
/**
 * @module Quelora
 * @description Application entry point and singleton orchestrator.
 * Bootstraps the core system, initializes the Worker, and defers
 * full application load until user interaction requires it.
 *
 * Plugin Loading Strategy:
 * The `plugins.worker` manifest from {@link ConfModule} is forwarded to the
 * Worker via the `init` message payload so that the Worker's dynamic plugin
 * registry can resolve module paths at runtime without any hardcoded imports.
 *
 * @version 17.0.0
 */
import queloraRootElement from './core/scaffold.js';
import handleLog from './core/logs.js';
import ConfModule from './core/conf.js';
import UiModule from './ui/ui.js';
import InteractionsUiModule from './modules/posts/entity.ui.js';
import UtilsModule from './core/utils.js';
import CoreModule from './core/core.js';
import ProfileModule from './modules/profile/profile.js';
import ProfileEntry from './modules/profile/profile.entry.js';
import PostsModule from './modules/posts/posts.js';
import I18n from './core/i18n.js';
import SessionModule from './core/session.js';
import IconsModule from './ui/icons.js';
import StorageModule from './core/storage.js';
import SecurityModule from './core/security.js';
import EntityModule from './modules/posts/entity.js';
import { eventBus } from './core/event.js';
import bootstrapRemoteConfig from './core/remoteConfig.js';


const Quelora = (() => {
    let instance;
    let worker;
    let token = null;
    let cid = null;
    let currentScriptPath;
    let apiUrl;

    let systemIdentity = null;

    const DEFAULT_LANGUAGE = 'en';

    let isAppInitialized = false;
    let appLoadPromise = null;

    const earlyWorkerBuffer = [];
    const EARLY_ACTIONS = new Set(['hotLinkPeers', 'cachedPeersForP2P', 'busSignal']);

    /**
     * Validates the Client ID from configuration against the expected format.
     *
     * @param {object} ConfModule - The configuration module instance.
     * @returns {string|null} The normalized Client ID or null if invalid.
     */
    const getValidatedClientId = (ConfModule) => {
        try {
            const clientId = ConfModule.get('cid');
            if (!clientId?.trim()) throw new Error('Client ID parameter is required.');
            if (!/^QU-[A-Z0-9]{8}-[A-Z0-9]{5}$/i.test(clientId)) {
                throw new Error('Invalid Client ID format. Expected pattern: QU-XXXXXXXX-XXXXX');
            }
            return clientId.toUpperCase();
        } catch (error) {
            handleLog(`Error - ${error.message} ${window.location.href}`, 'Quelora', 'error', '🏠');
            return null;
        }
    };

    /**
     * Instantiates the shared Worker, preferring an inlined blob when available.
     *
     * @param {object} ConfModule - The configuration module instance.
     * @returns {Worker} The initialized Worker instance.
     */
    const initWorker = (ConfModule) => {
        try {
            if (typeof WORKER_CONTENT !== 'undefined') {
                const blob = new Blob([WORKER_CONTENT], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                return new Worker(workerUrl, { type: 'module' });
            }
            const workerPath = ConfModule.get('workerPath', currentScriptPath + 'worker/queloraWorker.js');

            // Cross-origin module workers require a same-origin blob wrapper.
            // The blob imports the actual worker entry so relative chunk imports
            // still resolve correctly against the remote base URL.
            const isCrossOrigin = (() => {
                try { return new URL(workerPath).origin !== window.location.origin; }
                catch (_) { return false; }
            })();

            if (isCrossOrigin) {
                const blob = new Blob([`import '${workerPath}';`], { type: 'application/javascript' });
                return new Worker(URL.createObjectURL(blob), { type: 'module' });
            }

            return new Worker(workerPath, { type: 'module' });
        } catch (error) {
            handleLog(error, 'Quelora.initWorker', 'error', '🏠');
            throw error;
        }
    };

    /**
     * Initializes geolocation services if enabled in configuration.
     *
     * @param {object} ConfModule - The configuration module instance.
     * @returns {Promise<[string|null, object|null]>} Resolved IP and location data.
     */
    const initializeGeolocation = async (ConfModule) => {
        if (!ConfModule.get('geolocation.enabled')) return [null, null];
        try {
            const { default: GeoStorage } = await import('./services/geoStorage.js');
            GeoStorage.configure(
                ConfModule.get('geolocation.provider'),
                ConfModule.get('geolocation.apiKey', '')
            );
            return await Promise.all([GeoStorage.getIp(), GeoStorage.getLocation()]);
        } catch (error) {
            handleLog(error, 'Quelora.initializeGeolocation', 'warn', '🏠');
            return [null, null];
        }
    };

    /**
     * Resolves the active language and initializes the i18n module.
     * Priority: saved preference → browser language → default.
     *
     * @param {object} I18n - The i18n module instance.
     * @param {object} StorageModule - The storage module instance.
     */
    const i18nRun = (I18n, StorageModule) => {
        try {
            let savedLanguage = StorageModule.getLocalItem('ql_language');
            const browserLanguage = (navigator.language || navigator.userLanguage).substring(0, 2);
            if (savedLanguage === 'auto') savedLanguage = null;
            let langToUse = savedLanguage || browserLanguage || DEFAULT_LANGUAGE;
            I18n.initializeI18N(
                langToUse,
                currentScriptPath + 'locales/',
                [
                    { className: 't' },
                    { className: 'ql-comment-input', attribute: 'placeholder' },
                    { className: 'ql-search__input', attribute: 'placeholder' },
                    { className: 'ql-translate', attribute: 'placeholder' }
                ]
            );
        } catch (error) {
            handleLog(error, 'Quelora.i18nRun', 'error', '🏠');
        }
    };

    /**
     * Builds the Worker message handler map for core system actions.
     *
     * @param {object} deps - Handler dependencies.
     * @param {object} deps.ProfileModule - Profile module instance.
     * @param {object} deps.UiModule - UI module instance.
     * @param {object} deps.SessionModule - Session module instance.
     * @returns {object} Map of action strings to handler functions.
     */
    const getWorkerMessageHandlers = ({ ProfileModule, UiModule, SessionModule }) => ({
        statsFetched: (payload) => { InteractionsUiModule.renderStatsUI(payload.posts); },
        returnMyProfile: (payload) => { ProfileModule.saveMyProfile(payload.profile); },
        offline: () => handleLog('No internet connection', 'Quelora.WorkerHandler.offline', 'warn', '🏠'),
        identityReady: (payload) => { systemIdentity = payload.identity; },
        updateServerInfo: (payload) => {
            if (payload.country) {
                StorageModule.setLocalItem('ql_last_server_country', payload.country);
                if (payload.region) StorageModule.setLocalItem('ql_last_server_region', payload.region);
            }
        },
        updateGeolocation: async (payload) => {
            try {
                const { default: GeoStorage } = await import('./services/geoStorage.js');
                GeoStorage.saveServerLocation(payload);
            } catch (error) {
                handleLog(error, 'Quelora.WorkerHandler.updateGeolocation', 'error', '🏠');
            }
        },
        busSignal: (payload) => {
            eventBus.emit(payload.type, payload.data);
            if (window.QueloraApp?.emitBusSignal) {
                window.QueloraApp.emitBusSignal(payload.type, payload.data);
            }
        },
        auth_login_complete: (payload) => { eventBus.emit('auth_login_complete', payload); },
        invalidToken: async () => {
            await ProfileModule.logout();
            ProfileModule.updateProfileOptionUI();
            SessionModule.getToken(false, true).catch(() => {});
        },
        chatListReturned: (payload) => eventBus.emit('CHAT_LIST_RETURNED', payload),
        chatHistoryReturned: (payload) => eventBus.emit('CHAT_HISTORY_RETURNED', payload),
        chatMessageReceived: (payload) => eventBus.emit('CHAT_MESSAGE_RECEIVED', payload),
        chatMessageSent: (payload) => eventBus.emit('CHAT_MESSAGE_SENT', payload),
        error: (payload) => handleLog(payload?.details?.message || payload?.message, 'Quelora.WorkerHandler.error', 'error', '🏠'),
    });

    /**
     * Dispatches an incoming Worker message to the appropriate handler.
     * Messages received before app initialization are buffered if their action
     * is listed in {@link EARLY_ACTIONS}.
     *
     * @param {MessageEvent} event - The Worker message event.
     * @param {object} handlers - The handler map produced by {@link getWorkerMessageHandlers}.
     */
    const handleWorkerMessage = (event, handlers) => {
        try {
            const { action, payload, originalPayload, originalAction } = event.data;

            if (!isAppInitialized && EARLY_ACTIONS.has(action)) {
                earlyWorkerBuffer.push({ action, payload, originalPayload, originalAction });
                return;
            }

            const handler = handlers[action];
            if (handler) handler(payload, originalPayload, originalAction);
        } catch (error) {
            handleLog(error, 'Quelora.handleWorkerMessage', 'error', '🏠');
        }
    };

    /**
     * Returns the URL anchor action handler map.
     * Each handler validates, sanitizes, and delegates to QueloraApp.
     *
     * @returns {object} Map of anchor action codes to async handler functions.
     */
    const getAnchorHandlers = () => {
        return {
            'Q': async (params) => {
                await ensureAppIsInitialized();
                window.QueloraApp.handleAnchor('Q', params);
            },
            'U': async (params) => {
                await ensureAppIsInitialized();
                window.QueloraApp.handleAnchor('U', params);
            },
            'E': async (params) => {
                await ensureAppIsInitialized();
                window.QueloraApp.handleAnchor('E', params);
            },
            'L': async (params) => {
                await ensureAppIsInitialized();
                window.QueloraApp.handleAnchor('L', params);
            },
            'O': async (params) => handleLog(`Action: Opinion - Params: ${params}`, 'Quelora.AnchorHandler.Opinion', 'log', '🏠'),
            'R': async (params) => {
                await ensureAppIsInitialized();
                window.QueloraApp.handleAnchor('R', params);
            },
            'A': async (params) => handleLog(`Action: Archive - Params: ${params}`, 'Quelora.AnchorHandler.Archive', 'log', '🏠'),
        };
    };

    /**
     * Parses and dispatches the current URL hash if it matches the QUELORA anchor protocol.
     * Cleans the URL after capturing parameters to avoid re-triggering on navigation.
     *
     * @param {object} handlers - The anchor handler map.
     */
    const checkAndHandleAnchor = async (handlers) => {
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const hash = window.location.hash.substring(1);
            if (!hash.startsWith('QUELORA-') || hash.length > 1000) return;

            const parts = hash.split('-').map(decodeURIComponent);
            const [prefix, action, ...params] = parts;

            const handler = handlers[action];

            if (prefix !== 'QUELORA' || !handler) return;

            const safeParams = params.map(p => p.replace(/[^a-zA-Z0-9]/g, '').substring(0, 100)).filter(Boolean);

            history.replaceState(null, null, window.location.pathname + window.location.search);

            await handler(safeParams);
        } catch (error) {
            handleLog(error, 'Quelora.checkAndHandleAnchor', 'error', '🏠');
        }
    };

    /**
     * Registers online/offline connection event listeners.
     *
     * @param {object} PostsModule - The posts module instance.
     */
    const initConnectionListeners = (PostsModule) => {
        window.addEventListener('online', () => PostsModule.fetchStats());
        window.addEventListener('offline', () => handleLog("No internet connection.", 'Quelora.initConnectionListeners', 'warn', '🏠'));
    };

    /**
     * Registers the Service Worker if not already active for the current scope,
     * and sets up the listener for SW-to-Client messages.
     *
     * @param {string} basePath - The base path used as the SW scope.
     */
    async function initializeServiceWorker(basePath) {
        if (!('serviceWorker' in navigator)) return;

        // Service Workers must be same-origin — skip when widget is loaded cross-origin.
        try {
            if (new URL(basePath, window.location.href).origin !== window.location.origin) return;
        } catch (_) { return; }

        try {
            const swPath = `${basePath}sw.js`;
            const registration = await navigator.serviceWorker.getRegistration(basePath);
            if (!registration) {
                await navigator.serviceWorker.register(swPath, { scope: basePath });
                handleLog('Service Worker registered proactively.', 'Quelora.initializeServiceWorker', 'info', '🏠');
            }

            navigator.serviceWorker.addEventListener('message', (event) => {
                if (!event.data) return;
                const { type, title, body, url, icon, hash } = event.data;

                if (type === 'SHOW_TOAST') {
                    eventBus.emit('SHOW_TOAST', { title, body, url, icon });
                } else if (type === 'UPDATE_HASH' && hash) {
                    window.location.hash = hash;
                }
            });

        } catch (error) {
            handleLog(error, 'Quelora.initializeServiceWorker', 'warn', '🏠');
        }
    }

    /**
     * Lazily loads and initializes the full application bundle (quelora-app.js).
     * Replays any buffered early Worker messages after initialization completes.
     * Subsequent calls return the same promise.
     *
     * @returns {Promise<void>}
     */
    function preloadApp() {
        if (appLoadPromise) return appLoadPromise;

        appLoadPromise = new Promise(async (resolve, reject) => {
            try {
                const { init: initQueloraApp } = await import('./core/quelora-app.js');
                if (typeof initQueloraApp !== 'function') {
                    throw new Error('QueloraApp.init function not found after loading app bundle.');
                }

                await initQueloraApp(worker, {
                    CoreModule,
                    UtilsModule,
                    I18n,
                    SessionModule,
                    StorageModule,
                    ConfModule,
                    IconsModule,
                    PostsModule,
                    ProfileModule,
                    UiModule,
                    systemIdentity,
                    currentScriptPath
                });

                isAppInitialized = true;

                if (earlyWorkerBuffer.length) {
                    earlyWorkerBuffer.forEach(evt => {
                        worker.dispatchEvent(new MessageEvent('message', { data: evt }));
                    });
                    earlyWorkerBuffer.length = 0;
                }

                resolve();
            } catch (error) {
                handleLog(error, 'Quelora.preloadApp', 'error', '🏠');
                reject(error);
            }
        });

        return appLoadPromise;
    }

    /**
     * Ensures the full application is initialized before proceeding.
     * Shows a global spinner while the app bundle loads.
     *
     * @returns {Promise<void>}
     */
    async function ensureAppIsInitialized() {
        if (isAppInitialized) return;
        if (!appLoadPromise) preloadApp();
        UiModule.addGlobalSpinner();
        try {
            await appLoadPromise;
        } finally {
            UiModule.removeGlobalSpinner();
        }
    }

    /**
     * Main initialization routine. Validates configuration, bootstraps the Worker,
     * registers listeners, and schedules deferred app load.
     *
     * The `plugins.worker` manifest is forwarded to the Worker inside the `init`
     * message so the Worker's dynamic plugin registry can import modules by the
     * paths declared in the configuration without any hardcoded references.
     *
     * @returns {Promise<void>}
     */
    async function init() {
        if (!queloraRootElement) throw new Error('Quelora root element could not be created.');

        Object.assign(UiModule, InteractionsUiModule);
        currentScriptPath = UtilsModule.getCurrentScriptPath();
        apiUrl = ConfModule.get('apiUrl');
        if (!(cid = getValidatedClientId(ConfModule))) return;

        await bootstrapRemoteConfig(cid, apiUrl, StorageModule, ConfModule, SecurityModule);

        token = await CoreModule.getTokenIfNeeded(token, true);

        const [ip, location] = await initializeGeolocation(ConfModule);

        worker = initWorker(ConfModule);
        const handlers = getWorkerMessageHandlers({ ProfileModule, UiModule, SessionModule });
        worker.addEventListener('message', (e) => handleWorkerMessage(e, handlers));

        worker.postMessage({
            action: 'init',
            payload: {
                ip,
                location,
                apiUrl,
                token,
                cid,
                useCaptcha: ConfModule.get('captcha.enabled'),
                onlineStatus: navigator.onLine,
                features: ConfModule.get('features', {}),
                plugins: ConfModule.get('plugins.worker', [])
            }
        });

        initConnectionListeners(PostsModule);
        const anchorHandlers = getAnchorHandlers();
        window.addEventListener('popstate', () => checkAndHandleAnchor(anchorHandlers));

        await IconsModule.initializeIcons();
        await CoreModule.initializeCore({ worker });

        await PostsModule.initialize(ensureAppIsInitialized);
        UiModule.initializeUILight(ensureAppIsInitialized);

        i18nRun(I18n, StorageModule);

        if (ConfModule.get('authWidget.enabled', false)) {
            try {
                await ProfileEntry.init();
            } catch (e) {
                handleLog(e, 'Quelora.init:authWidget', 'error', '🏠');
            }
        }

        const entityConfig = EntityModule.getConfig();
        const handleNewEntities = UtilsModule.debounce(() => { PostsModule.fetchStats(); }, 250);
        UtilsModule.observeDomChanges(entityConfig.selector, handleNewEntities);

        PostsModule.fetchStats();

        initializeServiceWorker(currentScriptPath);
        await checkAndHandleAnchor(anchorHandlers);

        setTimeout(preloadApp, 1000);
    }

    return {
        /**
         * Returns the singleton initialization promise, creating it on first call.
         *
         * @returns {Promise<void>}
         */
        getInstance: () => {
            if (!instance) instance = init();
            return instance;
        }
    };
})();

// When loaded dynamically (e.g. Next.js <Script>, async/defer injection),
// DOMContentLoaded may have already fired — call init immediately in that case.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Quelora.getInstance());
} else {
    Quelora.getInstance();
}