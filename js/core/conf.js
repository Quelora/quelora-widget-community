/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/core/conf.js */
/**
 * @module Core/Conf
 * @description Centralised configuration manager for the Quelora SDK.
 *
 * Design decisions:
 * - `DEFAULT_CONFIG` defines the complete contract for every supported key.
 *   Any key absent from the integrator-supplied `window.QUELORA_CONFIG` is
 *   transparently back-filled from these defaults.
 * - Initialisation is performed eagerly at module load time via {@link _autoInit}
 *   so that every downstream import receives a fully resolved config object
 *   without an explicit async handshake. The integrator must place
 *   `window.QUELORA_CONFIG` in a `<script>` tag that executes before the SDK bundle.
 * - `deepMerge` replaces arrays wholesale (source wins) and recurses into plain
 *   objects, matching the most common configuration override pattern.
 * - All public accessors return deep clones or primitives so that callers cannot
 *   mutate internal state by accident.
 *
 * ## External session mode (`login.queloraSession = false`)
 *
 * When an external identity provider (e.g. WordPress SSO) manages the user
 * session, the integrator sets `login.queloraSession` to `false`. This flag is
 * the single switch read by `GuardModule` and `SessionModule` to decide whether
 * to engage the Quelora internal authentication circuit (login modal, registration,
 * social providers) or defer entirely to the external provider.
 *
 * In external-session mode the SDK expects:
 *  - `login.loginUrl`  — The external login page URL (without `redirect_to`; the
 *    consuming module appends `?redirect_to=<current href>` at call-time so that
 *    the URL hash anchor is always preserved).
 *  - `login.logoutUrl` — The external logout URL (fully formed, including any
 *    server-side nonce). The consuming module navigates directly to this URL.
 *  - `login.isLoggedIn` — Whether the current visitor has an active external
 *    session. Populated server-side to allow the SDK to skip the auth flow on
 *    initial page load without an extra round-trip.
 *
 * ## GIF support in comment inputs (`comments.allowGif`)
 *
 * When `comments.allowGif` is `true`, the comment and edit input elements are
 * instrumented with a `beforeinput` listener that intercepts animated GIFs
 * delivered by Gboard and other system keyboards via `inputType === 'insertContent'`.
 * GIF preview nodes are rendered inline but are **excluded from the character
 * counter** — they consume zero characters of the configured `maxlength` budget.
 * The integrator must handle GIF upload at submit time by calling
 * `UtilsModule.extractGifsFromEditable(inputElement)`.
 *
 * @version 3.2.0
 */
import handleLog from './logs.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const LOG_ICON    = '🏠';
const LOG_CONTEXT = 'ConfModule';

/**
 * Complete default configuration object.
 * Every key that the SDK may read must be represented here so that
 * {@link get} always has a well-typed fallback.
 *
 * @type {QueloraConfig}
 */
