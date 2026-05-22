/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: ./plugins/sentinel/sentinel-protocol.js */
/**
 * @module Core/SentinelProtocol
 * @description Canonical protocol constants for the Sentinel debug bridge.
 * Shared between the browser plugin, the VS Code agent, and the broker module
 * running inside quelora-dashboard-api.
 * @version 3.2.0
 */

/**
 * Connection roles recognised by the broker on INIT_SESSION.
 * @enum {string}
 */
export const Role = Object.freeze({
    /** Browser or mobile device running the Quelora app. */
    SENTINEL: 'SENTINEL',
    /** VS Code extension acting as the AI diagnostic agent. */
    AGENT:    'AGENT'
});

/**
 * Wire-level message actions between all three parties.
 * @enum {string}
 */
export const Action = Object.freeze({
    // ── Handshake ────────────────────────────────────────────────────────────
    /** First message from any peer after connecting. */
    INIT_SESSION:    'INIT_SESSION',
    /** Broker → Sentinel. Confirms session creation and delivers the PIN. */
    SESSION_CREATED: 'SESSION_CREATED',
    /** Broker → Agent. Confirms the agent is paired and lists active sentinels. */
    AGENT_READY:     'AGENT_READY',
    /** Broker → both peers. A new sentinel connected or disconnected. */
    SESSION_LIST:    'SESSION_LIST',

    // ── Commands (Agent → Broker → Sentinel) ─────────────────────────────────
    /** Agent dispatches a command to a specific sentinel identified by targetPin. */
    AGENT_COMMAND:  'AGENT_COMMAND',
    /** Sentinel returns the result of a command to the agent via the broker. */
    COMMAND_RESULT: 'COMMAND_RESULT',

    // ── Telemetry (Sentinel → Broker → Agent) ────────────────────────────────
    /** Sentinel emits a telemetry or observation frame. */
    TELEMETRY:      'TELEMETRY',

    // ── Keepalive ─────────────────────────────────────────────────────────────
    PING: 'PING',
    PONG: 'PONG',

    // ── Notifications ─────────────────────────────────────────────────────────
    /** Human-readable system notification from the broker. */
    SYSTEM_EVENT: 'SYSTEM_EVENT',
    /** Error notification from the broker. */
    ERROR:        'ERROR'
});

/**
 * Commands the VS Code agent can dispatch to a sentinel.
 * Sent inside an AGENT_COMMAND envelope with a `targetPin` field.
 * @enum {string}
 */
