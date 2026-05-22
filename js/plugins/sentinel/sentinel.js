/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: ./plugins/sentinel/debug-sentinel.js */
/**
 * @module Core/DebugSentinel
 * @description Sentinel Debug Bridge — a Quelora Native Plugin.
 *
 * Connects to the Sentinel Broker running inside quelora-dashboard-api via:
 *   wss://api-dashboard.quelora.dev/ws/debug-broker
 *
 * Each device (browser, mobile) that connects receives a unique PIN.
 * The developer shares that PIN with the VS Code AI agent, which can then
 * address commands to any active sentinel by PIN.
 *
 * Multiple devices can be active simultaneously — each is an independent session.
 *
 * Session lifecycle:
 *   1. Developer calls debug.Sentinel_Connect() in the browser console.
 *   2. Sentinel connects to the broker and receives a unique PIN.
 *   3. Developer shares the PIN with the VS Code agent.
 *   4. Agent joins; the badge turns green.
 *   5. Agent issues AGENT_COMMAND { targetPin, ... } frames.
 *   6. Sentinel streams COMMAND_RESULT and TELEMETRY frames back.
 *
 * Console API:
 *   debug.Sentinel_Connect([brokerUrl])  — open session
 *   debug.Sentinel_Disconnect()          — close session
 *
 * @version 3.3.0
 */

import { registerDebug }     from '../../core/debug.js';
import handleLog             from '../../core/logs.js';
import { SentinelInspector } from './sentinel-inspector.js';
import { SentinelRecorder }  from './sentinel-recorder.js';
import {
    Action,
    CommandType,
    TelemetryType
} from './sentinel-protocol.js';

// ── Module-level state ─────────────────────────────────────────────────────────

/** @type {WebSocket|null} */
let _socket = null;

/** @type {string|null} PIN assigned by the broker for this device session. */
let _sessionPin = null;

/** @type {boolean} Whether the VS Code agent has joined and is watching. */
let _agentConnected = false;

/** @type {ReturnType<typeof setInterval>|null} */
let _heartbeatTimer = null;

/** @type {Object|null} Quelora shared dependency context injected on register(). */
let _context = null;

const HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_BROKER_URL    = 'wss://api-dashboard.quelora.dev/ws/debug-broker';

// ── Transport ──────────────────────────────────────────────────────────────────

/**
 * Serialises `payload` and writes it to the socket.
 * No-ops silently if the socket is not OPEN.
 * @param {Object} payload
 * @returns {void}
 */
function _send(payload) {
    if (_socket?.readyState === WebSocket.OPEN) {
        _socket.send(JSON.stringify(payload));
    }
}

/**
 * Emits a TELEMETRY frame to the broker (which relays it to the agent).
 * Attaches the session PIN so the agent knows which device sent it.
 * @param {string} type - TelemetryType constant.
 * @param {Object} data - Additional fields merged into the payload.
 * @returns {void}
 */
function _emitTelemetry(type, data) {
    _send({
        action:  Action.TELEMETRY,
        payload: {
            type,
            sessionPin: _sessionPin,
            cid:        _context?.ConfModule?.get('cid'),
            ...data,
            ts: new Date().toISOString()
        }
    });
}

// ── Command execution ──────────────────────────────────────────────────────────

/**
 * Executes a command and returns a plain-JSON-serialisable result or a Promise
 * that resolves to one. Errors propagate to `_dispatch`, which wraps them uniformly.
 * @param {string} type   - CommandType constant.
 * @param {Object} params - Parameters supplied by the agent.
 * @returns {Object|Promise<Object>}
 * @throws {Error}
 */