const DEFAULT_CONFIG = {
    cid:          null,
    apiUrl:       'https://api.quelora.org',
    assetBaseUrl: 'https://api.quelora.org',

    login: {
        /**
         * When `true` (default), the Quelora internal authentication circuit
         * is fully active: login modal, registration flow, social providers,
         * and token management are all handled by the SDK.
         *
         * When `false`, the internal circuit is disabled. The SDK redirects
         * unauthenticated users to `loginUrl` and delegates logout to
         * `logoutUrl`. This flag is set to `false` manually by the integrator
         * in `window.QUELORA_CONFIG` when using an external session provider.
         */
        queloraSession: true,

        /**
         * External login page URL. Required when `queloraSession` is `false`.
         * Must not include a `redirect_to` parameter — the consuming module
         * appends `?redirect_to=encodeURIComponent(window.location.href)` at
         * call-time to preserve the current URL hash anchor.
         *
         * @type {string}
         */
        loginUrl: '',

        /**
         * External logout URL. Required when `queloraSession` is `false`.
         * The consuming module navigates directly to this URL. Must include
         * any parameters required by the external provider (e.g. `action=logout`).
         *
         * @type {string}
         */
        logoutUrl: '',

        baseUrl:         'https://api.quelora.org/',
        providers:       ['Default'],
        providerDetails: {
            Default: {
                clientId: 'default-client-id'
            }
        }
    },

    /**
     * Comment input behaviour settings.
     *
     * @type {CommentsConfig}
     */
    comments: {
        /**
         * When `true`, the comment and edit input elements accept animated GIFs
         * from Gboard and other system keyboards. GIF files are captured via the
         * `beforeinput` event (`inputType === 'insertContent'`) and rendered as
         * inline preview nodes that are **excluded from the character count**.
         *
         * This flag is `false` by default. Enable it only when the server-side
         * comment API is able to receive and store GIF attachments. At submit
         * time the integrator must call `UtilsModule.extractGifsFromEditable`
         * to retrieve the `File` objects and revoke their Object URLs before
         * sending the payload.
         *
         * @type {boolean}
         */
        allowGif: true
    },

    audio: {
        enable_mic_transcription: true,
        save_comment_audio:       true,
        max_recording_seconds:    30
    },

    geolocation: {
        enabled:  false,
        provider: 'none'
    },

    vapid: {
        publicKey:   null,
        iconBase64:  'data:image/png;base64,default-icon'
    },

    sse: {
        ticketEndpoint: '/notifications/ticket',
        streamEndpoint: '/notifications/stream'
    },

    nostrRelays: [
        'wss://relay.primal.net'
    ],

    trackerUrls: [
        'wss://tracker.openwebtorrent.com'
    ],

    rtcServers: [
        'stun:stun.l.google.com:19302'
    ],

    plugins: {
        ui:     [],
        worker: []
    }
};

// =============================================================================
// PRIVATE STATE
// =============================================================================

/** @type {QueloraConfig} */
let _config = {};

/** @type {boolean} */
let _isInitialized = false;

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Recursively merges `source` into `target`, returning a new object.
 *
 * Merge rules:
 * - Arrays: source value replaces target value entirely.
 * - Plain objects: merged recursively.
 * - All other types: source value replaces target value.
 *
 * @param {Record<string, unknown>} target - Base object (typically the defaults).
 * @param {Record<string, unknown>} source - Override object (typically integrator config).
 * @returns {Record<string, unknown>} Merged result (new object, neither argument is mutated).
 */
const _deepMerge = ( target, source ) => {
    const output = { ...target };

    for ( const key of Object.keys( source ) ) {
        const sourceVal = source[ key ];
        const targetVal = target[ key ];

        if ( Array.isArray( sourceVal ) ) {
            output[ key ] = sourceVal;
        } else if (
            sourceVal !== null &&
            typeof sourceVal === 'object' &&
            targetVal !== null &&
            typeof targetVal === 'object' &&
            ! Array.isArray( targetVal )
        ) {
            output[ key ] = _deepMerge(
                /** @type {Record<string, unknown>} */ ( targetVal ),
                /** @type {Record<string, unknown>} */ ( sourceVal )
            );
        } else {
            output[ key ] = sourceVal;
        }
    }

    return output;
};

/**
 * Traverses a nested object using a dot-separated key path.
 *
 * Returns `defaultValue` when any intermediate key is absent or nullish,
 * ensuring that callers never receive `undefined`.
 *
 * @param {string}                  keyPath      - Dot-separated path (e.g. `'login.queloraSession'`).
 * @param {Record<string, unknown>} configObj    - Object to traverse.
 * @param {unknown}                 defaultValue - Fallback value.
 * @returns {unknown} Resolved value or `defaultValue`.
 */
const _getValueFromConfig = ( keyPath, configObj, defaultValue ) => {
    const keys = keyPath.split( '.' );
    let value  = configObj;

    for ( const key of keys ) {
        if ( value === null || value === undefined || ! Object.prototype.hasOwnProperty.call( value, key ) ) {
            return defaultValue;
        }
        value = /** @type {Record<string, unknown>} */ ( value )[ key ];
    }

    return value !== undefined ? value : defaultValue;
};

