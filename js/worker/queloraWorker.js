/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/worker/queloraWorker.js */
/**
 * @file queloraWorker.js
 * @module Worker/Main
 * @description Central network and data processing worker. Enforces Resilience routing rules.
 *
 * Responsibilities:
 * - Bootstraps the resilience subsystem on first contact with the server via `performInitialHealthCheck`.
 * - Routes every outgoing action through mode-aware gatekeeping (HYBRID / PASSIVE / SERVER_ONLY / P2P_ONLY).
 * - Detects when server-side resilience is disabled (`enabled: false`) by the absence of the
 * `X-Resilience-Bootstrap` response header and normalises mode back to HYBRID via `applyResilienceFallback`.
 * - Orchestrates multi-source stat fetching: in-memory cache → P2P layer → server network.
 * - Persists trusted artifacts and sidecar interaction state to IndexedDB for offline fallback.
 * - Processes WASM-based image and Markdown transformations off the main thread.
 *
 * Plugin Loading Strategy:
 * Worker-side plugins are no longer resolved via hardcoded `import()` paths.
 * On `init`, the main thread forwards `payload.plugins` — the `PluginManifest[]`
 * array from `conf.plugins.worker` — into `_state.plugins`.  The PluginRegistry
 * uses this manifest to resolve the correct path for each named module, making
 * every worker plugin path configurable from a single source of truth (`conf.js`).
 *
 * @version 14.3.2
 */

import handleLog from '../core/logs.js';
import initImageWasm, { process_image, resize_to_max_width } from './pkg/quelora_image_processor.js';
import initMarkdownWasm, { parse_markdown } from './pkg/quelora_markdown_parser.js';
import { ApiEndpoints } from './endpointsWorker.js';
import { Utils } from './utilsWorker.js';

/**
 * Master kill-switch for the entire resilience subsystem.
 * When `true`, P2P offloading, binary artifact ingestion, and offline fallback
 * are all disabled regardless of server configuration. Intended for emergency
 * deployments or isolated environments where the resilience layer must be
 * bypassed without a server-side change.
 * @type {boolean}
 */
const FORCE_DISABLE_RESILIENCE = false;

// =============================================================================
// DYNAMIC PLUGIN REGISTRY
// =============================================================================

/**
 * @typedef {Object} WorkerPluginManifest
 * @property {string} name - Logical plugin identifier matching the keys used by `ensure*` accessors.
 * @property {string} path - Module path forwarded from `conf.plugins.worker` via the `init` message.
 */

/**
 * Centralized registry for all lazily-loaded Worker-side plugin modules.
 *
 * Design:
 * - `_instances`  — holds the resolved module export once the import settles.
 * - `_promises`   — deduplicates concurrent import attempts (one in-flight promise per name).
 * - `_manifest`   — populated on `init` from `payload.plugins`; maps logical name to file path.
 *
 * All `ensure*` accessor functions are thin wrappers around PluginRegistry.load so
 * that adding a new Worker plugin requires only a conf entry, not a code change here.
 *
 * @namespace PluginRegistry
 */
const PluginRegistry = {
    /** @type {Record<string, object>} */
    _instances: {},

    /** @type {Record<string, Promise<object|null>>} */
    _promises: {},

    /** @type {Record<string, string>} */
    _manifest: {},

    /**
     * Registers the plugin path manifest received from the main thread.
     * Must be called once, during the `init` message handler, before any
     * `ensure*` accessor is invoked.
     *
     * @param {WorkerPluginManifest[]} plugins - Array of `{ name, path }` entries from `conf.plugins.worker`.
     */
    register(plugins) {
        if (!Array.isArray(plugins)) return;
        for (const entry of plugins) {
            if (entry && typeof entry.name === 'string' && typeof entry.path === 'string') {
                this._manifest[entry.name] = entry.path;
            }
        }
        handleLog(
            `PluginRegistry: registered ${Object.keys(this._manifest).length} worker plugin(s).`,
            'Worker',
            'info',
            CONSTANTS.LOG_ICON
        );
    },

    /**
     * Lazily imports a named plugin module.
     *
     * Resolution order:
     * 1. Return the cached instance if already loaded.
     * 2. Look up the path from `_manifest[name]`; return `null` if absent.
     * 3. Deduplicate concurrent callers with a single shared promise.
     * 4. On success, store the resolved export in `_instances[name]`.
     * 5. On failure, log and return `null` for graceful degradation.
     *
     * @param {string}                     name      - Logical plugin name (e.g. `'ResilienceManager'`).
     * @param {(module: object) => object} extractor - Extracts the desired export from the raw module.
     * @param {'info'|'warn'|'error'}      [logLevel='info'] - Level used when the file is absent.
     * @returns {Promise<object|null>} The extracted export, or `null` if unavailable.
     */
    load(name, extractor, logLevel = 'info') {
        if (this._instances[name]) return Promise.resolve(this._instances[name]);

        const path = this._manifest[name];
        if (!path) {
            handleLog(
                `PluginRegistry: no path registered for plugin "${name}". Skipping.`,
                'Worker',
                logLevel,
                CONSTANTS.LOG_ICON
            );
            return Promise.resolve(null);
        }

        if (!this._promises[name]) {
            this._promises[name] = (async () => {
                try {
                    const module = await import(path);
                    const resolved = extractor(module);
                    if (resolved) {
                        this._instances[name] = resolved;
                    }
                    return resolved || null;
                } catch (e) {
                    handleLog(
                        `PluginRegistry: failed to load plugin "${name}" from "${path}". ${e.message}`,
                        'Worker',
                        logLevel,
                        CONSTANTS.LOG_ICON
                    );
                    delete this._promises[name];
                    return null;
                }
            })();
        }

        return this._promises[name];
    }
};

// =============================================================================
// CONVENIENCE ACCESSORS (backed by PluginRegistry)
// =============================================================================

/**
 * Convenience getter: exposes the resolved ResilienceManager instance or `null`.
 * Used throughout the worker wherever the old module-level `ResilienceManager`
 * variable was read directly.
 *
 * @returns {object|null}
 */
const _getResilienceManager = () => PluginRegistry._instances['ResilienceManager'] || null;

/**
 * Convenience getter: exposes the resolved ResilienceCrypto instance or `null`.
 *
 * @returns {object|null}
 */
const _getResilienceCrypto = () => PluginRegistry._instances['ResilienceCrypto'] || null;

/**
 * Convenience getter: exposes the resolved SSEService instance or `null`.
 *
 * @returns {object|null}
 */
const _getSSEService = () => PluginRegistry._instances['SSEWorker'] || null;

/**
 * Convenience getter: exposes the resolved ChatWorker instance or `null`.
 *
 * @returns {object|null}
 */
const _getChatWorker = () => PluginRegistry._instances['ChatWorker'] || null;

/**
 * Convenience getter: exposes the resolved FallbackDB instance or `null`.
 *
 * @returns {object|null}
 */
const _getFallbackDB = () => PluginRegistry._instances['FallbackDB'] || null;

/**
 * Convenience getter: exposes the resolved ActivitiesWorkerDB instance or `null`.
 *
 * @returns {object|null}
 */
const _getActivitiesDB = () => PluginRegistry._instances['ActivitiesWorkerDB'] || null;

/**
 * Shared initialization promise. Resolved once `performInitialHealthCheck` completes.
 * Actions arriving before initialization await this promise before proceeding.
 * @type {Promise|null}
 */
let _initializationPromise = null;

/**
 * Flag indicating that the initial health-check handshake has completed (success or failure).
 * Once `true`, subsequent `init` messages are ignored.
 * @type {boolean}
 */
let _isInitialized = false;

/**
 * Worker-wide configuration constants.
 *
 * @property {string}   LOG_ICON             - Emoji prefix used in all worker log entries.
 * @property {Object}   CACHE_CONFIG         - Per-action in-memory cache TTL values in milliseconds.
 * @property {number}   CACHE_LIMIT          - Maximum number of entries in the in-memory request cache.
 * @property {Object}   NETWORK              - Default network retry and timeout parameters.
 * @property {number}   NETWORK.MAX_RETRIES  - Number of network attempts before giving up.
 * @property {number}   NETWORK.TIMEOUT_MS   - Per-attempt fetch timeout in milliseconds.
 * @property {number}   NETWORK.RETRY_DELAY_MS - Delay between retry attempts in milliseconds.
 * @property {Object}   TIMEOUT_OVERRIDES    - Per-action timeout overrides that supersede NETWORK.TIMEOUT_MS.
 * @property {Set<string>} RESILIENCE_WHITELIST - Actions eligible for offline/P2P fallback and DB-backed recovery.
 * @property {Set<string>} INTERACTION_ENDPOINTS - Read-only content endpoints that receive sidecar enrichment.
 * @property {Set<string>} P2P_ONLY_ANON_BLOCKED - Actions unconditionally blocked for anonymous users in P2P_ONLY mode.
 */
