/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: ./plugins/sentinel/sentinel-recorder.js */
/**
 * @module Core/SentinelRecorder
 * @description Time-bounded observation engine for the Sentinel debug bridge.
 * Intercepts network requests (XHR and fetch), console output, DOM mutations,
 * EventBus signals, and unhandled errors. Frames are streamed to the agent
 * via the `onFrame` callback for the configured duration. A final summary
 * is delivered via `onComplete` when the window closes.
 *
 * Rolling ring buffers (networkLog, consoleLog, errorLog) persist across
 * individual observation sessions and are accessible via snapshot commands.
 * @version 3.0.0
 */

import {
    TelemetryType,
    ObservationChannel,
    MAX_OBSERVATION_DURATION_MS,
    RING_BUFFER_CAPACITY,
    REDACTED_HEADERS
} from './sentinel-protocol.js';

// ── Ring buffer ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RingBuffer
 * @property {any[]} items
 * @property {number} capacity
 */

/**
 * Creates a capacity-bounded ring buffer that evicts the oldest item on overflow.
 * @param {number} capacity
 * @returns {RingBuffer}
 */
function createRingBuffer(capacity) {
    return {
        items: [],
        capacity,

        /**
         * Appends `item`, evicting the oldest entry if at capacity.
         * @param {any} item
         */
        push(item) {
            if (this.items.length >= this.capacity) {
                this.items.shift();
            }
            this.items.push(item);
        },

        /**
         * Returns a shallow copy of all items without clearing the buffer.
         * @returns {any[]}
         */
        snapshot() {
            return [...this.items];
        }
    };
}

// ── Instrumentation factories ──────────────────────────────────────────────────

/**
 * Replaces window.XMLHttpRequest with an instrumented subclass that emits
 * NETWORK_REQUEST and NETWORK_RESPONSE frames via `emit`.
 * @param {Function} emit - Frame emission callback.
 * @returns {Function} Restore function that reinstates the original constructor.
 */
function instrumentXhr(emit) {
    const OriginalXHR = window.XMLHttpRequest;

    class InstrumentedXHR extends OriginalXHR {
        constructor() {
            super();
            /** @type {{ method: string, url: string, requestedAt: number, headers: Object }} */
            this._meta = { method: 'GET', url: '', requestedAt: 0, headers: {} };

            this.addEventListener('loadstart', () => {
                this._meta.requestedAt = Date.now();
                emit({
                    type:    TelemetryType.NETWORK_REQUEST,
                    method:  this._meta.method,
                    url:     this._meta.url,
                    headers: this._meta.headers,
                    ts:      new Date().toISOString()
                });
            });

            this.addEventListener('loadend', () => {
                emit({
                    type:       TelemetryType.NETWORK_RESPONSE,
                    method:     this._meta.method,
                    url:        this._meta.url,
                    status:     this.status,
                    durationMs: Date.now() - this._meta.requestedAt,
                    ts:         new Date().toISOString()
                });
            });
        }

        /**
         * @param {string} method
         * @param {string} url
         * @param {...any} rest
         * @returns {void}
         */
        open(method, url, ...rest) {
            this._meta.method = method;
            this._meta.url    = url;
            super.open(method, url, ...rest);
        }

        /**
         * @param {string} name
         * @param {string} value
         * @returns {void}
         */
        setRequestHeader(name, value) {
            const redacted = REDACTED_HEADERS.includes(name.toLowerCase());
            this._meta.headers[name] = redacted ? '[REDACTED]' : value;
            super.setRequestHeader(name, value);
        }
    }

    window.XMLHttpRequest = InstrumentedXHR;
    return () => { window.XMLHttpRequest = OriginalXHR; };
}

/**
 * Wraps window.fetch to capture request and response telemetry.
 * The original fetch reference is preserved in closure and always called.
 * @param {Function} emit
 * @returns {Function} Restore function.
 */
function instrumentFetch(emit) {
    const originalFetch = window.fetch;

    window.fetch = async function sentinelFetch(input, init = {}) {
        const url    = typeof input === 'string' ? input : input.url;
        const method = ((init.method) || 'GET').toUpperCase();

        const rawHeaders = Object.fromEntries(new Headers(init.headers || {}).entries());
        const safeHeaders = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
            safeHeaders[k] = REDACTED_HEADERS.includes(k.toLowerCase()) ? '[REDACTED]' : v;
        }

        const requestedAt = Date.now();
        emit({
            type:    TelemetryType.NETWORK_REQUEST,
            method,
            url,
            headers: safeHeaders,
            ts:      new Date().toISOString()
        });

        let response;
        try {
            response = await originalFetch(input, init);
        } catch (err) {
            emit({
                type:       TelemetryType.NETWORK_RESPONSE,
                method,
                url,
                status:     0,
                error:      err.message,
                durationMs: Date.now() - requestedAt,
                ts:         new Date().toISOString()
            });
            throw err;
        }

        emit({
            type:       TelemetryType.NETWORK_RESPONSE,
            method,
            url,
            status:     response.status,
            durationMs: Date.now() - requestedAt,
            ts:         new Date().toISOString()
        });

        return response;
    };

    return () => { window.fetch = originalFetch; };
}

