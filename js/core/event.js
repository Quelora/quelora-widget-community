/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/event.js */
/**
 * @module Core/EventBus
 * @description Centralized Event Bus for cross-module communication.
 * Implements Singleton pattern to avoid prop-drilling.
 * @version 2.1.0 (Production)
 */

import handleLog from './logs.js';

class EventBus {
    constructor() {
        this.listeners = {};
    }

    /**
     * Subscribe to an event.
     * @param {string} event - Event name.
     * @param {Function} callback - Function to execute.
     */
    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    /**
     * Unsubscribe from an event.
     * @param {string} event - Event name.
     * @param {Function} callback - Function reference to remove.
     */
    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }

    /**
     * Emit an event to all subscribers.
     * @param {string} event - Event name.
     * @param {any} payload - Data to pass to listeners.
     */
    emit(event, payload) {
        handleLog(`Emitting event: ${event}`, 'EventBus', 'log', '📣', payload);
        
        if (this.listeners[event]) {
            [...this.listeners[event]].forEach(cb => {
                try {
                    cb(payload);
                } catch (e) {
                    handleLog(`Error in listener for ${event}: ${e.message}`, 'EventBus', 'error', '📣');
                }
            });
        }
    }
}

export const eventBus = new EventBus();