const CONSTANTS = {
    LOG_ICON: '👷',
    CACHE_CONFIG: {
        'fetchStats': 5000,
        'getComments': 15000,
        'getReplies': 15000,
        'getProfile': 5000,
        'getMention': 60000,
        'trendingGif': 60000 * 10,
    },
    CACHE_LIMIT: 50,
    NETWORK: {
        MAX_RETRIES: 3,
        TIMEOUT_MS: 5000,
        RETRY_DELAY_MS: 500
    },
    TIMEOUT_OVERRIDES: {
        'searchMention': 30000,
        'searchAccounts': 30000,
    },
    RESILIENCE_WHITELIST: new Set([
        'fetchStats', 'getComments', 'getReplies', 'getMyProfile', 'getProfile', 'fetchProxy'
    ]),
    INTERACTION_ENDPOINTS: new Set([
        'fetchStats', 'getComments', 'getReplies', 'getNested', 'getMyProfile', 'getProfile', 'fetchProxy'
    ]),
    /**
     * Actions unconditionally blocked for anonymous users in P2P_ONLY mode.
     * These are social, profile, and infrastructure operations that require
     * server auth or SSE signaling. Content read actions (stats, threads, audio,
     * translations) are intentionally absent — they may still reach the server
     * as a last resort if the P2P layer fails to deliver within its timeout.
     */
    P2P_ONLY_ANON_BLOCKED: new Set([
        'getMyProfile', 'getProfile', 'getMention',
        'followUser', 'unfollowUser', 'cancelFollowRequest', 'approveFollowUser',
        'blockUser', 'unblockUser', 'getBlocked',
        'uploadProfileImage', 'updateMultipleProfileFields', 'updateSettings',
        'searchProfileData', 'searchMention', 'searchAccounts', 'removeSuggestion',
        'getFollowingActivities',
        'setLike', 'setLikeComment', 'setShare', 'toggleBookmark',
        'createComment', 'editComment', 'delComment',
        'reportComment', 'reportContact',
        'subscribePush', 'unsubscribePush',
        'getSSETicket'
    ])
};

/**
 * Mutable worker runtime state. All fields are initialized to safe defaults
 * and populated progressively as the worker receives `init` and network responses.
 *
 * @property {string|null}  sharedIp              - Client IP extracted from GeoIP response headers.
 * @property {object|null}  sharedLocation        - Full GeoIP location object (country, region, city, lat/lon).
 * @property {string|null}  apiUrl                - Base API URL, normalized (no trailing slash).
 * @property {string|null}  cid                   - Client identifier injected into every request header.
 * @property {string|null}  token                 - Current session bearer token, or null for anonymous.
 * @property {string|null}  vaultPepper           - Encryption pepper for the chat vault, from bootstrap or manual set.
 * @property {boolean}      isCustomPepper        - True when the pepper was set manually (user-supplied), not from server.
 * @property {string|null}  currentUser           - Identifier of the authenticated user for activity persistence.
 * @property {Map}          requestCache          - LRU-bounded in-memory response cache keyed by action+payload hash.
 * @property {boolean}      imageWasmInitialized  - True once the image processing WASM module has loaded.
 * @property {boolean}      markdownWasmInitialized - True once the Markdown parser WASM module has loaded.
 * @property {Promise|null} imageWasmPromise      - In-flight WASM init promise (prevents duplicate initializations).
 * @property {Promise|null} markdownWasmPromise   - In-flight WASM init promise (prevents duplicate initializations).
 * @property {boolean}      serverInfoCaptured    - True once server geo headers have been forwarded to the main thread.
 * @property {string|null}  p2pIdentity           - Hex identity string used as X-Peer-ID in outgoing requests.
 * @property {object}                  features - Feature toggles injected from the main thread config.
 * @property {WorkerPluginManifest[]}  plugins  - Worker plugin manifest forwarded from `conf.plugins.worker`.
 */
let _state = {
    sharedIp: null,
    sharedLocation: null,
    apiUrl: null,
    cid: null,
    token: null,
    vaultPepper: null,
    isCustomPepper: false,
    currentUser: null,
    requestCache: new Map(),
    imageWasmInitialized: false,
    markdownWasmInitialized: false,
    imageWasmPromise: null,
    markdownWasmPromise: null,
    serverInfoCaptured: false,
    p2pIdentity: null,
    features: {},
    plugins: []
};

handleLog('Script loaded. Waiting for init...', 'Worker', 'log', CONSTANTS.LOG_ICON);

// =============================================================================
// PLUGIN ACCESSOR FUNCTIONS
// =============================================================================

/**
 * Lazily loads and returns the ChatWorker plugin via PluginRegistry.
 * Guarded by the `chat` feature toggle; returns `null` when the feature is off.
 *
 * @returns {Promise<object|null>} The ChatWorker export, or `null` if unavailable.
 */
async function ensureChatWorker() {
    if (!_state.features.chat) return null;
    return PluginRegistry.load('ChatWorker', (m) => m.ChatWorker, 'info');
}

/**
 * Lazily loads and returns the ResilienceManager plugin via PluginRegistry.
 * Guarded by the `resilience` or `p2p` feature toggles.
 *
 * @returns {Promise<object|null>} The ResilienceManager export, or `null` if unavailable.
 */
async function ensureResilienceManager() {
    if (!_state.features.resilience && !_state.features.p2p) return null;
    return PluginRegistry.load('ResilienceManager', (m) => m.ResilienceManager, 'warn');
}

/**
 * Lazily loads and returns the ResilienceCrypto plugin via PluginRegistry.
 * Guarded by the `resilience` or `p2p` feature toggles.
 *
 * @returns {Promise<object|null>} The ResilienceCrypto default export, or `null` if unavailable.
 */
async function ensureResilienceCrypto() {
    if (!_state.features.resilience && !_state.features.p2p) return null;
    return PluginRegistry.load('ResilienceCrypto', (m) => m.default, 'warn');
}

/**
 * Lazily loads and returns the SSEService plugin via PluginRegistry.
 * Guarded by the `sse` feature toggle.
 *
 * @returns {Promise<object|null>} The SSEService export, or `null` if unavailable.
 */
async function ensureSSEService() {
    if (!_state.features.sse) return null;
    return PluginRegistry.load('SSEWorker', (m) => m.SSEService, 'warn');
}

/**
 * Lazily loads and returns the FallbackDB plugin via PluginRegistry.
 * Guarded by the `resilience` feature toggle.
 * Logs an informational message when the toggle is off so callers can engage L0 Direct.
 *
 * @returns {Promise<object|null>} The FallbackDB default export, or `null` if unavailable.
 */
async function ensureFallbackDB() {
    if (!_state.features.resilience) {
        handleLog('_getFallbackDB() disabled by feature toggle. Engaging L0 Direct.', 'Worker', 'info', CONSTANTS.LOG_ICON);
        return null;
    }
    return PluginRegistry.load('FallbackDB', (m) => m.default, 'info');
}

/**
 * Lazily loads and returns the ActivitiesWorkerDB plugin via PluginRegistry.
 * Not guarded by a feature toggle — activities DB is always available when present.
 *
 * @returns {Promise<object|null>} The ActivitiesWorkerDB export, or `null` if unavailable.
 */
async function ensureActivitiesDB() {
    return PluginRegistry.load('ActivitiesWorkerDB', (m) => m.ActivitiesWorkerDB, 'info');
}

