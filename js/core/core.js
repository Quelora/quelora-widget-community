/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/core.js */
/**
 * @module Core/Core
 * @description Core logic and state management.
 * Refactored to act as an EventBus subscriber for session lifecycle events.
 * Includes System Offline State accessor for Circuit Breaker implementation.
 * @version 14.2.0
 */
import handleLog from './logs.js'; 
import ConfModule from './conf.js';
import UtilsModule from './utils.js';
import SessionModule from './session.js';
import { eventBus } from './event.js';

// Legacy imports - These modules should eventually subscribe to the eventBus themselves
import PostsModule from '../modules/posts/posts.js';
import CommentsModule from '../modules/comments/comments.js';

// --- State ---
let internalWorkerInstance = null;
let wsClientInstance = null;
let LiveChatClientClass = null;
let capabilityCheckPromise = null;

let systemOfflineState = false; 

const modifiersRegistry = new Map();

// ============================================================
// EVENT BUS LISTENERS
// ============================================================

/**
 * Reacts to a successful login/session restoration.
 * Orchestrates updates for modules that haven't been fully decoupled yet.
 */
eventBus.on('SESSION_ESTABLISHED', ({ isNewLogin }) => {
    // 1. Refresh WebSocket Session if active
    if (wsClientInstance && wsClientInstance.isConnected) {
        wsClientInstance.refreshSession();
    }

    // 2. Trigger UI updates for legacy modules (Posts & Comments)
    // Note: ProfileModule handles its own updates via its own listener now.
    if (isNewLogin) {
        UtilsModule.startTimeout(() => { 
            if (PostsModule && typeof PostsModule.updateAllInteractionBars === 'function') {
                PostsModule.updateAllInteractionBars(); 
            }
        }, 300);
        
        UtilsModule.startTimeout(() => { 
            if (CommentsModule && typeof CommentsModule.updateAllCommentLikes === 'function') {
                CommentsModule.updateAllCommentLikes(); 
            }
        }, 600);
    }
});

// ============================================================
// CORE FUNCTIONS
// ============================================================

/**
 * Initializes the Core module with necessary dependencies.
 * @param {Object} dependencies - The dependencies object (must include worker).
 */
async function initializeCore(dependencies) {
    try {
        if (!dependencies || !dependencies.worker) {
            throw new Error("Worker instance is required for Core initialization.");
        }
        internalWorkerInstance = dependencies.worker;
        const cid = ConfModule.get('cid');
        if (!cid) {
            throw new Error("Client ID (cid) not found in configuration during Core initialization.");
        }
    } catch (error) {
        handleLog(error, 'CoreModule.initializeCore');
    }
}

/**
 * Updates the internal system offline state.
 * Syncs the state with the WebSocket client if active.
 * @param {boolean} isOffline - The new offline state.
 */
function setSystemOfflineState(isOffline) {
    systemOfflineState = isOffline;

    if (wsClientInstance && typeof wsClientInstance.updateNetworkState === 'function') {
        wsClientInstance.updateNetworkState(isOffline);
    }
}

/**
 * Returns the current system offline state.
 * Used by UI modules to implement Circuit Breakers for write actions.
 * @returns {boolean} True if system is in L3 (Offline) mode.
 */
function isSystemOffline() {
    return systemOfflineState;
}

/**
 * Sends a message to the internal worker.
 * Automatically injects authentication tokens and client ID.
 * @param {Object} messageData - The message object containing action and payload.
 */
function postWorkerMessage(messageData) {
    if (!internalWorkerInstance) {
        handleLog(new Error("Worker not initialized"), "CoreModule.postWorkerMessage");
        return;
    }
    if (!messageData || typeof messageData !== 'object' || !messageData.action) {
        handleLog(new Error("Invalid message format for postWorkerMessage. Expected { action: '...', payload: {...} }"), "CoreModule.postWorkerMessage");
        return;
    }

    const { action, payload = {} } = messageData;
    const cid = ConfModule.get('cid');
    const currentToken = SessionModule.getTokenIfAvailable();
    const guestId = UtilsModule.getOrInitGuestId(!!currentToken);

    internalWorkerInstance.postMessage({
        action,
        payload: {
            ...payload,
            token: currentToken,
            guestId: guestId,
            cid
        }
    });
}

/**
 * Retrieves a valid token, triggering the login flow if necessary.
 * Now streamlined: side effects are handled via EventBus signals emitted by SessionModule.
 * @param {string|null} existingToken - Optional existing token to validate.
 * @param {boolean} onlyReturnToken - If true, returns token without side effects.
 * @returns {Promise<string|boolean>} The token string or false if failed.
 */
