/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/remoteConfig.js */
/**
 * @module Core/RemoteConfig
 * @description Fetches, caches, and restores widget configuration from the public API.
 *
 * Strategy:
 *  1. Read from localStorage (encrypted with AES-GCM keyed by CID).
 *     - If fresh (< FRESHNESS_MS): apply immediately, skip network.
 *     - If stale: attempt network refresh in the foreground.
 *       - On success: persist new config, apply.
 *       - On failure: apply stale config (resilience — system still boots).
 *  2. No localStorage entry: fetch is mandatory.
 *     - On success: persist and apply.
 *     - On failure: throw — init() is blocked (no reasonable fallback exists).
 *
 * The CID is used as the encryption secret. It is always available as the
 * minimum required field in window.QUELORA_CONFIG, so no auth token is needed.
 * SecurityModule (AES-GCM + PBKDF2) provides authenticated encryption, which
 * prevents both reading and tampering of the stored payload.
 *
 * @version 1.0.0
 */
import handleLog from './logs.js';

const STORAGE_KEY    = 'ql_widget_config';
const FRESHNESS_MS   = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT  = 5000;            // 5 seconds
const LOG_ICON       = '⚙️';
const LOG_CONTEXT    = 'RemoteConfig';

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Fetches the widget configuration from the public API.
 *
 * @param {string} cid    - Client identifier, sent as X-Client-Id header.
 * @param {string} apiUrl - Base URL of the public API.
 * @returns {Promise<Object|null>} Config object, or null on any failure.
 */
const _fetch = async (cid, apiUrl) => {
    try {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const response = await fetch(`${apiUrl}/config`, {
            headers: { 'X-Client-Id': cid },
            signal:  controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            handleLog(`/config returned ${response.status}`, LOG_CONTEXT, 'warn', LOG_ICON);
            return null;
        }

        return await response.json();
    } catch (error) {
        handleLog(error, `${LOG_CONTEXT}._fetch`, 'warn', LOG_ICON);
        return null;
    }
};

/**
 * Encrypts and persists the config payload in localStorage.
 * Stored without a StorageModule TTL — freshness is managed via the
 * embedded `fetchedAt` timestamp so stale entries survive for resilience.
 *
 * @param {Object}        config          - The raw config object from the API.
 * @param {string}        cid             - Used as the AES-GCM encryption secret.
 * @param {object}        StorageModule
 * @param {object}        SecurityModule
 */
const _persist = async (config, cid, StorageModule, SecurityModule) => {
    try {
        const payload   = JSON.stringify({ config, fetchedAt: Date.now() });
        const encrypted = await SecurityModule.encrypt(payload, cid);
        if (encrypted) {
            StorageModule.setLocalItem(STORAGE_KEY, encrypted);
            handleLog('Widget config persisted.', LOG_CONTEXT, 'log', LOG_ICON);
        }
    } catch (error) {
        // Non-fatal: if storage fails the config is still applied in-memory.
        handleLog(error, `${LOG_CONTEXT}._persist`, 'warn', LOG_ICON);
    }
};

/**
 * Reads and decrypts the stored config entry.
 *
 * @param {string} cid            - Decryption secret.
 * @param {object} StorageModule
 * @param {object} SecurityModule
 * @returns {Promise<{ config: Object, fetchedAt: number }|null>}
 */
const _readCache = async (cid, StorageModule, SecurityModule) => {
    try {
        const raw = StorageModule.getLocalItem(STORAGE_KEY);
        if (!raw) return null;

        const decrypted = await SecurityModule.decrypt(raw, cid);
        if (!decrypted) {
            handleLog('Cache decryption failed. Purging.', LOG_CONTEXT, 'warn', LOG_ICON);
            StorageModule.removeLocalItem(STORAGE_KEY);
            return null;
        }

        return JSON.parse(decrypted);
    } catch (error) {
        handleLog(error, `${LOG_CONTEXT}._readCache`, 'warn', LOG_ICON);
        StorageModule.removeLocalItem(STORAGE_KEY);
        return null;
    }
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Bootstraps the remote configuration before the widget initialises.
 * Must be awaited as the first step inside `Quelora.init()`, after CID and
 * apiUrl are read from the minimal local window.QUELORA_CONFIG.
 *
 * On success, `ConfModule.updateConfig(remoteConfig)` is called so that
 * every subsequent `ConfModule.get()` call in the rest of `init()` reflects
 * the full server-side configuration.
 *
 * On irrecoverable failure (no cache + unreachable server), throws so that
 * `init()` halts and the widget does not boot with default/incomplete config.
 *
 * @param {string} cid           - Client identifier (from minimal local config).
 * @param {string} apiUrl        - API base URL (from minimal local config).
 * @param {object} StorageModule - Widget storage abstraction.
 * @param {object} ConfModule    - Widget configuration module.
 * @param {object} SecurityModule- Widget cryptography module.
 * @throws {Error} When no config is available from either cache or network.
 */
const bootstrapRemoteConfig = async (cid, apiUrl, StorageModule, ConfModule, SecurityModule) => {
    const cached = await _readCache(cid, StorageModule, SecurityModule);

    if (cached) {
        const isFresh = (Date.now() - cached.fetchedAt) < FRESHNESS_MS;

        if (isFresh) {
            handleLog('Using fresh cached config.', LOG_CONTEXT, 'log', LOG_ICON);
            ConfModule.updateConfig(cached.config);
            return;
        }

        // Stale: attempt a foreground refresh.
        handleLog('Cached config is stale. Refreshing.', LOG_CONTEXT, 'log', LOG_ICON);
        const fetched = await _fetch(cid, apiUrl);

        if (fetched) {
            await _persist(fetched, cid, StorageModule, SecurityModule);
            ConfModule.updateConfig(fetched);
            return;
        }

        // Refresh failed — boot with stale config (resilience).
        handleLog('Refresh failed. Booting with stale config.', LOG_CONTEXT, 'warn', LOG_ICON);
        ConfModule.updateConfig(cached.config);
        return;
    }

    // No cache: fetch is mandatory.
    handleLog('No cached config. Fetching from API.', LOG_CONTEXT, 'log', LOG_ICON);
    const fetched = await _fetch(cid, apiUrl);

    if (fetched) {
        await _persist(fetched, cid, StorageModule, SecurityModule);
        ConfModule.updateConfig(fetched);
        return;
    }

    throw new Error(
        'Widget configuration unavailable: server unreachable and no local cache found. ' +
        'Ensure the API is accessible on first load.'
    );
};

export default bootstrapRemoteConfig;