const Core = {
    /**
     * Extracts meaningful error messages from API response objects safely.
     * Prevents raw JSON strings from bleeding into the UI layer.
     * @param {any} input - The error object, Error instance, or primitive to stringify.
     * @returns {string} - A safe, user-facing error string.
     */
    toSafeString(input) {
        if (!input) return 'Unknown Error';
        if (input instanceof Error) return `${input.name}: ${input.message}`;
        try {
            if (typeof input === 'object') {
                if (input.details && input.details.data) {
                    return Object.values(input.details.data).join(' - ');
                }
                if (input.message) {
                    return String(input.message);
                }
                if (input.statusText) {
                    return String(input.statusText);
                }
                return JSON.stringify(input);
            }
            return String(input);
        } catch {
            return String(input);
        }
    },

    /**
     * Ensures the image processing WASM module is initialized before use.
     * Uses a shared promise to prevent concurrent duplicate initializations.
     * Resets the promise on failure so the next caller can retry.
     * @returns {Promise<void>}
     */
    async ensureImageWasm() {
        if (_state.imageWasmInitialized) return;
        if (!_state.imageWasmPromise) {
            const wasmUrl = new URL('./pkg/quelora_image_processor_bg.wasm', import.meta.url).href;
            _state.imageWasmPromise = initImageWasm(wasmUrl)
                .then(() => {
                    _state.imageWasmInitialized = true;
                })
                .catch(e => {
                    handleLog(e, 'Worker', 'error', CONSTANTS.LOG_ICON);
                    _state.imageWasmPromise = null;
                    throw e;
                });
        }
        await _state.imageWasmPromise;
    },

    /**
     * Ensures the Markdown parser WASM module is initialized before use.
     * Uses a shared promise to prevent concurrent duplicate initializations.
     * Resets the promise on failure so the next caller can retry.
     * Silently suppresses deprecation warnings emitted by the WASM runtime.
     * @returns {Promise<void>}
     */
    async ensureMarkdownWasm() {
        if (_state.markdownWasmInitialized) return;
        if (!_state.markdownWasmPromise) {
            const wasmUrl = new URL('./pkg/quelora_markdown_parser_bg.wasm', import.meta.url).href;
            _state.markdownWasmPromise = initMarkdownWasm(wasmUrl)
                .then(() => {
                    _state.markdownWasmInitialized = true;
                })
                .catch(e => {
                    if (!e.message?.includes('deprecated parameters')) {
                        handleLog(e, 'Worker', 'error', CONSTANTS.LOG_ICON);
                    }
                    _state.markdownWasmPromise = null;
                    throw e;
                });
        }
        await _state.markdownWasmPromise;
    },

    /**
     * Derives a deterministic storage UID for a given action and payload.
     * UIDs are used as keys in IndexedDB (FallbackDB) and as P2P request identifiers.
     * Only actions in `CONSTANTS.RESILIENCE_WHITELIST` are eligible; others return null.
     *
     * @param {string} actionName - The API action name (e.g. 'getComments', 'fetchStats').
     * @param {object} payload    - The action payload used to disambiguate the resource.
     * @returns {string|null} A stable UID string, or null if the action is not whitelisted.
     */
    deriveResourceUid(actionName, payload) {
        if (!CONSTANTS.RESILIENCE_WHITELIST.has(actionName)) return null;
        switch (actionName) {
            case 'getComments': return `${payload.entityId}_thread_${payload.lastCommentId || 'head'}`;
            case 'getReplies': return `${payload.entityId}_replies_${payload.commentId}_${payload.lastCommentId || 'head'}`;
            case 'getMyProfile': return 'own_profile_signed';
            case 'getProfile': return `profile_${payload.author}`;
            case 'fetchStats': return (payload.entities && payload.entities.length === 1) ? `${payload.entities[0]}_stats` : null;
            default: return null;
        }
    },

    /**
     * Handles a server response where the X-Resilience-Bootstrap header is absent.
     * This is the expected condition when the server has resilience disabled (`enabled: false`).
     * Without this handler, the system would remain in whatever mode was last set (or the
     * ResilienceManager default), leaving Guard, UI, and routing in an inconsistent state.
     *
     * Normalizes the operational mode to HYBRID and emits RESILIENCE_MODE_CHANGED so that
     * all subscribers (Guard, ResilienceUI, etc.) converge on a known baseline state.
     *
     * @returns {void}
     */
    applyResilienceFallback() {
        if (!_getResilienceManager()) return;

        const currentMode = typeof _getResilienceManager().getMode === 'function'
            ? _getResilienceManager().getMode()
            : null;

        if (currentMode === 'HYBRID') return;

        handleLog(
            'X-Resilience-Bootstrap absent. Server resilience is disabled. Normalizing mode to HYBRID.',
            'Worker',
            'warn',
            CONSTANTS.LOG_ICON
        );

        _getResilienceManager().setMode('HYBRID');

        self.postMessage({
            action: 'busSignal',
            payload: { type: 'RESILIENCE_MODE_CHANGED', data: { mode: 'HYBRID' } }
        });
    },

    /**
     * Parses and applies a raw X-Resilience-Bootstrap header value.
     * Synchronizes state down to the ChatWorker if the vault pepper is updated.
     *
     * @param {string}      headerValue - Raw base64 value of X-Resilience-Bootstrap.
     * @param {string|null} token       - Session token if the user is authenticated, else null.
     * @returns {Promise<void>}
     */
    async applyResilienceBootstrap(headerValue, token = null) {
        if (!headerValue || !_getResilienceManager() || !_getResilienceCrypto()) return;

        try {
            const config = JSON.parse(atob(headerValue));

            if (config.publicKey) {
                await _getResilienceCrypto().updateTrustedKey({
                    publicKey: config.publicKey,
                    expiresAt: (Date.now() / 1000) + 86400
                });
            }

            let pepperUpdated = false;

            if (config.vaultPepper) {
                _state.vaultPepper = config.vaultPepper;
                pepperUpdated = true;
            }
            if (config.isCustomPepper !== undefined) {
                _state.isCustomPepper = !!config.isCustomPepper;
            }

            if (pepperUpdated) {
                try {
                    const chatModule = await ensureChatWorker();
                    if (chatModule) {
                        const vaultCtx = {
                            postMessage: (msg) => self.postMessage(msg),
                            token: token || _state.token,
                            pepperDB: _state.vaultPepper,
                            isCustomPepper: _state.isCustomPepper
                        };
                        await chatModule.handleAction(vaultCtx, 'chatSetVaultPepper', { 
                            vaultPepper: _state.vaultPepper,
                            isCustomPepper: _state.isCustomPepper
                        });
                        handleLog(`[Vault] ChatWorker state synchronized proactively.`, 'Worker', 'log', CONSTANTS.LOG_ICON);
                    }
                } catch (err) {
                    handleLog(`[Resilience] ChatWorker sync error: ${err.message}`, 'Worker', 'warn', CONSTANTS.LOG_ICON);
                }
            }

            const bootstrapMode = config.mode || 'HYBRID';
            _getResilienceManager().setMode(bootstrapMode);
            handleLog(`Bootstrap Mode applied: ${bootstrapMode}`, 'Worker', 'log', CONSTANTS.LOG_ICON);

            self.postMessage({
                action: 'busSignal',
                payload: { type: 'RESILIENCE_MODE_CHANGED', data: { mode: bootstrapMode } }
            });

            const isServerOnly      = bootstrapMode === 'SERVER_ONLY';
            const shouldEnablePeers = !FORCE_DISABLE_RESILIENCE && !token && !isServerOnly;

            if (shouldEnablePeers && config.peers && Array.isArray(config.peers) && config.peers.length > 0) {
                await _getResilienceManager().ingestLivePeers(config.peers);
                handleLog(`Bootstrapped: PK Updated + ${config.peers.length} peers. Mode: ${bootstrapMode}`, 'Worker', 'log', CONSTANTS.LOG_ICON);
            } else {
                handleLog(`Bootstrapped: PK Updated (Peers Skipped). Mode: ${bootstrapMode}`, 'Worker', 'log', CONSTANTS.LOG_ICON);
            }
        } catch (e) {
            handleLog(e, 'Worker', 'warn', CONSTANTS.LOG_ICON);
        }
    },

    /**
     * Performs the initial handshake with the server on worker startup.
     * Runs exactly once: subsequent calls are no-ops once `_isInitialized` is true.
     *
     * Sequence:
     * 1. Ensures ResilienceManager and ResilienceCrypto are loaded.
     * 2. Generates or restores the P2P identity and announces it to the main thread.
     * 3. Issues a GET /health request with full auth, geo, and peer-ID headers.
     * 4. If `X-Resilience-Bootstrap` is present, applies the bootstrap config.
     * 5. If the header is absent and the server responds OK, calls `applyResilienceFallback`
     * to signal that server-side resilience is currently disabled.
     * 6. On success, notifies subscribers via the `ONLINE_MODE` bus signal.
     * 7. On timeout or network failure, enters offline mode (unless `FORCE_DISABLE_RESILIENCE`).
     *
     * A hard 5-second outer timeout races against the handshake to guarantee
     * `_isInitialized` is eventually set even if the server is unreachable.
     *
     * @param {object} ctx              - Execution context for the health check.
     * @param {string|null} ctx.token   - Session bearer token, or null for anonymous.
     * @param {string} ctx.apiUrl       - Base API URL.
     * @param {string} ctx.cid          - Client identifier.
     * @returns {Promise<void>}
     */
    async performInitialHealthCheck(ctx) {
        if (_isInitialized) return;

        const handshakeLogic = async () => {
            await ensureResilienceManager();
            await ensureResilienceCrypto();
            
            if (_getResilienceCrypto() && _getResilienceCrypto().getOrGenIdentity) {
                const id = await _getResilienceCrypto().getOrGenIdentity();
                _state.p2pIdentity = id; 
                self.postMessage({ action: 'identityReady', payload: { identity: id } });
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            try {
                if (!_state.apiUrl) throw new Error('API URL not set');
                
                const headers = Utils.authHeaders(ctx.token);
                if (_state.cid) headers['X-Client-ID'] = _state.cid;
                
                if (_state.p2pIdentity) headers['X-Peer-ID'] = _state.p2pIdentity;
                Object.assign(headers, Utils.extractGeoHeaders(_state.sharedIp, _state.sharedLocation));

                const response = await fetch(`${_state.apiUrl}/health`, { 
                    method: 'GET', 
                    headers: headers,
                    mode: 'cors' 
                });
                clearTimeout(timeoutId);
            
                const bootstrapHeader = response.headers.get('X-Resilience-Bootstrap');
                if (bootstrapHeader) {
                    await Core.applyResilienceBootstrap(bootstrapHeader, ctx.token);
                } else if (response.ok) {
                    Core.applyResilienceFallback();
                }
                
                if (response.ok) {
                    if (_getResilienceManager()) _getResilienceManager().notifyNetworkRestored('health_check');
                    
                    self.postMessage({
                        action: 'busSignal',
                        payload: {
                            type: 'ONLINE_MODE',
                            data: {
                                timestamp: Date.now(),
                                source: 'worker_health_check'
                            }
                        }
                    });

                    return true;
                } else {
                    throw new Error('Server returned ' + response.status);
                }
            } catch (e) {
                handleLog(e, 'Worker', 'warn', CONSTANTS.LOG_ICON);
                throw e;
            } finally {
                clearTimeout(timeoutId);
            }
        };

        const timeoutLogic = new Promise((_, reject) => setTimeout(() => reject(new Error('Hard Timeout')), 5000));
        
        _initializationPromise = Promise.race([handshakeLogic(), timeoutLogic])
            .catch(() => {
                if (!FORCE_DISABLE_RESILIENCE && _getResilienceManager()) {
                    handleLog('Handshake timed out. Entering offline mode.', 'Worker', 'warn', CONSTANTS.LOG_ICON);
                    _getResilienceManager().enterOfflineMode(ctx);
                } else {
                    handleLog('Handshake timed out. Network unavailable (Offline Mode Disabled).', 'Worker', 'error', CONSTANTS.LOG_ICON);
                }
            })
            .finally(() => { _isInitialized = true; });
            
        await _initializationPromise;
    }
};

/**
 * Intercepts an incoming payload and persists any embedded notification activities
 * to IndexedDB for the currently authenticated user. Called from both the SSE
 * message handler (real-time) and the `getFollowingActivities` polling response.
 *
 * Supports three payload shapes:
 * - A plain array of activity objects.
 * - An object with an `activities` array property.
 * - A single activity object identified by `isNotification` or `type`+`actor` fields.
 *
 * @param {object|Array} payload - The incoming SSE or HTTP response payload.
 * @param {string}       source  - Label for the origin of the data ('sse' | 'polling').
 * @returns {Promise<void>}
 */
async function interceptAndPersistActivities(payload, source) {
    if (!_state.currentUser) return;

    const db = await ensureActivitiesDB();
    if (!db) return;

    let activities = [];
    if (Array.isArray(payload)) activities = payload;
    else if (payload.activities) activities = payload.activities;
    else if (payload.isNotification || (payload.type && payload.actor)) activities = [payload];

    if (activities.length > 0) {
        try {
            await db.addActivities(activities, _state.currentUser);
        } catch (e) {
            handleLog(`Activity Persist Error: ${e.message}`, 'Worker', 'error', CONSTANTS.LOG_ICON);
        }
    }
}

/**
 * Merges sidecar interaction state (liked, bookmarked) into a list of content items in-place.
 * The sidecar is a sparse map keyed by entity ID; items absent from the map receive
 * explicit `false` values so consumers never see stale truthy state.
 *
 * Recognizes three data shapes:
 * - A plain array of items.
 * - An object with a `posts` array.
 * - An object with a `comments.list` array.
 *
 * @param {object|Array} data    - The response data to enrich.
 * @param {object}       sidecar - Parsed sidecar map: `{ [entityId]: { authorLiked, authorBookmarked } }`.
 * @returns {object|Array} The mutated `data` reference.
 */
function applySidecarInMemory(data, sidecar) {
    if (!data || !sidecar || Object.keys(sidecar).length === 0) return data;

    let items = [];
    if (Array.isArray(data)) items = data;
    else if (data.posts) items = data.posts;
    else if (data.comments?.list) items = data.comments.list;
    else return data;

    items.forEach(item => {
        const rawId = item.entity || item.entityId || item._id;
        if (!rawId) return;

        const key = rawId.toString();
        const state = sidecar[key];

        if (state) {
            item.authorLiked = state.authorLiked === true;
            item.authorBookmarked = state.authorBookmarked === true;
        } else {
            item.authorLiked = false;
            item.authorBookmarked = false;
        }
    });

    return data;
}

/**
 * Extracts and persists the `X-Sidecar` response header.
 * The header is a Base64-encoded JSON map of per-entity user interaction state.
 * Persistence to FallbackDB is fire-and-forget; parse failures return null silently.
 *
 * @param {Response} response - The Fetch API response object.
 * @returns {object|null} The parsed sidecar map, or null if the header is absent or malformed.
 */
function parseAndStoreSidecar(response) {
    const sidecarHeader = response.headers.get('X-Sidecar');
    if (!sidecarHeader) return null;

    try {
        const jsonStr = atob(sidecarHeader);
        const userState = JSON.parse(jsonStr);
        ensureFallbackDB().then(db => {
            if (db) db.storeSidecarState(userState).catch(e => handleLog(e, 'Worker', 'warn', CONSTANTS.LOG_ICON));
        });
        return userState;
    } catch (e) {
        return null;
    }
}

/**
 * Executes a fetch request with automatic retry and per-attempt timeout.
 * Sidecar state is extracted from the response headers on every successful attempt.
 * Throws `NetworkTimeout` if all attempts are aborted; re-throws the last network error otherwise.
 *
 * @param {string} url                                     - The fully-qualified request URL.
 * @param {RequestInit} options                            - Standard Fetch API options (method, headers, body).
 * @param {number} [maxRetries=CONSTANTS.NETWORK.MAX_RETRIES] - Maximum number of attempts.
 * @param {number} [timeoutMs=CONSTANTS.NETWORK.TIMEOUT_MS]   - Per-attempt timeout in milliseconds.
 * @returns {Promise<{response: Response, sidecar: object|null}>} The successful response and its parsed sidecar.
 * @throws {Error} `NetworkTimeout` on abort, or the last fetch error after all retries are exhausted.
 */
async function executeNetworkRequest(url, options, maxRetries = CONSTANTS.NETWORK.MAX_RETRIES, timeoutMs = CONSTANTS.NETWORK.TIMEOUT_MS) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timeoutId);
            
            const sidecar = parseAndStoreSidecar(response);
            return { response, sidecar };
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, CONSTANTS.NETWORK.RETRY_DELAY_MS));
        }
    }
    if (lastError.name === 'AbortError') throw new Error('NetworkTimeout');
    throw lastError || new Error('Network Request Failed after retries');
}