async function getTokenIfNeeded(existingToken = null, onlyReturnToken = false) {
    try {
        const currentToken = existingToken || SessionModule.getTokenIfAvailable();
        
        // Return immediately if we have a token or simply want to check existence
        if (currentToken) {
            return currentToken;
        }

        // Trigger the login flow (Modal or silent refresh)
        const response = await SessionModule.getToken(onlyReturnToken);
        
        if (!response || !response.token) {
            return false;
        }

        // Note: We no longer manually trigger UI updates here.
        // SessionModule.resolveSuccess emits 'SESSION_ESTABLISHED', which triggers the listener above.
        
        return response.token;
    } catch (error) {
        handleLog(error, 'CoreModule.getTokenIfNeeded');
        return false;
    }
}

/**
 * Lazy loads the Live Chat capability check.
 * Evaluates feature toggle before attempting to import the module.
 * @returns {Promise<boolean>} True if Live Chat module is available and enabled.
 */

async function checkLiveCapability() {
    if (LiveChatClientClass) return true;
    
    if (!ConfModule.get('features.sse', false)) {
        return false;
    }

    const registeredService = window.QueloraApp?.Modules?.LiveService;
    
    if (registeredService) {
        LiveChatClientClass = registeredService;
        return true;
    }

    handleLog('Live Chat module not present (Community Edition fallback).', 'CoreModule', 'info');
    return false;
}

/**
 * Retrieves or creates the WebSocket Client instance.
 * @param {boolean} autoCreate - Whether to instantiate if null.
 * @returns {Promise<Object|null>} The WebSocket client instance.
 */
async function getWsClient(autoCreate = true) {
    if (wsClientInstance) return wsClientInstance;

    if (!autoCreate) return null;

    const hasSupport = await checkLiveCapability();
    if (!hasSupport || !LiveChatClientClass) {
        handleLog("LiveChatClient module not available or disabled via config.", "CoreModule.getWsClient", "info");
        return null;
    }

    try {
        const cid = ConfModule.get('cid');
        if (!cid) throw new Error("Client ID (cid) not available for WebSocket.");
        
        const wsUrl = ConfModule.get('wsUrl') || `${ConfModule.get('apiUrl').replace('http', 'ws')}/ws/live`;
        
        wsClientInstance = new LiveChatClientClass({ 
            cid, 
            wsUrl,
            initialOfflineState: systemOfflineState 
        });
        
        handleLog("LiveChatClient instance created.", "LiveChatClient", "info");
        
        return wsClientInstance;
    } catch (error) {
        handleLog(error, "CoreModule.getWsClient - Instantiation", "error");
        return null;
    }
}

/**
 * Gracefully disconnects the WebSocket.
 */
async function disconnectWebSocket() {
    if (wsClientInstance) {
        handleLog("CoreModule requesting WebSocket disconnection.", "CoreModule.disconnectWebSocket", "info");
        const closePromise = new Promise(resolve => {
            if (wsClientInstance.socket && wsClientInstance.socket.readyState === WebSocket.OPEN) {
                wsClientInstance.socket.onclose = (event) => {
                    handleLog(`WebSocket closed successfully after disconnect request (Code: ${event.code}).`, "CoreModule.disconnectWebSocket", "info");
                    resolve();
                };
            } else {
                resolve();
            }
        });

        try {
            if (typeof wsClientInstance.destroy === 'function') {
                wsClientInstance.destroy();
            } else {
                wsClientInstance.close();
            }
        } catch (e) {
            handleLog(e, "CoreModule.disconnectWebSocket", "warn");
        }
        await closePromise;
        wsClientInstance = null; 
    }
}

/**
 * Registers a modification function for a specific capability.
 * @param {string} capabilityKey - Key identifier.
 * @param {Function} modifierFn - The modifier function.
 */
function registerModifier(capabilityKey, modifierFn) {
    if (!modifiersRegistry.has(capabilityKey)) {
        modifiersRegistry.set(capabilityKey, new Set());
    }
    modifiersRegistry.get(capabilityKey).add(modifierFn);
}

/**
 * Applies all registered modifiers to a value.
 * @param {string} capabilityKey - Key identifier.
 * @param {any} baseValue - The initial value.
 * @returns {any} The modified value.
 */
function applyModifiers(capabilityKey, baseValue) {
    if (!modifiersRegistry.has(capabilityKey)) return baseValue;
    
    let currentValue = baseValue;
    const modifiers = modifiersRegistry.get(capabilityKey);
    
    modifiers.forEach(fn => {
        try {
            currentValue = fn(currentValue);
        } catch (e) {
            handleLog(e, `CoreModule.applyModifiers(${capabilityKey})`, 'warn');
        }
    });
    
    return currentValue;
}

const CoreModule = {
    initializeCore,
    getTokenIfNeeded,
    checkLiveCapability,
    wsClient: getWsClient,
    disconnectWebSocket,
    postWorkerMessage,
    registerModifier,
    applyModifiers,
    setSystemOfflineState,
    isSystemOffline 
};

export default CoreModule;