/**
 * Wraps console.log / info / warn / error / debug to emit CONSOLE_ENTRY frames.
 * Arguments are serialised with a best-effort JSON round-trip fallback to String().
 * @param {Function} emit
 * @returns {Function} Restore function.
 */
function instrumentConsole(emit) {
    const LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
    const originals = {};

    LEVELS.forEach(level => {
        originals[level] = console[level].bind(console);
        console[level] = (...args) => {
            originals[level](...args);
            emit({
                type:  TelemetryType.CONSOLE_ENTRY,
                level,
                args:  args.map(arg => {
                    try { return JSON.parse(JSON.stringify(arg)); } catch { return String(arg); }
                }),
                ts: new Date().toISOString()
            });
        };
    });

    return () => {
        LEVELS.forEach(level => { console[level] = originals[level]; });
    };
}

/**
 * Attaches a MutationObserver to document.body for DOM change telemetry.
 * @param {Function} emit
 * @returns {Function} Restore function.
 */
function instrumentDom(emit) {
    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            emit({
                type:          TelemetryType.DOM_MUTATION,
                mutationType:  m.type,
                target:        m.target.nodeName.toLowerCase(),
                targetId:      m.target.id || undefined,
                addedCount:    m.addedNodes.length,
                removedCount:  m.removedNodes.length,
                attribute:     m.attributeName || undefined,
                ts:            new Date().toISOString()
            });
        }
    });

    observer.observe(document.body, {
        childList:     true,
        subtree:       true,
        attributes:    true,
        characterData: false
    });

    return () => observer.disconnect();
}

/**
 * Listens for window `error` and `unhandledrejection` events.
 * @param {Function} emit
 * @returns {Function} Restore function.
 */
function instrumentErrors(emit) {
    const onError = (ev) => {
        emit({
            type:     TelemetryType.UNHANDLED_ERROR,
            message:  ev.message,
            filename: ev.filename,
            lineno:   ev.lineno,
            colno:    ev.colno,
            ts:       new Date().toISOString()
        });
    };

    const onRejection = (ev) => {
        emit({
            type:   TelemetryType.UNHANDLED_REJECTION,
            reason: String(ev.reason),
            ts:     new Date().toISOString()
        });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
    };
}

/**
 * Subscribes to a fixed set of EventBus signals and forwards them as SIGNAL frames.
 * @param {Object} context - Quelora shared context (eventBus, ConfModule).
 * @param {Function} emit
 * @returns {Function} Restore function.
 */
function instrumentSignals(context, emit) {
    const { eventBus, ConfModule } = context;

    const MONITORED_SIGNALS = [
        'SESSION_ESTABLISHED',
        'OFFLINE_MODE',
        'ONLINE_MODE',
        'RESILIENCE_MODE_CHANGED',
        'USER_PROFILE_UPDATED'
    ];

    const handlers = MONITORED_SIGNALS.map(signal => {
        const handler = (payload) => {
            emit({
                type:   TelemetryType.SIGNAL,
                signal,
                cid:    ConfModule.get('cid'),
                data:   payload,
                ts:     new Date().toISOString()
            });
        };
        eventBus.on(signal, handler);
        return { signal, handler };
    });

    return () => {
        handlers.forEach(({ signal, handler }) => eventBus.off(signal, handler));
    };
}

/**
 * Measures FPS using a requestAnimationFrame loop.
 * @returns {{ getFps: () => number, stop: () => void }}
 */