/**
 * Orchestrates multi-source stat fetching for a batch of entity IDs.
 *
 * Resolution order:
 * 1. **Offline (L3)**: IndexedDB → P2P swarm (if offloading is active).
 * 2. **Online + Anonymous + P2P active (L2)**: P2P swarm first, then server for misses.
 * 3. **Online (L1)**: Direct server request for all remaining entities.
 *
 * Binary (`octet-stream`) and JSON server responses are both handled.
 * When `X-Resilience-Bootstrap` is present, the bootstrap is applied opportunistically.
 * When absent on a successful response, `applyResilienceFallback` normalises the mode.
 *
 * @param {object}   ctx           - Execution context.
 * @param {string|null} ctx.token  - Session bearer token, or null for anonymous.
 * @param {string}   ctx.apiUrl    - Base API URL.
 * @param {string}   ctx.cid       - Client identifier.
 * @param {object}   payload       - The `fetchStats` action payload.
 * @param {string[]} payload.entities - Array of entity IDs to fetch stats for.
 * @param {object}   [payload.mapping] - Optional display mapping forwarded to the server.
 * @param {string}   successAction - Redux action name to dispatch with results.
 * @returns {Promise<void>}
 */
async function handleStatsOrchestration(ctx, payload, successAction) {
    const { entities: rawEntities } = payload;
    if (!rawEntities || !Array.isArray(rawEntities) || rawEntities.length === 0) {
        return self.postMessage({ action: successAction, payload: { posts: [] }, originalPayload: payload });
    }

    const entities = rawEntities.map(String);

    const aggregatedResults = new Map();
    const missingEntities   = new Set(entities);

    const isOffline    = !!(_getResilienceManager() && _getResilienceManager().isOffline);
    const canOffload   = !!(_getResilienceManager() && _getResilienceManager().isOffloadingActive());
    const isAnonymous  = !ctx.token;

    if (isOffline) {
        const db = await ensureFallbackDB();
        if (db) {
            await Promise.all(entities.map(async (entityId) => {
                const uid    = `${entityId}_stats`;
                const cached = await db.getThreadByUid(uid);

                let unpacked = cached?.data;
                if (!unpacked && cached?.rawArtifact) {
                    const cryptoMod = await ensureResilienceCrypto();
                    if (cryptoMod) {
                        unpacked = await cryptoMod.verifyAndUnpack(cached.rawArtifact, uid, true);
                    }
                }

                if (unpacked) {
                    aggregatedResults.set(entityId, unpacked);
                    missingEntities.delete(entityId);
                }
            }));
        }

        if (missingEntities.size > 0 && !FORCE_DISABLE_RESILIENCE && canOffload) {
            const p2pResults = await Promise.all(
                Array.from(missingEntities).map(async (entityId) => {
                    try {
                        const result = await _getResilienceManager().attemptP2PFetch(`${entityId}_stats`);
                        if (result?.data) return { id: entityId, data: result.data };
                    } catch { }
                    return null;
                })
            );
            p2pResults.forEach(res => {
                if (res) {
                    aggregatedResults.set(res.id, res.data);
                    missingEntities.delete(res.id);
                }
            });
        }

        let posts = entities.map(id => aggregatedResults.get(id) || { entity: id, _missing: true });

        if (posts.length > 0 && ctx.token && db) {
            posts = await db.applyUserInteractions(posts);
        }

        return self.postMessage({
            action: successAction,
            payload: { posts, status: 'ok', _is_offline: true },
            originalPayload: payload
        });
    }

    const shouldAttemptP2P = !FORCE_DISABLE_RESILIENCE && canOffload && isAnonymous;

    if (shouldAttemptP2P && missingEntities.size > 0) {
        const p2pResults = await Promise.all(
            Array.from(missingEntities).map(async (entityId) => {
                try {
                    const result = await _getResilienceManager().attemptP2PFetch(`${entityId}_stats`);
                    if (result?.data) return { id: entityId, data: result.data };
                } catch { }
                return null;
            })
        );
        p2pResults.forEach(res => {
            if (res) {
                aggregatedResults.set(res.id, res.data);
                missingEntities.delete(res.id);
            }
        });
    }

    if (missingEntities.size > 0) {
        try {
            const remainingIds = Array.from(missingEntities);
            const params = new URLSearchParams({ entities: JSON.stringify(remainingIds) });
            if (payload.mapping) params.append('mapping', JSON.stringify(payload.mapping));
            const url = `${ctx.apiUrl}/posts/stats?${params}`;

            const headers = Utils.authHeaders(ctx.token);
            if (ctx.cid) headers['X-Client-ID'] = ctx.cid;
            Object.assign(headers, Utils.extractGeoHeaders(_state.sharedIp, _state.sharedLocation));

            const { response, sidecar } = await executeNetworkRequest(url, { method: 'GET', headers });
            
            const bootstrapHeader = response.headers.get('X-Resilience-Bootstrap');
            if (bootstrapHeader) {
                Core.applyResilienceBootstrap(bootstrapHeader, ctx.token).catch(e => {
                    handleLog(`[Worker] Bootstrap sync failed: ${e.message}`, 'Worker', 'warn', CONSTANTS.LOG_ICON);
                });
            } else if (response.ok) {
                Core.applyResilienceFallback();
            }

            if (response.status === 401) {
                self.postMessage({ action: 'invalidToken', payload: { message: 'Session expired' }, originalPayload: payload });
                return;
            }

            if (response.ok) {
                const cType = response.headers.get('content-type');
                let newItems = [];

                if (cType && (cType.includes('octet-stream') || cType.includes('resilience+bin'))) {
                    const buf = await response.arrayBuffer();
                    if (_getResilienceManager()) {
                        newItems = await _getResilienceManager().ingestTrustedBatch(buf);
                    } else {
                        handleLog('Binary received but ResilienceManager not ready.', 'Worker', 'error', CONSTANTS.LOG_ICON);
                    }
                } else {
                    const text = await response.text();
                    let data = text ? JSON.parse(text) : {};
                    
                    if (data && data.dictionary) {
                        const targetKey = data.posts ? 'posts' : 'data';
                        if (data[targetKey]) {
                            data[targetKey] = Utils.deserializeData(data[targetKey], data.dictionary);
                        }
                    }

                    if (data && data.data && typeof data.data === 'object' && !data.posts) {
                        data = data.data;
                    }

                    newItems = data.posts || data.data || (Array.isArray(data) ? data : []);
                }
                
                if (sidecar) applySidecarInMemory(newItems, sidecar);

                if (Array.isArray(newItems)) {
                    newItems.forEach(item => {
                        const id = item.entity || item.entityId || item._id;
                        if (id) {
                            if (!item.entity) item.entity = id;
                            aggregatedResults.set(id.toString(), item);
                            missingEntities.delete(id.toString());
                        }
                    });
                }
            }
        } catch (err) {
            handleLog(err, 'Worker', 'error', CONSTANTS.LOG_ICON);
        }
    }

    const posts = entities.map(id => aggregatedResults.get(id) || { entity: id, _missing: true });

    self.postMessage({ action: successAction, payload: { posts, status: 'ok' }, originalPayload: payload });
}

