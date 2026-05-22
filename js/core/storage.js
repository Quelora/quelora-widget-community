/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/storage.js */
/**
 * @module Core/Storage
 * @description Thin wrapper around `localStorage` and `sessionStorage` with
 * optional TTL support and consistent error handling.
 *
 * Design decisions:
 * - Write operations (`setLocalItem`, `setSessionItem`) propagate storage
 *   exceptions to the caller. This is intentional: the appropriate response
 *   to a `QuotaExceededError` is context-dependent and cannot be decided
 *   generically at this layer. Callers that care must wrap in try-catch.
 * - Read operations (`getLocalItem`, `getSessionItem`) never throw. When
 *   storage is unavailable or an entry is malformed, they return `null` and
 *   log a warning so that the application degrades gracefully.
 * - TTL is implemented as a wrapper object `{ value, expiry }` stored as a
 *   JSON string. Entries without an expiry field are treated as permanent.
 *   Expired entries are deleted on first read.
 *
 * @version 1.2.0
 */
import handleLog from './logs.js';

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * @typedef  {Object}      StorageEnvelope
 * @property {string}      value  - The stored string value.
 * @property {number|null} expiry - Unix epoch milliseconds at which the entry expires, or `null` for permanent entries.
 */

// =============================================================================
// MODULE
// =============================================================================

const StorageModule = {

    // =========================================================================
    // SESSION STORAGE
    // =========================================================================

    /**
     * Writes a raw string value to `sessionStorage`.
     *
     * @param {string} key   - Storage key.
     * @param {string} value - String value to store.
     * @throws {DOMException} When `sessionStorage` is unavailable or the quota is exceeded.
     */
    setSessionItem(key, value) {
        try {
            sessionStorage.setItem(key, value);
        } catch (err) {
            handleLog(err, `StorageModule.setSessionItem: ${key}`);
            throw err;
        }
    },

    /**
     * Reads a raw string value from `sessionStorage`.
     *
     * @param {string} key - Storage key.
     * @returns {string|null} The stored value, or `null` when the key is absent or storage is unavailable.
     */
    getSessionItem(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (err) {
            handleLog(err, `StorageModule.getSessionItem: ${key}`);
            return null;
        }
    },

    /**
     * Removes a key from `sessionStorage`.
     *
     * Failures are logged and silently absorbed — a missing key has no
     * operational impact on the caller.
     *
     * @param {string} key - Storage key to remove.
     */
    removeSessionItem(key) {
        try {
            sessionStorage.removeItem(key);
        } catch (err) {
            handleLog(err, `StorageModule.removeSessionItem: ${key}`);
        }
    },

    /**
     * Clears all entries from `sessionStorage`.
     *
     * Used during logout to ensure no sensitive data persists in the tab.
     * Failures are logged and silently absorbed.
     */
    clearSession() {
        try {
            sessionStorage.clear();
            handleLog('Session storage completely cleared.', 'StorageModule', 'info');
        } catch (err) {
            handleLog(err, 'StorageModule.clearSession');
        }
    },

    // =========================================================================
    // LOCAL STORAGE
    // =========================================================================

    /**
     * Writes a string value to `localStorage`, optionally with a TTL.
     *
     * When `ttlMilliseconds` is provided, the value is wrapped in a
     * `{ value, expiry }` envelope so that {@link getLocalItem} can detect
     * and evict expired entries automatically.
     *
     * @param {string}      key                       - Storage key.
     * @param {string}      value                     - String value to store.
     * @param {number|null} [ttlMilliseconds=null]     - Time-to-live in milliseconds. `null` stores permanently.
     * @throws {DOMException} When `localStorage` is unavailable or the quota is exceeded.
     */
    setLocalItem(key, value, ttlMilliseconds = null) {
        try {
            /** @type {StorageEnvelope} */
            const envelope = {
                value,
                expiry: (ttlMilliseconds && typeof ttlMilliseconds === 'number' && ttlMilliseconds > 0)
                    ? Date.now() + ttlMilliseconds
                    : null
            };
            localStorage.setItem(key, JSON.stringify(envelope));
        } catch (err) {
            handleLog(err, `StorageModule.setLocalItem: ${key}`);
            throw err;
        }
    },

    /**
     * Reads a value from `localStorage`, respecting TTL expiration.
     *
     * Returns `null` when:
     * - The key does not exist.
     * - The entry has expired (the key is removed as a side effect).
     * - The stored JSON is malformed (the key is removed as a side effect).
     * - `localStorage` is unavailable.
     *
     * @param {string} key - Storage key.
     * @returns {string|null} The stored value string, or `null`.
     */
    getLocalItem(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;

            let envelope;
            try {
                envelope = JSON.parse(raw);
            } catch {
                handleLog(
                    `Malformed localStorage entry for key "${key}". Removing.`,
                    'StorageModule.getLocalItem',
                    'warn'
                );
                localStorage.removeItem(key);
                return null;
            }

            if (typeof envelope.expiry === 'number' && envelope.expiry !== null) {
                if (Date.now() > envelope.expiry) {
                    localStorage.removeItem(key);
                    return null;
                }
            }

            if (!Object.prototype.hasOwnProperty.call(envelope, 'value')) {
                handleLog(
                    `Invalid envelope structure in localStorage for key "${key}". Removing.`,
                    'StorageModule.getLocalItem',
                    'warn'
                );
                localStorage.removeItem(key);
                return null;
            }

            return envelope.value;

        } catch (err) {
            handleLog(err, `StorageModule.getLocalItem: ${key}`);
            return null;
        }
    },

    /**
     * Removes a key from `localStorage`.
     *
     * Failures are logged and silently absorbed.
     *
     * @param {string} key - Storage key to remove.
     */
    removeLocalItem(key) {
        try {
            localStorage.removeItem(key);
        } catch (err) {
            handleLog(err, `StorageModule.removeLocalItem: ${key}`);
        }
    },

    /**
     * Clears all entries from `localStorage`.
     *
     * Failures are logged and silently absorbed.
     */
    clearLocal() {
        try {
            localStorage.clear();
        } catch (err) {
            handleLog(err, 'StorageModule.clearLocal');
        }
    }
};

export default StorageModule;