/**
 * Reads `window.QUELORA_CONFIG` (if present), deep-merges it over
 * {@link DEFAULT_CONFIG}, and marks the module as initialised.
 *
 * Called once, synchronously, at module evaluation time.
 * Any exception during merging is caught so that the module always ends up
 * in a usable state (defaults) rather than leaving `_isInitialized` as `false`.
 */
const _autoInit = () => {
    try {
        const globalConfig =
            typeof window !== 'undefined' && window.QUELORA_CONFIG != null
                ? window.QUELORA_CONFIG
                : {};

        _config = _deepMerge( DEFAULT_CONFIG, globalConfig );

        if ( ! _config.cid ) {
            handleLog(
                'No client ID (cid) provided. Using null. SDK features requiring cid will be unavailable.',
                LOG_CONTEXT,
                'warn',
                LOG_ICON
            );
        }

        _isInitialized = true;
        handleLog( 'Configuration initialised.', LOG_CONTEXT, 'log', LOG_ICON );
    } catch ( error ) {
        handleLog( error, LOG_CONTEXT, 'error', LOG_ICON );
        _config        = { ...DEFAULT_CONFIG };
        _isInitialized = true;
    }
};

// =============================================================================
// MODULE INITIALISATION
// =============================================================================

_autoInit();

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Resolves a configuration value by dot-separated key path.
 *
 * When the resolved value is `undefined` or the path does not exist,
 * the function falls back first to the integrator-merged config, then
 * to {@link DEFAULT_CONFIG}, and finally to `defaultValue`.
 *
 * @param {string}  keyPath             - Dot-separated key path (e.g. `'login.queloraSession'`).
 * @param {unknown} [defaultValue=null] - Value returned when the path cannot be resolved.
 * @returns {unknown} Resolved configuration value.
 */
const get = ( keyPath, defaultValue = null ) => {
    if ( ! _isInitialized ) {
        handleLog(
            `Config not initialised. Reading "${keyPath}" from defaults.`,
            LOG_CONTEXT,
            'warn',
            LOG_ICON
        );
        return _getValueFromConfig( keyPath, DEFAULT_CONFIG, defaultValue );
    }

    try {
        const value = _getValueFromConfig( keyPath, _config, undefined );
        if ( value !== undefined ) return value;
        return _getValueFromConfig( keyPath, DEFAULT_CONFIG, defaultValue );
    } catch ( error ) {
        handleLog(
            `Failed to resolve config path "${keyPath}". Falling back to default.`,
            LOG_CONTEXT,
            'warn',
            LOG_ICON
        );
        return _getValueFromConfig( keyPath, DEFAULT_CONFIG, defaultValue );
    }
};

/**
 * Returns a deep clone of the fully resolved configuration object.
 *
 * The clone prevents callers from mutating internal state.
 * Use {@link get} for single-key access to avoid the cost of a full clone.
 *
 * @returns {QueloraConfig} Deep clone of the current configuration.
 */
const getAll = () => {
    if ( ! _isInitialized ) {
        handleLog(
            'Config not initialised. Returning default config.',
            LOG_CONTEXT,
            'warn',
            LOG_ICON
        );
        return JSON.parse( JSON.stringify( DEFAULT_CONFIG ) );
    }
    return JSON.parse( JSON.stringify( _config ) );
};

/**
 * Deep-merges a partial configuration object into the current config at runtime.
 *
 * Intended for use-cases where the integrator needs to update config values
 * after initial page load (e.g. after a user logs in and server-side config
 * becomes available).
 *
 * @param {Partial<QueloraConfig>} customConfig - Partial configuration to apply.
 * @returns {boolean} `true` if the update succeeded, `false` on error.
 */
const updateConfig = ( customConfig ) => {
    if ( ! customConfig || typeof customConfig !== 'object' || Array.isArray( customConfig ) ) {
        handleLog(
            'updateConfig received an invalid argument. Expected a plain object.',
            LOG_CONTEXT,
            'warn',
            LOG_ICON
        );
        return false;
    }

    try {
        _config = _deepMerge( _config, customConfig );
        handleLog( 'Configuration updated dynamically.', LOG_CONTEXT, 'log', LOG_ICON );
        return true;
    } catch ( error ) {
        handleLog( error, LOG_CONTEXT, 'error', LOG_ICON );
        return false;
    }
};