function _executeCommand(type, params) {
    switch (type) {

        case CommandType.INSPECT_APP:
            return SentinelInspector.inspectApp(_context);

        case CommandType.INSPECT_DOM:
            return SentinelInspector.inspectDom(params);

        case CommandType.INSPECT_PERFORMANCE:
            return SentinelInspector.inspectPerformance(SentinelRecorder.getFps());

        case CommandType.INSPECT_STORAGE:
            return SentinelInspector.inspectStorage();

        case CommandType.INSPECT_NETWORK_LOG:
            return {
                entries: SentinelRecorder.networkLog.snapshot(),
                ts:      new Date().toISOString()
            };

        case CommandType.INSPECT_CONSOLE_LOG:
            return {
                entries: SentinelRecorder.consoleLog.snapshot(),
                ts:      new Date().toISOString()
            };

        case CommandType.INSPECT_ERRORS:
            return {
                entries: SentinelRecorder.errorLog.snapshot(),
                ts:      new Date().toISOString()
            };

        case CommandType.OBSERVE_START:
            return SentinelRecorder.start({
                duration:   params.duration,
                channels:   params.channels,
                context:    _context,
                onFrame:    (frame) => _send({ action: Action.TELEMETRY, payload: { ...frame, sessionPin: _sessionPin } }),
                onComplete: (frame) => _send({ action: Action.TELEMETRY, payload: { ...frame, sessionPin: _sessionPin } })
            });

        case CommandType.OBSERVE_STOP:
            return SentinelRecorder.stop('AGENT_REQUEST');

        case CommandType.EXEC_JS: {
            const expression = String(params.expression || '').trim();
            if (!expression) return { error: 'expression must not be empty.' };
            const t0  = performance.now();
            // eslint-disable-next-line no-new-func
            const fn  = new Function('context', `"use strict"; return (${expression})`);
            const raw = fn(_context);
            const value = (() => {
                try   { return JSON.parse(JSON.stringify(raw)); }
                catch { return String(raw); }
            })();
            return { value, type: typeof raw, durationMs: Math.round(performance.now() - t0) };
        }

        case CommandType.EXEC_DISPATCH_EVENT: {
            const { eventName, detail } = params;
            if (!eventName) return { error: 'eventName is required.' };
            document.dispatchEvent(new CustomEvent(eventName, { detail, bubbles: true }));
            return { dispatched: true, eventName };
        }

        case CommandType.PING:
            return { pong: true, ts: new Date().toISOString() };

        case CommandType.OPEN_DRAWER: {
            const { drawerId, entityId, anchorCode = 'Q' } = params;

            if (entityId) {
                if (!window.QueloraApp?.handleAnchor) {
                    return { error: 'QueloraApp.handleAnchor not available. App may not be initialized.' };
                }
                window.QueloraApp.handleAnchor(anchorCode, [String(entityId)]);
                return { opened: true, method: 'handleAnchor', anchorCode, entityId };
            }

            if (!drawerId) return { error: 'drawerId or entityId is required.' };
            const el = document.getElementById(drawerId);
            if (!el) return { error: `Drawer element #${drawerId} not found in DOM.` };
            el.classList.add('active');
            return { opened: true, method: 'dom', drawerId };
        }

        case CommandType.EXEC_WORKER_ACTION: {
            const {
                action: workerAction,
                payload: workerPayload = {},
                responseAction,
                timeoutMs = 8_000
            } = params;

            if (!workerAction) return { error: 'action is required.' };

            const listenFor = responseAction || `__sentinel_wa_${Date.now()}`;

            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    _context.worker.removeEventListener('message', handler);
                    reject(new Error(`Worker action [${workerAction}] timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                function handler(e) {
                    if (e.data?.action === listenFor) {
                        clearTimeout(timer);
                        _context.worker.removeEventListener('message', handler);
                        resolve({ payload: e.data.payload, responseAction: listenFor });
                    }
                }

                _context.worker.addEventListener('message', handler);
                _context.CoreModule.postWorkerMessage({
                    action: workerAction,
                    payload: responseAction
                        ? workerPayload
                        : { ...workerPayload, responseAction: listenFor }
                });
            });
        }

        default:
            return { error: `Command [${type}] is not implemented.` };
    }
}

/**
 * Wraps _executeCommand with error handling and sends a COMMAND_RESULT reply.
 * Supports both synchronous results and Promises returned by async commands
 * (e.g. EXEC_WORKER_ACTION). The COMMAND_RESULT frame is only sent once the
 * result resolves, so the agent naturally awaits async commands.
 * @param {string} commandId   - Correlation ID from the agent. Echoed in the result.
 * @param {string} commandType - CommandType constant.
 * @param {Object} [params={}]
 * @returns {Promise<void>}
 */
async function _dispatch(commandId, commandType, params = {}) {
    let result = null;
    let error  = null;

    try {
        result = await _executeCommand(commandType, params);
    } catch (err) {
        error = err.message;
        handleLog(`Command [${commandType}] threw: ${err.message}`, 'SENTINEL', 'error', '🛡️');
    }

    _send({
        action:  Action.COMMAND_RESULT,
        payload: { commandId, commandType, sessionPin: _sessionPin, result, error }
    });
}

// ── Session management ─────────────────────────────────────────────────────────

/**
 * @returns {void}
 */
function _startHeartbeat() {
    if (_heartbeatTimer !== null) clearInterval(_heartbeatTimer);
    _heartbeatTimer = setInterval(
        () => _send({ action: Action.PING }),
        HEARTBEAT_INTERVAL_MS
    );
}

/**
 * @returns {void}
 */
function _stopHeartbeat() {
    if (_heartbeatTimer !== null) {
        clearInterval(_heartbeatTimer);
        _heartbeatTimer = null;
    }
}

/**
 * Renders (or replaces) the floating session badge.
 * Shows the PIN at all times so the developer can share it with the agent.
 * Orange border = waiting for agent. Green border = agent connected.
 * @param {'waiting'|'connected'} state
 * @returns {void}
 */
function _renderBadge(state) {
    document.getElementById('ql-debug-sentinel-badge')?.remove();

    const isConnected = state === 'connected';
    const color       = isConnected ? '#00FF00' : '#FFA500';
    const suffix      = isConnected ? ' 🤖' : '';

    const badge       = document.createElement('div');
    badge.id          = 'ql-debug-sentinel-badge';
    badge.innerHTML   = `🛡️ SENTINEL <b>${_sessionPin}</b>${suffix}`;

    Object.assign(badge.style, {
        position:     'fixed',
        top:          '15px',
        left:         '15px',
        zIndex:       '2147483647',
        background:   'rgba(0,0,0,0.88)',
        color,
        padding:      '6px 14px',
        borderRadius: '20px',
        fontFamily:   'monospace',
        fontSize:     '11px',
        border:       `1px solid ${color}`,
        pointerEvents:'none',
        opacity:      '0.95'
    });

    document.body.appendChild(badge);
}

/**
 * Resets all session state after the WebSocket closes.
 * @returns {void}
 */
function _cleanup() {
    _stopHeartbeat();
    SentinelRecorder.stop('SESSION_CLOSED');
    document.getElementById('ql-debug-sentinel-badge')?.remove();
    _socket         = null;
    _sessionPin     = null;
    _agentConnected = false;
}

// ── Message handler ────────────────────────────────────────────────────────────

/**
 * Processes a single inbound broker message.
 * @param {MessageEvent} event
 * @returns {void}
 */
function _onMessage(event) {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch {
        handleLog('Received non-JSON frame from broker (discarded).', 'SENTINEL', 'warn', '🛡️');
        return;
    }

    switch (data.action) {

        case Action.SESSION_CREATED:
            _sessionPin = data.sessionPin;
            _renderBadge('waiting');
            _startHeartbeat();
            handleLog(
                `Session ready — PIN: ${_sessionPin} — share this with your VS Code agent.`,
                'SENTINEL', 'success', '🛡️'
            );
            break;

        case Action.AGENT_COMMAND:
            _dispatch(data.commandId, data.commandType, data.params);
            break;

        case Action.SYSTEM_EVENT:
            handleLog(data.message, 'SENTINEL', 'info', '🤖');
            if (data.message === 'AI Agent attached and listening.' && !_agentConnected) {
                _agentConnected = true;
                _renderBadge('connected');
            }
            break;

        case Action.PING:
            _send({ action: Action.PONG });
            break;

        case Action.PONG:
            break;

        case Action.ERROR:
            handleLog(`Broker error: ${data.message}`, 'SENTINEL', 'error', '🛡️');
            break;

        default:
            handleLog(`Unrecognised broker action: ${data.action}`, 'SENTINEL', 'warn', '🛡️');
    }
}

// ── Public plugin surface ──────────────────────────────────────────────────────

const SentinelPlugin = {

    /**
     * Opens a WebSocket connection to the Sentinel Broker.
     * @param {string} [brokerUrl] - Optional URL override.
     * @returns {string} Status message for the debug console.
     */
    connect(brokerUrl) {
        if (_socket?.readyState === WebSocket.OPEN) {
            return `Sentinel already active. PIN: ${_sessionPin}${_agentConnected ? ' (agent connected)' : ' (waiting for agent)'}`;
        }

        const url = brokerUrl
            || _context.ConfModule.get('debugBrokerUrl', DEFAULT_BROKER_URL);

        try {
            _socket = new WebSocket(url);

            _socket.onopen = () => {
                _send({ action: Action.INIT_SESSION, role: 'SENTINEL' });
            };

            _socket.onmessage = _onMessage;

            _socket.onerror = () => {
                handleLog(
                    `WebSocket error connecting to ${url}`,
                    'SENTINEL', 'error', '🛡️'
                );
            };

            _socket.onclose = (ev) => {
                handleLog(
                    `Session closed. Code: ${ev.code}${ev.reason ? ` — ${ev.reason}` : ''}`,
                    'SENTINEL', 'info', '🛡️'
                );
                _cleanup();
            };

            return `Connecting to broker at ${url}…`;
        } catch (err) {
            handleLog(err.message, 'Sentinel.connect', 'error', '🛡️');
            return `Failed to connect: ${err.message}`;
        }
    },

    /**
     * Closes the active session. Cleanup runs via the onclose handler.
     * @returns {string}
     */
    disconnect() {
        if (!_socket) return 'No active Sentinel session.';
        _socket.close(1000, 'Manual disconnect');
        return 'Sentinel disconnecting…';
    }
};

// ── Plugin registration ────────────────────────────────────────────────────────

/**
 * Registers the Sentinel plugin into the QueloraApp plugin system.
 * @param {Object} context - Quelora shared dependency context.
 * @returns {Promise<void>}
 */
export async function register(context) {
    _context = context;

    registerDebug('Sentinel_Connect',    (url) => SentinelPlugin.connect(url));
    registerDebug('Sentinel_Disconnect', ()    => SentinelPlugin.disconnect());

    context.registerHandler('error', (payload, originalPayload) => {
        _emitTelemetry(TelemetryType.WORKER_ERROR, {
            error:    payload,
            original: originalPayload
        });
        SentinelRecorder.errorLog.push({
            type:    TelemetryType.WORKER_ERROR,
            payload,
            ts:      new Date().toISOString()
        });
    });
}