/**
 * Central network request handler for all API endpoint actions.
 * Applies in-memory caching, resilience mode gating, P2P offloading,
 * binary/JSON response parsing, sidecar enrichment, and offline fallback.
 *
 * Special-cases:
 * - `fetchStats` is delegated entirely to `handleStatsOrchestration`.
 * - `checkHealth` bypasses the initialization wait and offline gate.
 *
 * Bootstrap detection:
 * - Presence of `X-Resilience-Bootstrap` → `applyResilienceBootstrap`.
 * - Absence on a successful response (and action ≠ `checkHealth`) → `applyResilienceFallback`.
 *
 * @param {string}        actionName      - The logical action name (used for caching and routing).
 * @param {string}        url             - Fully-qualified request URL.
 * @param {RequestInit}   options         - Fetch options (method, body, headers, isFormData).
 * @param {string}        successAction   - Redux action to dispatch on success.
 * @param {Function|null} responseHandler - Optional custom response handler; receives `(response, successAction, payload)`.
 * @param {object}        [payload={}]    - Full action payload (used for auth injection, caching, and error routing).
 * @returns {Promise<void>}
 */
const handleFetch = async (actionName, url, options = {}, successAction, responseHandler = null, payload = {}) => {
    
    if (actionName === 'fetchStats') {
        const orchestrationCtx = { 
            postMessage: (msg) => self.postMessage(msg), 
            apiUrl: _state.apiUrl, 
            token: payload.token || _state.token, 
            cid: payload.cid || _state.cid, 
            sharedIp: _state.sharedIp,
            sharedLocation: _state.sharedLocation
        };
        await ensureResilienceManager();
        return handleStatsOrchestration(orchestrationCtx, payload, successAction);
    }

    const cacheKey = `${actionName}[${Utils.hashPayload(payload)}]`;
    const cacheDur = CONSTANTS.CACHE_CONFIG[actionName];
    
    await ensureResilienceManager(); 
    if (!_isInitialized && actionName !== 'checkHealth') {
        if (_initializationPromise) await _initializationPromise;
    }

    const ctx = { 
        postMessage: (msg) => self.postMessage(msg), 
        apiUrl: _state.apiUrl, 
        token: payload.token || _state.token, 
        cid: payload.cid || _state.cid, 
        sharedIp: _state.sharedIp,
        sharedLocation: _state.sharedLocation,
        fetch: handleFetch 
    };
    if (payload.token) _state.token = payload.token;
    if (payload.cid) _state.cid = payload.cid;

    const uid = Core.deriveResourceUid(actionName, payload);
    
    if (!payload.forceRefresh && cacheDur && _state.requestCache.has(cacheKey)) {
        const entry = _state.requestCache.get(cacheKey);
        if (Date.now() - entry.timestamp < cacheDur) {
            let cachedData = entry.data;
            if (CONSTANTS.INTERACTION_ENDPOINTS.has(actionName)) {
                if (ctx.token) {
                    const db = await ensureFallbackDB();
                    if (db) {
                        if (cachedData.posts) cachedData.posts = await db.applyUserInteractions(cachedData.posts);
                        else if (cachedData.comments?.list) cachedData.comments.list = await db.applyUserInteractions(cachedData.comments.list);
                        else if (Array.isArray(cachedData)) cachedData = await db.applyUserInteractions(cachedData);
                    }
                }
            }
            return self.postMessage({ action: successAction, payload: cachedData, originalPayload: payload });
        }
    }

    try {
        let headers = Utils.authHeaders(ctx.token);
        if (options.isFormData) delete headers['Content-Type'];
        let requestBody = options.body;
        if (requestBody && typeof requestBody === 'object' && !options.isFormData && headers['Content-Type'] === 'application/json') {
            requestBody = JSON.stringify(requestBody);
        }
        const geoHeaders = Utils.extractGeoHeaders(_state.sharedIp, _state.sharedLocation);
        let mergedOptions = { 
            ...options, 
            body: requestBody, 
            headers: { 
                ...headers, 
                ...geoHeaders, 
                ...(ctx.cid && { 'X-Client-ID': ctx.cid }), 
                ...(payload.captchaToken && { 'X-Captcha-Token': payload.captchaToken }), 
                ...options.headers 
            } 
        };

        if (mergedOptions.method === 'GET' || mergedOptions.method === 'HEAD') delete mergedOptions.body;

        if (_getResilienceManager() && _getResilienceManager().isOffline && actionName !== 'checkHealth') {
            throw new Error('OfflineModeActive');
        }

        if (_getResilienceManager() && !FORCE_DISABLE_RESILIENCE) {
            const _mode = typeof _getResilienceManager().getMode === 'function' ? _getResilienceManager().getMode() : 'HYBRID';

            if (_mode === 'SERVER_ONLY' && !CONSTANTS.INTERACTION_ENDPOINTS.has(actionName) && actionName !== 'checkHealth') {
                handleLog(
                    `[Resilience:Routing] SERVER_ONLY: action blocked: ${actionName}.`,
                    'Resilience', 'warn', CONSTANTS.LOG_ICON
                );
                const _action = payload.errorAction || 'error';
                self.postMessage({
                    action: _action,
                    payload: { action: actionName, message: 'ActionUnavailableServerOnly' },
                    originalPayload: payload,
                    _silent_fail: true
                });
                return;
            }

            if (!ctx.token) {
                if (_mode === 'PASSIVE' && actionName === 'fetchProxy' && payload && payload.endpoint) {
                    const endpoint = payload.endpoint.toLowerCase();
                    if (endpoint.includes('/login') || endpoint.includes('/auth/register') || endpoint.includes('/auth/password')) {
                        handleLog(
                            `[Resilience:Routing] PASSIVE: Anonymous session creation blocked.`,
                            'Resilience', 'warn', CONSTANTS.LOG_ICON
                        );
                        const _action = payload.errorAction || 'error';
                        self.postMessage({
                            action: _action,
                            payload: { action: actionName, message: 'NewSessionsDisabled' },
                            originalPayload: payload,
                            _silent_fail: true
                        });
                        return;
                    }
                }

                if (_mode === 'P2P_ONLY' && CONSTANTS.P2P_ONLY_ANON_BLOCKED.has(actionName)) {
                    handleLog(
                        `[Resilience:Routing] P2P_ONLY: anonymous blocked for non-content action: ${actionName}.`,
                        'Resilience', 'warn', CONSTANTS.LOG_ICON
                    );
                    const _action = payload.errorAction || 'error';
                    self.postMessage({
                        action: _action,
                        payload: { action: actionName, message: 'OfflineModeActive' },
                        originalPayload: payload,
                        _silent_fail: true
                    });
                    return;
                }
            }

            const isAnonymous = !ctx.token;
            const isOffline = _getResilienceManager().isOffline;
            const canOffload = _getResilienceManager().isOffloadingActive();

            const shouldAttemptP2P = canOffload && (isOffline || isAnonymous);

            if (shouldAttemptP2P && uid && actionName !== 'fetchProxy') {
                try {
                    const p2pData = await _getResilienceManager().attemptP2PFetch(uid);
                    if (p2pData && p2pData.data) {
                        let resultData = p2pData.data;
                        if (CONSTANTS.INTERACTION_ENDPOINTS.has(actionName)) {
                            if (ctx.token) {
                                const db = await ensureFallbackDB();
                                if (db) {
                                    if (resultData.posts) resultData.posts = await db.applyUserInteractions(resultData.posts);
                                    else if (resultData.comments?.list) resultData.comments.list = await db.applyUserInteractions(resultData.comments.list);
                                }
                            }
                        }
                        if (cacheDur) {
                            if (_state.requestCache.size >= CONSTANTS.CACHE_LIMIT) {
                                const oldest = _state.requestCache.keys().next().value;
                                _state.requestCache.delete(oldest);
                            }
                            _state.requestCache.set(cacheKey, { data: resultData, timestamp: Date.now() });
                        }
                        return self.postMessage({ action: successAction, payload: resultData, originalPayload: payload });
                    }
                } catch (p2pError) {}
            }
        }

        const retries = payload.skipRetries ? 1 : CONSTANTS.NETWORK.MAX_RETRIES;
        const requestTimeout = (CONSTANTS.TIMEOUT_OVERRIDES && CONSTANTS.TIMEOUT_OVERRIDES[actionName]) 
            ? CONSTANTS.TIMEOUT_OVERRIDES[actionName] 
            : CONSTANTS.NETWORK.TIMEOUT_MS;

        const { response, sidecar } = await executeNetworkRequest(url, mergedOptions, retries, requestTimeout);

        const bootstrapHeader = response.headers.get('X-Resilience-Bootstrap');
        if (bootstrapHeader) {
            Core.applyResilienceBootstrap(bootstrapHeader, ctx.token).catch(e => {
                handleLog(`[Worker] Bootstrap sync failed: ${e.message}`, 'Worker', 'warn', CONSTANTS.LOG_ICON);
            });
        } else if (response.ok && actionName !== 'checkHealth') {
            Core.applyResilienceFallback();
        }

        if (response.status === 401) {
            // When the caller declared an errorAction (e.g. login / SSO verify flows),
            // a 401 means bad credentials — NOT an expired session. Routing through
            // invalidToken would tear down any existing session unnecessarily and leave
            // the login Promise permanently pending. Fall through to parseFetchError so
            // the full response body is forwarded to the errorAction handler instead.
            if (!payload.errorAction) {
                self.postMessage({
                    action: 'invalidToken',
                    payload: { message: 'Invalid token/Session Expired' },
                    originalPayload: payload,
                    originalAction: successAction
                });
                throw new Error('InvalidToken');
            }
        }

        if (_getResilienceManager() && _getResilienceManager().isOffline) {
            _getResilienceManager().notifyNetworkRestored('opportunistic');
        }

        const newGeo = Utils.extractGeoHeadersFromResponse(response.headers);
        if (newGeo) {
            const hasIpChanged = _state.sharedIp !== newGeo.ip;
            const hasCountryChanged = _state.sharedLocation?.country !== newGeo.country;
            if (hasIpChanged || hasCountryChanged) {
                _state.sharedIp = newGeo.ip;
                _state.sharedLocation = newGeo;
                self.postMessage({ action: 'updateGeolocation', payload: newGeo });
            }
        }
        if (!_state.serverInfoCaptured) { 
            const serverGeoHeaders = Utils.extractServerHeaders(response.headers);
            if (serverGeoHeaders) {
                _state.serverInfoCaptured = true;
                self.postMessage({ action: 'updateServerInfo', payload: serverGeoHeaders });
            }
        }

        if (responseHandler) return responseHandler(response, successAction, payload);
        if (!response.ok) throw await Utils.parseFetchError(response);
        if (response.status === 204) return self.postMessage({ action: successAction, payload: {}, originalPayload: payload });

        let data;
        const cType = response.headers.get('content-type');
        const isBinary = cType && (cType.includes('octet-stream') || cType.includes('resilience+bin'));

        if (isBinary) {
            const buf = await response.arrayBuffer();
            if (_getResilienceManager()) {
                const resilienceMode = response.headers.get('X-Resilience-Mode');
                const resilienceScope = response.headers.get('X-Resilience-Scope') || 'public';
                const isBatch = (resilienceMode === 'batch-signed') || (actionName === 'fetchStats');
                
                if (isBatch) {
                    const items = await _getResilienceManager().ingestTrustedBatch(buf);
                    if (!items) throw new Error("Batch ingestion failed.");
                    data = { posts: items, status: 'ok' };
                } else {
                    const uid = Core.deriveResourceUid(actionName, payload);
                    data = await _getResilienceManager().ingestTrustedArtifact(buf, uid, resilienceScope);
                    if (!data) throw new Error("Artifact ingestion failed.");
                }
            } else {
                handleLog('Binary data received but ResilienceManager not loaded.', 'Worker', 'error', CONSTANTS.LOG_ICON);
                data = {};
            }
        } else {
            const text = await response.text();
            data = text ? JSON.parse(text) : {};
            if (data && data.dictionary) {
                const targetKey = data.posts ? 'posts' : 'data';
                if (data[targetKey]) data[targetKey] = Utils.deserializeData(data[targetKey], data.dictionary);
                delete data.dictionary;
            }
            if (data && data.data && typeof data.data === 'object' && !data.posts) data = data.data;
        }

        if (sidecar && CONSTANTS.INTERACTION_ENDPOINTS.has(actionName)) {
            applySidecarInMemory(data, sidecar);
        }

        if (cacheDur) {
            if (_state.requestCache.size >= CONSTANTS.CACHE_LIMIT) {
                const oldest = _state.requestCache.keys().next().value;
                _state.requestCache.delete(oldest);
            }
            _state.requestCache.set(cacheKey, { data, timestamp: Date.now() });
        }

        if (actionName === 'getFollowingActivities' && data) {
            try {
                await interceptAndPersistActivities(data, 'polling');
            } catch (err) {
                handleLog(`Polling DB Persist Error: ${err.message}`, 'Worker', 'error', CONSTANTS.LOG_ICON);
            }
        }

        self.postMessage({ action: successAction, payload: data, originalPayload: payload });

    } catch (error) {
        const errorMsg = Core.toSafeString(error);
        if (error.message === 'InvalidToken') return;

        const isNetworkError = errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkRequestFailed') || errorMsg.includes('NetworkTimeout') || errorMsg.includes('OfflineModeActive') || error.name === 'AbortError';
        
        if (actionName === 'checkHealth') return;
        
        if (isNetworkError && _getResilienceManager() && !FORCE_DISABLE_RESILIENCE) {
            if (!_getResilienceManager().isOffline) _getResilienceManager().enterOfflineMode(ctx);
            const uid = Core.deriveResourceUid(actionName, payload);
            if (uid) {
                const rawArtifact = await _getResilienceManager().fetchArtifact(ctx, uid);
                if (rawArtifact) {
                    const fallbackData = rawArtifact.data || rawArtifact;
                    if (CONSTANTS.INTERACTION_ENDPOINTS.has(actionName)) {
                        if (ctx.token) {
                            const db = await ensureFallbackDB();
                            if (db) {
                                if (fallbackData.posts) fallbackData.posts = await db.applyUserInteractions(fallbackData.posts);
                                else if (fallbackData.comments?.list) fallbackData.comments.list = await db.applyUserInteractions(fallbackData.comments.list);
                            }
                        }
                    }
                    fallbackData._is_offline = true;
                    self.postMessage({ action: successAction, payload: fallbackData, originalPayload: payload });
                    return;
                }
            }
        }
        
        if (isNetworkError && !CONSTANTS.RESILIENCE_WHITELIST.has(actionName)) {
            return self.postMessage({ action: successAction, payload: null, originalPayload: payload, _silent_fail: true });
        }
        
        if (payload.errorAction) {
            // Prefer the parsed response body (error.details) over a plain message string.
            // This preserves structured fields like status, error_code, and message so that
            // the main-thread responseHandler can pattern-match the backend's error envelope
            // rather than receiving an opaque string that it cannot recognise as an error.
            const errorPayload = (error && error.details) ? error.details : { message: errorMsg };
            self.postMessage({ action: payload.errorAction, payload: errorPayload, originalPayload: payload });
        } else {
            self.postMessage({ action: 'error', payload: { action: actionName, message: errorMsg }, originalPayload: payload });
        }
    }
};