export const CommandType = Object.freeze({
    /**
     * Full application configuration, session, and identity snapshot.
     * Params: none
     */
    INSPECT_APP:         'INSPECT_APP',

    /**
     * DOM tree snapshot.
     * Params: { depth?: number, selector?: string }
     */
    INSPECT_DOM:         'INSPECT_DOM',

    /**
     * Web Vitals, memory, and FPS snapshot.
     * Params: none
     */
    INSPECT_PERFORMANCE: 'INSPECT_PERFORMANCE',

    /**
     * Returns the rolling network request/response log buffer.
     * Params: none
     */
    INSPECT_NETWORK_LOG: 'INSPECT_NETWORK_LOG',

    /**
     * Returns the rolling console output log buffer.
     * Params: none
     */
    INSPECT_CONSOLE_LOG: 'INSPECT_CONSOLE_LOG',

    /**
     * Returns localStorage and sessionStorage snapshots.
     * Params: none
     */
    INSPECT_STORAGE:     'INSPECT_STORAGE',

    /**
     * Returns the rolling unhandled error log buffer.
     * Params: none
     */
    INSPECT_ERRORS:      'INSPECT_ERRORS',

    /**
     * Begins streaming telemetry for the requested channels.
     * Immediately returns { started, duration, channels }.
     * Emits OBSERVATION_FRAME messages throughout the window.
     * Emits OBSERVATION_COMPLETE when the window closes.
     * Params: { duration?: number (ms, default 30 000, max 120 000), channels?: ObservationChannel[] }
     */
    OBSERVE_START:       'OBSERVE_START',

    /**
     * Terminates an active observation session early.
     * Params: none
     */
    OBSERVE_STOP:        'OBSERVE_STOP',

    /**
     * Evaluates a JS expression with access to the Quelora `context` object.
     * Params: { expression: string }
     * Result: { value: any, type: string, durationMs: number, error?: string }
     */
    EXEC_JS:             'EXEC_JS',

    /**
     * Dispatches a CustomEvent on the document.
     * Params: { eventName: string, detail?: any }
     * Result: { dispatched: boolean, eventName: string }
     */
    EXEC_DISPATCH_EVENT: 'EXEC_DISPATCH_EVENT',

    /** Liveness check. Result: { pong: true, ts: string } */
    PING: 'PING',

    /**
     * Opens a system drawer or a content drawer tied to an entity.
     *
     * Two modes:
     *   - Entity mode (passes through QueloraApp.handleAnchor — loads real data):
     *       Params: { entityId: string, anchorCode?: 'Q'|'L'|'U'|'E'|'R' }
     *   - DOM mode (adds the `active` class directly — useful for system drawers):
     *       Params: { drawerId: string }
     *
     * Known system drawer IDs:
     *   ql-comments, ql-notification-list, ql-community-profile,
     *   ql-community-settings, likes-list, ql-member-profile-drawer,
     *   ql-search-follow-request, ql-follow-request, ql-community-general-settings
     *
     * Result: { opened: boolean, method: 'handleAnchor'|'dom', drawerId?: string,
     *           entityId?: string, anchorCode?: string }
     */
    OPEN_DRAWER: 'OPEN_DRAWER',

    /**
     * Posts a message to the Quelora Web Worker and awaits its response.
     * Useful for executing API proxy calls or any worker action and getting the result
     * back as a COMMAND_RESULT rather than losing it in the main-thread handler map.
     *
     * Params:
     *   action        {string}  - Worker action name (e.g. 'fetchProxy', 'fetchStats').
     *   payload       {Object}  - Payload forwarded to the worker.
     *   responseAction {string} - (optional) Expected response action from the worker.
     *                             If omitted, a unique key is auto-generated and injected
     *                             into payload.responseAction (works with fetchProxy).
     *   timeoutMs     {number}  - (optional) How long to wait for the response. Default 8000.
     *
     * Result: { payload: Object, responseAction: string }
     */
    EXEC_WORKER_ACTION: 'EXEC_WORKER_ACTION'
});

/**
 * Observation channel identifiers for OBSERVE_START params.
 * @enum {string}
 */
export const ObservationChannel = Object.freeze({
    SIGNALS: 'SIGNALS',
    NETWORK: 'NETWORK',
    CONSOLE: 'CONSOLE',
    DOM:     'DOM',
    ERRORS:  'ERRORS'
});

/**
 * Telemetry sub-types emitted by the sentinel.
 * @enum {string}
 */
export const TelemetryType = Object.freeze({
    SIGNAL:               'SIGNAL',
    WORKER_ERROR:         'WORKER_ERROR',
    NETWORK_REQUEST:      'NETWORK_REQUEST',
    NETWORK_RESPONSE:     'NETWORK_RESPONSE',
    CONSOLE_ENTRY:        'CONSOLE_ENTRY',
    DOM_MUTATION:         'DOM_MUTATION',
    UNHANDLED_ERROR:      'UNHANDLED_ERROR',
    UNHANDLED_REJECTION:  'UNHANDLED_REJECTION',
    OBSERVATION_FRAME:    'OBSERVATION_FRAME',
    OBSERVATION_COMPLETE: 'OBSERVATION_COMPLETE'
});

/** @type {number} */
export const MAX_OBSERVATION_DURATION_MS = 120_000;

/** @type {number} */
export const RING_BUFFER_CAPACITY = 200;

/**
 * HTTP headers redacted before any network telemetry is transmitted.
 * @type {ReadonlyArray<string>}
 */
export const REDACTED_HEADERS = Object.freeze([
    'authorization',
    'cookie',
    'set-cookie',
    'x-auth-token',
    'x-api-key',
    'proxy-authorization'
]);