/**
 * Returns a deep clone of the original {@link DEFAULT_CONFIG}.
 *
 * Useful for integrators who want to inspect the full set of supported keys
 * and their default values without modifying live state.
 *
 * @returns {QueloraConfig} Deep clone of the default configuration.
 */
const getDefaultConfig = () => JSON.parse( JSON.stringify( DEFAULT_CONFIG ) );

/**
 * Returns whether the module has been successfully initialised.
 *
 * @returns {boolean}
 */
const isInitialized = () => _isInitialized;

// =============================================================================
// TYPEDEFS (for IDE support — not enforced at runtime)
// =============================================================================

/**
 * @typedef {Object} PluginManifest
 * @property {string} name - The logical identifier of the plugin.
 * @property {string} path - The relative path to the module entry point.
 */

/**
 * @typedef {Object} PluginsConfig
 * @property {PluginManifest[]} ui     - Plugins injected into the main UI thread.
 * @property {PluginManifest[]} worker - Plugins injected into the background Worker thread.
 */

/**
 * @typedef {Object} LoginConfig
 * @property {boolean}                  queloraSession  - When false, disables the internal
 *   auth circuit and delegates to `loginUrl` / `logoutUrl`.
 * @property {string}                   loginUrl        - External login page URL
 *   (without `redirect_to`; the consumer appends it at call-time).
 * @property {string}                   logoutUrl       - External logout URL.
 *   The consumer navigates directly to this URL.
 * @property {string}                   baseUrl         - OAuth redirect base URL.
 * @property {string[]}                 providers       - Enabled provider names.
 * @property {Record<string, Object>}   providerDetails - Provider-specific settings.
 */

/**
 * @typedef {Object} CommentsConfig
 * @property {boolean} allowGif - When `true`, comment inputs accept Gboard GIFs via
 *   `beforeinput`. GIF nodes are excluded from the `maxlength` character count.
 *   Defaults to `false`. Requires server-side GIF upload support.
 */

/**
 * @typedef {Object} AudioConfig
 * @property {boolean} enable_mic_transcription - Whether speech-to-text is enabled.
 * @property {boolean} save_comment_audio       - Whether audio blobs are persisted.
 * @property {number}  max_recording_seconds    - Hard recording limit in seconds.
 */

/**
 * @typedef {Object} GeolocationConfig
 * @property {boolean} enabled  - Whether geolocation is active.
 * @property {string}  provider - GeoIP provider identifier.
 */

/**
 * @typedef {Object} VapidConfig
 * @property {string} publicKey  - VAPID public key for Web Push.
 * @property {string} iconBase64 - Notification icon as a data URI.
 */

/**
 * @typedef {Object} SseConfig
 * @property {string} ticketEndpoint - Endpoint to fetch an SSE auth ticket.
 * @property {string} streamEndpoint - Endpoint for the SSE event stream.
 */

/**
 * @typedef {Object} QueloraConfig
 * @property {string|null}       cid          - Client identifier.
 * @property {string}            apiUrl       - REST API base URL.
 * @property {string}            assetBaseUrl - Asset CDN base URL.
 * @property {LoginConfig}       login        - Login provider and external session settings.
 * @property {CommentsConfig}    comments     - Comment input behaviour settings.
 * @property {AudioConfig}       audio        - Audio recorder settings.
 * @property {GeolocationConfig} geolocation  - Geolocation settings.
 * @property {VapidConfig}       vapid        - Web Push VAPID settings.
 * @property {SseConfig}         sse          - Server-Sent Events settings.
 * @property {string[]}          nostrRelays  - Nostr relay WebSocket URLs.
 * @property {string[]}          trackerUrls  - WebTorrent tracker WebSocket URLs.
 * @property {string[]}          rtcServers   - ICE/STUN server URLs.
 * @property {PluginsConfig}     plugins      - Declarative manifest of Enterprise modules.
 */

// =============================================================================
// MODULE EXPORT
// =============================================================================

const ConfModule = {
    get,
    getAll,
    updateConfig,
    isInitialized,
    getDefaultConfig
};

export default ConfModule;