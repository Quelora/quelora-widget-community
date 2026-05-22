/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: ./plugins/sentinel/sentinel-inspector.js */
/**
 * @module Core/SentinelInspector
 * @description Synchronous inspection snapshot utilities for the Sentinel bridge.
 * All public methods return plain-JSON-serialisable objects suited for WebSocket
 * transmission. No streaming, no side effects, no retained state.
 * @version 3.0.0
 */

import { REDACTED_HEADERS } from './sentinel-protocol.js';

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Serialises a DOM Element to a lightweight descriptor tree.
 * Children are recursed up to `maxDepth` levels.
 * @param {Element} element
 * @param {number} maxDepth
 * @param {number} currentDepth
 * @returns {Object}
 */
function serializeElement(element, maxDepth, currentDepth) {
    const attrs = {};
    for (const attr of element.attributes) {
        attrs[attr.name] = attr.value;
    }

    const node = {
        tag:        element.tagName.toLowerCase(),
        id:         element.id         || undefined,
        classes:    element.className
                        ? element.className.split(' ').filter(Boolean)
                        : undefined,
        attrs:      Object.keys(attrs).length ? attrs : undefined,
        childCount: element.childElementCount,
        children:   []
    };

    if (currentDepth < maxDepth) {
        for (const child of element.children) {
            node.children.push(serializeElement(child, maxDepth, currentDepth + 1));
        }
    }

    return node;
}

/**
 * Attempts a JSON round-trip serialisation of `value`.
 * Falls back to String() for non-serialisable values.
 * @param {any} value
 * @returns {any}
 */
function safeSerialize(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return String(value);
    }
}

/**
 * Reads all entries from a Storage instance, truncating values larger than 1 kB.
 * Returns { _error: string } if storage access is denied (e.g. third-party iframe).
 * @param {Storage} store
 * @returns {Object}
 */
function readStorage(store) {
    const out = {};
    try {
        for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            const raw = store.getItem(key);
            out[key] = raw && raw.length > 1024
                ? `${raw.slice(0, 1024)}\u2026[truncated ${raw.length - 1024} bytes]`
                : raw;
        }
    } catch (err) {
        return { _error: `Storage access denied: ${err.message}` };
    }
    return out;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AppSnapshot
 * @property {Object}  config          - ConfModule.getAll() output.
 * @property {boolean} isAuthenticated - Whether a session token is available.
 * @property {Object}  identity        - systemIdentity from context.
 * @property {string}  url             - Current window location.
 * @property {number}  viewportWidth
 * @property {number}  viewportHeight
 * @property {string}  ts              - ISO-8601 timestamp.
 */

/**
 * @typedef {Object} DomSnapshot
 * @property {string}       title         - document.title
 * @property {string}       url           - window.location.href
 * @property {number}       totalElements - querySelectorAll('*').length
 * @property {Object|null}  tree          - Serialised element tree.
 * @property {string}       ts
 */

/**
 * @typedef {Object} PerformanceSnapshot
 * @property {Object}      vitals - Paint timings and navigation timing metrics.
 * @property {Object|null} memory - JS heap sizes if available.
 * @property {number|null} fps    - Instantaneous FPS estimate from the recorder.
 * @property {string}      ts
 */

/**
 * @typedef {Object} StorageSnapshot
 * @property {Object} local   - localStorage entries.
 * @property {Object} session - sessionStorage entries.
 * @property {string} ts
 */

export const SentinelInspector = {

    /**
     * Captures a full application configuration and session snapshot.
     * @param {Object} context - Quelora shared dependency context.
     * @returns {AppSnapshot}
     */
    inspectApp(context) {
        const { ConfModule, SessionModule, systemIdentity } = context;
        return {
            config:          safeSerialize(ConfModule.getAll()),
            isAuthenticated: !!SessionModule.getTokenIfAvailable(),
            identity:        safeSerialize(systemIdentity),
            url:             window.location.href,
            viewportWidth:   window.innerWidth,
            viewportHeight:  window.innerHeight,
            ts:              new Date().toISOString()
        };
    },

    /**
     * Captures a depth-limited DOM tree snapshot rooted at `selector`.
     * @param {Object}  [params]
     * @param {number}  [params.depth=4]     - Maximum recursion depth.
     * @param {string}  [params.selector='body'] - CSS selector for the root element.
     * @returns {DomSnapshot}
     */
    inspectDom({ depth = 4, selector = 'body' } = {}) {
        const root = document.querySelector(selector);
        return {
            title:         document.title,
            url:           window.location.href,
            totalElements: document.querySelectorAll('*').length,
            tree:          root ? serializeElement(root, depth, 0) : null,
            ts:            new Date().toISOString()
        };
    },

    /**
     * Captures a performance snapshot using the Performance and Navigator APIs.
     * @param {number|null} [lastFps=null] - FPS reading maintained by SentinelRecorder.
     * @returns {PerformanceSnapshot}
     */
    inspectPerformance(lastFps = null) {
        const navEntries = performance.getEntriesByType('navigation');
        const nav        = navEntries[0] || {};
        const paintMap   = {};

        performance.getEntriesByType('paint').forEach(entry => {
            paintMap[entry.name] = Math.round(entry.startTime);
        });

        /** @type {Object|null} */
        const memory = performance.memory
            ? {
                jsHeapSizeLimit:  performance.memory.jsHeapSizeLimit,
                totalJSHeapSize:  performance.memory.totalJSHeapSize,
                usedJSHeapSize:   performance.memory.usedJSHeapSize,
                deviceMemoryGB:   navigator.deviceMemory || null
              }
            : null;

        return {
            vitals: {
                firstPaint:              paintMap['first-paint']             ?? null,
                firstContentfulPaint:    paintMap['first-contentful-paint']  ?? null,
                domInteractive:          nav.domInteractive   ? Math.round(nav.domInteractive)   : null,
                domContentLoadedEventEnd: nav.domContentLoadedEventEnd
                                            ? Math.round(nav.domContentLoadedEventEnd)
                                            : null,
                domComplete:             nav.domComplete      ? Math.round(nav.domComplete)      : null,
                loadEventEnd:            nav.loadEventEnd     ? Math.round(nav.loadEventEnd)     : null,
                transferSizeBytes:       nav.transferSize     ?? null,
                encodedBodySizeBytes:    nav.encodedBodySize  ?? null
            },
            memory,
            fps:   lastFps,
            ts:    new Date().toISOString()
        };
    },

    /**
     * Captures shallow snapshots of localStorage and sessionStorage.
     * Values larger than 1 kB are truncated with an annotation.
     * @returns {StorageSnapshot}
     */
    inspectStorage() {
        return {
            local:   readStorage(localStorage),
            session: readStorage(sessionStorage),
            ts:      new Date().toISOString()
        };
    },

    /**
     * Returns a copy of an HTTP headers object with sensitive names redacted.
     * Comparison against REDACTED_HEADERS is case-insensitive.
     * @param {Object} headers - Raw headers object { name: value }.
     * @returns {Object}
     */
    sanitizeHeaders(headers) {
        const out = {};
        for (const [key, value] of Object.entries(headers || {})) {
            out[key] = REDACTED_HEADERS.includes(key.toLowerCase()) ? '[REDACTED]' : value;
        }
        return out;
    }
};