function createFpsMonitor() {
    let lastTime = performance.now();
    let frames   = 0;
    let fps      = 0;
    let rafId    = null;

    const tick = (now) => {
        frames++;
        const delta = now - lastTime;
        if (delta >= 1000) {
            fps      = Math.round((frames * 1000) / delta);
            frames   = 0;
            lastTime = now;
        }
        rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);

    return {
        getFps: () => fps,
        stop:   () => { if (rafId !== null) cancelAnimationFrame(rafId); }
    };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RecorderStartOptions
 * @property {number}   [duration=30000] - Observation window in milliseconds.
 * @property {string[]} [channels]       - Active ObservationChannel values. Defaults to all.
 * @property {Function} onFrame          - Called for each telemetry frame as it occurs.
 * @property {Function} onComplete       - Called once when the observation window closes.
 * @property {Object}   [context]        - Quelora shared context, required for SIGNALS channel.
 */

export const SentinelRecorder = {

    /** @type {boolean} */
    _active: false,

    /** @type {ReturnType<typeof setTimeout>|null} */
    _timer: null,

    /** @type {Function[]} */
    _restorers: [],

    /** @type {{ getFps: Function, stop: Function }|null} */
    _fpsMonitor: null,

    /** @type {Function|null} */
    _onComplete: null,

    /** @type {RingBuffer} Rolling network request/response log. */
    networkLog: createRingBuffer(RING_BUFFER_CAPACITY),

    /** @type {RingBuffer} Rolling console output log. */
    consoleLog: createRingBuffer(RING_BUFFER_CAPACITY),

    /** @type {RingBuffer} Rolling unhandled error log. */
    errorLog: createRingBuffer(RING_BUFFER_CAPACITY),

    /**
     * Returns the current FPS reading from the active FPS monitor, or null.
     * @returns {number|null}
     */
    getFps() {
        return this._fpsMonitor ? this._fpsMonitor.getFps() : null;
    },

    /**
     * Starts a time-bounded observation session.
     * If a session is already active, it is stopped with reason 'SUPERSEDED' first.
     * @param {RecorderStartOptions} options
     * @returns {{ started: boolean, duration: number, channels: string[] }}
     */
    start(options) {
        if (this._active) {
            this.stop('SUPERSEDED');
        }

        const {
            duration    = 30_000,
            channels    = Object.values(ObservationChannel),
            onFrame,
            onComplete,
            context
        } = options;

        const clampedDuration = Math.min(duration, MAX_OBSERVATION_DURATION_MS);
        this._active     = true;
        this._onComplete = onComplete || null;

        /**
         * Emits a single observation frame and also populates the relevant ring buffer.
         * @param {Object} frame
         */
        const emit = (frame) => {
            if (!this._active) return;

            if (
                frame.type === TelemetryType.NETWORK_REQUEST ||
                frame.type === TelemetryType.NETWORK_RESPONSE
            ) {
                this.networkLog.push(frame);
            } else if (frame.type === TelemetryType.CONSOLE_ENTRY) {
                this.consoleLog.push(frame);
            } else if (
                frame.type === TelemetryType.UNHANDLED_ERROR ||
                frame.type === TelemetryType.UNHANDLED_REJECTION
            ) {
                this.errorLog.push(frame);
            }

            onFrame({
                type:  TelemetryType.OBSERVATION_FRAME,
                frame,
                ts:    new Date().toISOString()
            });
        };

        if (channels.includes(ObservationChannel.NETWORK)) {
            this._restorers.push(instrumentXhr(emit));
            this._restorers.push(instrumentFetch(emit));
        }

        if (channels.includes(ObservationChannel.CONSOLE)) {
            this._restorers.push(instrumentConsole(emit));
        }

        if (channels.includes(ObservationChannel.DOM)) {
            this._restorers.push(instrumentDom(emit));
        }

        if (channels.includes(ObservationChannel.ERRORS)) {
            this._restorers.push(instrumentErrors(emit));
        }

        if (channels.includes(ObservationChannel.SIGNALS) && context) {
            this._restorers.push(instrumentSignals(context, emit));
        }

        this._fpsMonitor = createFpsMonitor();

        this._timer = setTimeout(
            () => this.stop('DURATION_ELAPSED'),
            clampedDuration
        );

        return { started: true, duration: clampedDuration, channels };
    },

    /**
     * Stops the active observation session and invokes `onComplete` with a summary.
     * Safe to call when no session is active — returns `{ stopped: false }`.
     * @param {string} [reason='MANUAL'] - Human-readable stop reason.
     * @returns {{ stopped: boolean, reason: string }}
     */
    stop(reason = 'MANUAL') {
        if (!this._active) {
            return { stopped: false, reason: 'NOT_ACTIVE' };
        }

        clearTimeout(this._timer);
        this._timer  = null;
        this._active = false;

        this._restorers.forEach(restore => restore());
        this._restorers = [];

        if (this._fpsMonitor) {
            this._fpsMonitor.stop();
            this._fpsMonitor = null;
        }

        const completionFrame = {
            type:          TelemetryType.OBSERVATION_COMPLETE,
            reason,
            networkCount:  this.networkLog.snapshot().length,
            consoleCount:  this.consoleLog.snapshot().length,
            errorCount:    this.errorLog.snapshot().length,
            ts:            new Date().toISOString()
        };

        if (this._onComplete) {
            this._onComplete(completionFrame);
            this._onComplete = null;
        }

        return { stopped: true, reason };
    }
};