/**
 * Primary message dispatch loop for the Service Worker.
 *
 * Receives all `postMessage` calls from the main thread and routes them to the
 * appropriate handler. Actions are processed in priority order:
 *
 * 1. `setVaultPepper`          — Stores the chat encryption pepper and forwards it to ChatWorker.
 * 2. `chat*`                   — Delegated to ChatWorker after ensuring WASM modules are ready.
 * 3. `peerConnectionStatus`    — Updates ResilienceManager peer-ready state.
 * 4. `getResilienceStatus`     — Returns current mode and kill-switch state.
 * 5. `applyResilienceBootstrap`— Manually applies a bootstrap header value.
 * 6. `trackerSwarmUpdate`      — Updates ResilienceManager from Trystero swarm count.
 * 7. `p2pServeRequest`         — Serves a cached artifact to a requesting peer.
 * 8. `init`                    — Stores configuration and triggers the initial health-check handshake.
 * 9. `verifyP2PArtifact`       — Routes an incoming P2P binary to ResilienceManager for verification.
 * 10. `fetchProxy`             — Proxies an arbitrary same-origin request through `handleFetch`.
 * 11. `subscribePush` / `unsubscribePush` — Push subscription management via ApiEndpoints.
 * 12. `setSessionUser`         — Stores the authenticated user for activity persistence.
 * 13. `fetchActivitiesFromDB`  — Returns persisted activities for the current user.
 * 14. `saveActivity`           — Persists one or more activity items to IndexedDB.
 * 15. `checkPushSubscription`  — Checks whether a valid push subscription hash exists.
 * 16. `registerPushSuccess`    — Stores a new push subscription hash after registration.
 * 17. `clearSessionData`       — Resets session-scoped state and notifies ChatWorker.
 * 18. `initSSE`                — Initialises the SSE connection and registers message handlers.
 * 19. `closeSSE`               — Gracefully closes the SSE connection.
 * 20. `processAvatar`          — Crops and converts an avatar image via WASM.
 * 21. `parseMarkdown`          — Converts a Markdown string to HTML via WASM.
 * 22. `ApiEndpoints[action]`   — Falls through to the generic ApiEndpoints dispatcher.
 *
 * @listens MessageEvent
 */
self.addEventListener('message', async (event) => {
    try {
        const { action, payload, originalAction } = event.data;

        if (action === 'setVaultPepper') {
            _state.vaultPepper = payload.vaultPepper;
            _state.isCustomPepper = true;
            handleLog(`[Worker] 🔑 Manual vaultPepper received. Routing to ChatWorker...`, 'Worker', 'info', CONSTANTS.LOG_ICON);
            
            const chatModule = await ensureChatWorker();
            if (chatModule) {
                const vaultCtx = {
                    postMessage:    (msg) => self.postMessage(msg),
                    token:          _state.token,
                    pepperDB:       payload.vaultPepper,
                    isCustomPepper: true,
                };
                await chatModule.handleAction(vaultCtx, 'chatSetVaultPepper', { vaultPepper: payload.vaultPepper, seed: payload.seed });
            }
            return;
        }

        if (action.startsWith('chat')) {
            await Core.ensureMarkdownWasm();
            await Core.ensureImageWasm();
            const chatModule = await ensureChatWorker();
            if (!chatModule) {
                handleLog('Chat action received but ChatWorker is missing.', 'Worker', 'warn', CONSTANTS.LOG_ICON);
                return;
            }

            const ctx = {
                postMessage: (msg) => self.postMessage(msg),
                token: _state.token,
                cid: _state.cid,
                pepperDB: _state.vaultPepper,
                isCustomPepper: _state.isCustomPepper,
                parseMarkdown: parse_markdown,
                processImage: process_image,
                processResize: resize_to_max_width
            };

            await chatModule.handleAction(ctx, action, payload);
            return;
        }

        if (action === 'peerConnectionStatus') {
            if (_getResilienceManager()) _getResilienceManager().setPeerReadyState(payload.ready);
            return;
        }

        if (action === 'getResilienceStatus') {
            const currentMode = (_getResilienceManager() && typeof _getResilienceManager().getMode === 'function')
                ? _getResilienceManager().getMode()
                : (FORCE_DISABLE_RESILIENCE ? 'DISABLED' : 'HYBRID');

            self.postMessage({ 
                action: 'resilienceStatusResponse', 
                payload: { 
                    allowed: !FORCE_DISABLE_RESILIENCE,
                    mode: currentMode
                } 
            });
            return;
        }

        if (action === 'applyResilienceBootstrap') {
            await ensureResilienceManager();
            await ensureResilienceCrypto();
            if (payload.headerValue) {
                await Core.applyResilienceBootstrap(payload.headerValue, payload.token || _state.token);
            }
            return;
        }

        if (action === 'trackerSwarmUpdate') {
             if (_getResilienceManager()) {
                 const isReady = payload.count > 0;
                 _getResilienceManager().setPeerReadyState(isReady, 'trystero');
             }
             return;
        }

        if (action === 'p2pServeRequest') {
            if (FORCE_DISABLE_RESILIENCE) return;
            const { peerId, requestId, uid, transport } = payload;
            try {
                handleLog(`P2P OUT | Serving REQ: ${uid} -> Peer: ${peerId} (Transport: ${transport})`, 'Worker', 'info', CONSTANTS.LOG_ICON);
                const db = await ensureFallbackDB();
                const artifact = db ? await db.getPublicArtifactForPeer(uid) : null;
                if (artifact && artifact.rawArtifact) {
                    handleLog(`P2P OUT | Sending Data: ${artifact.rawArtifact.byteLength} bytes -> Peer: ${peerId}`, 'Worker', 'info', CONSTANTS.LOG_ICON);
                    if (transport === 'trystero') {
                        self.postMessage({ action: 'trackerSendArtifact', payload: { peerId, data: artifact.rawArtifact } }, [artifact.rawArtifact]); 
                    } else {
                        self.postMessage({ action: 'p2pSendBinary', payload: { peerId, buffer: artifact.rawArtifact } }, [artifact.rawArtifact]); 
                    }
                } else {
                    handleLog(`P2P | Artifact not found for UID: ${uid}. Notifying peer.`, 'Worker', 'warn', CONSTANTS.LOG_ICON);
                    self.postMessage({ action: 'p2pSendNotFound', payload: { peerId, requestId, uid } });
                }
            } catch (e) {
                handleLog(e, 'Worker', 'error', CONSTANTS.LOG_ICON);
            }
            return;
        }

        if (action === 'init') {
            let cleanUrl = payload.apiUrl;
            if (cleanUrl && cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);
            _state.sharedIp       = payload.ip;
            _state.sharedLocation = payload.location;
            _state.apiUrl         = cleanUrl;
            _state.cid            = payload.cid;
            _state.token          = payload.token;
            _state.features       = payload.features || {};
            _state.plugins        = payload.plugins  || [];

            // Register the plugin manifest before any ensure* call so that
            // every subsequent lazy-load resolves the path from conf, not from
            // a hardcoded string.
            PluginRegistry.register(_state.plugins);

            if (_state.features.resilience || _state.features.p2p) {
                ensureResilienceManager();
                ensureResilienceCrypto();
            }
            if (_state.features.resilience) {
                ensureFallbackDB();
            }
            ensureActivitiesDB();

            const mockCtx = {
                postMessage: (msg) => self.postMessage(msg),
                apiUrl:         _state.apiUrl,
                token:          _state.token,
                cid:            _state.cid,
                sharedIp:       _state.sharedIp,
                sharedLocation: _state.sharedLocation,
                fetch:          handleFetch
            };
            await Core.performInitialHealthCheck(mockCtx);
            return;
        }

        if (action === 'verifyP2PArtifact') {
            const { buffer, peerId, source } = payload;
            try {
                if (buffer) {
                    const size = buffer.byteLength || 0;
                    const isSwarm = source && source.startsWith('line3_');
                    const iconSwarm = isSwarm ? '🐝' : '⚡';
                    const label = isSwarm ? 'SWARM (L3)' : 'DIRECT (L2)';
                    const finalSource = source || 'P2P';
                    handleLog(`P2P IN | ${label} | Source: ${finalSource} | Peer: ${peerId} | Size: ${size} bytes`, 'Worker', 'log', `👷 ${iconSwarm}`);
                    if (_getResilienceManager()) await _getResilienceManager().processIncomingP2PArtifact(buffer, peerId);
                }
            } catch (e) {
                handleLog(e, 'Worker', 'error', CONSTANTS.LOG_ICON);
            }
            return;
        }

        if (action === 'fetchProxy') {
            const { endpoint, method, headers, body, responseAction } = payload;
            const fullUrl = endpoint.startsWith('http') ? endpoint : `${_state.apiUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
            const opts = { method, headers };
            if (method !== 'GET' && method !== 'HEAD' && body) opts.body = typeof body === 'object' ? JSON.stringify(body) : body;
            handleFetch('fetchProxy', fullUrl, opts, responseAction || 'proxySuccess', null, payload);
            return;
        }

        if (action === 'subscribePush' || action === 'unsubscribePush') {
            const ctx = {
                postMessage: (msg) => self.postMessage(msg),
                apiUrl: _state.apiUrl,
                token: payload.token || _state.token,
                cid: payload.cid || _state.cid,
                fetch: handleFetch
            };
            
            if (ApiEndpoints[action]) {
                handleLog(`Worker executing push action: ${action}`, 'Worker', 'info', '👷🛎️');
                ApiEndpoints[action](ctx, payload);
            } else {
                handleLog(`Push action ${action} not found in ApiEndpoints`, 'Worker', 'error', '👷🛎️');
            }
            return;
        }

        if (action === 'setSessionUser') {
            _state.currentUser = payload.user || null;
            return;
        }

        if (action === 'fetchActivitiesFromDB') {
            if (!_state.currentUser) {
                self.postMessage({ action: 'activitiesReturned', payload: [] });
                return;
            }
            try {
                const db = await ensureActivitiesDB();
                const data = db ? await db.getActivities(_state.currentUser) : [];
                self.postMessage({ action: 'activitiesReturned', payload: data });
            } catch (e) {
                handleLog(`DB Read Error: ${e.message}`, 'Worker', 'error', CONSTANTS.LOG_ICON);
                self.postMessage({ action: 'activitiesReturned', payload: [] });
            }
            return;
        }

        if (action === 'saveActivity') {
            if (_state.currentUser && payload) {
                ensureActivitiesDB().then(db => {
                    if (db) {
                        const items = Array.isArray(payload) ? payload : [payload];
                        db.addActivities(items, _state.currentUser)
                            .catch(e => handleLog(`Save Activity Error: ${e.message}`, 'Worker', 'error', CONSTANTS.LOG_ICON));
                    }
                });
            }
            return;
        }

        if (action === 'checkPushSubscription') {
            const db = await ensureActivitiesDB();
            const hash = (db && _state.currentUser) ? await db.getPushHash(_state.currentUser) : null;
            self.postMessage({ action: 'pushSubscriptionStatus', payload: { isValid: !!hash, hash } });
            return;
        }

        if (action === 'registerPushSuccess') {
            const db = await ensureActivitiesDB();
            if (db && _state.currentUser && payload.hash) {
                await db.savePushHash(_state.currentUser, payload.hash);
            }
            return;
        }

        if (action === 'clearSessionData') {
            _state.currentUser = null;
            _state.vaultPepper = null;
            _state.isCustomPepper = false;
            
            ensureChatWorker().then(chatModule => {
                if (chatModule) {
                    chatModule.handleAction({ postMessage: (msg) => self.postMessage(msg) }, 'chatClearEncryptionSeed', {});
                }
            }).catch(() => {});

            self.postMessage({ action: 'sessionCleared' });
            return;
        }

        if (action === 'initSSE') {
            if (!_isInitialized && _initializationPromise) await _initializationPromise;
            await ensureSSEService();
            if (!_getSSEService()) return;

            const ctx = { 
                token: payload.token || _state.token, 
                cid: payload.cid || _state.cid, 
                apiUrl: _state.apiUrl,
                sse: {
                    init: (p) => {
                         _getSSEService().init(_state.apiUrl, p, {
                            onOpen: () => self.postMessage({ action: 'sseConnected', payload: { status: 'open' } }),
                            onMessage: async (e) => {
                                try {
                                    const d = JSON.parse(e.data);
                                    
                                    if (d.type === 'resilience_handshake') {
                                        const manager = await ensureResilienceManager();
                                        const cryptoMod = await ensureResilienceCrypto();
                                        if (d.data?.publicKey && cryptoMod) {
                                            await cryptoMod.updateTrustedKey({
                                                publicKey: d.data.publicKey,
                                                expiresAt: d.data.expiresAt || ((Date.now()/1000) + 86400)
                                            });
                                        }
                                        if (manager && !FORCE_DISABLE_RESILIENCE && d.data?.peers) {
                                            manager.ingestLivePeers(d.data.peers, d.data.self?.peerId);
                                        }
                                    } else {
                                        await interceptAndPersistActivities(d, 'sse');
                                    }
                                    
                                    self.postMessage({ action: 'SSE_MESSAGE', payload: d });
                                } catch (err) { 
                                    handleLog(`SSE Worker Error: ${err.message}`, 'Worker', 'error', CONSTANTS.LOG_ICON);
                                    self.postMessage({ action: 'SSE_MESSAGE', payload: { raw: e.data, error: err.message } }); 
                                }
                            },
                            onError: (rs) => self.postMessage({ action: 'sseError', payload: { readyState: rs } }),
                            onInitError: (e) => self.postMessage({ action: 'error', payload: { message: 'SSE Init Error', details: e.message } })
                        });
                    },
                    close: () => _getSSEService().close({ onClose: () => self.postMessage({ action: 'sseDisconnected' }) })
                }
            };
            ctx.sse.init(payload);
            return;
        }
        
        if (action === 'closeSSE') {
            await ensureSSEService();
            if (_getSSEService()) _getSSEService().close({ onClose: () => self.postMessage({ action: 'sseDisconnected' }) });
            return;
        }

        if (action === 'processAvatar') {
            try {
                await Core.ensureImageWasm();
                const resultCropBytes = process_image(payload.fileBytes, Math.floor(payload.cropData.x), Math.floor(payload.cropData.y), Math.floor(payload.cropData.width), Math.floor(payload.cropData.height), 'webp');
                const resultBytes = resize_to_max_width(resultCropBytes, payload.cropData.targetWidth);

                self.postMessage({ action: 'avatarProcessed', payload: { blob: new Blob([resultBytes], { type: 'image/webp' }), imageType: payload.imageType }, originalAction });
            } catch (e) { self.postMessage({ action: 'error', payload: { message: 'Image processing failed: ' + e.message } }); }
            return;
        }

        if (action === 'parseMarkdown') {
            try {
                await Core.ensureMarkdownWasm();
                self.postMessage({ action: 'markdownParsed', payload: { id: payload.id, html: parse_markdown(payload.text) }, originalAction });
            } catch (e) { self.postMessage({ action: 'error', payload: { message: 'Markdown processing failed: ' + e.message } }); }
            return;
        }

        if (ApiEndpoints[action]) {
            if (!_isInitialized && action !== 'checkHealth' && _initializationPromise) await _initializationPromise;
            
            const ctx = {
                postMessage: (msg) => self.postMessage(msg),
                apiUrl: _state.apiUrl,
                token: payload.token || _state.token,
                cid: payload.cid || _state.cid,
                fetch: handleFetch,
                handlers: {
                    commentResponse: async (response, successAction, originalPayload) => {
                        if (response.status === 401) {
                            return self.postMessage({ 
                                action: 'invalidToken', 
                                payload: { message: 'Invalid token' }, 
                                originalPayload, 
                                originalAction: successAction 
                            });
                        }
                        const data = await response.json();
                        self.postMessage({ 
                            action: successAction, 
                            payload: { 
                                ...data, 
                                entityId: originalPayload.entityId,
                                replyId: originalPayload.replyId,
                                isEdit: originalPayload.isEdit 
                            } 
                        });
                    }
                }
            };
            try {
                ApiEndpoints[action](ctx, payload);
            } catch (e) {
                self.postMessage({ action: 'error', payload: { message: 'Action Error', details: Core.toSafeString(e) } });
            }
        }
    } catch (globalError) {
        handleLog(globalError, 'Worker', 'error', CONSTANTS.LOG_ICON);
    }
});