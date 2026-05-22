/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/debug.js */

let debugRegistry = [];

export function registerDebug(name, func) {
    if (!debugRegistry.find(d => d.name === name)) {
        debugRegistry.push({ name, func });
    }
}

if (typeof window !== 'undefined') {
    window.QueloraDebug = (index, ...params) => {
        if (index === undefined) {
            console.group('%c🛡️ Quelora Debug Registry', 'color: #FFC107; font-weight: bold; font-size: 12px;');
            if (debugRegistry.length === 0) {
                console.log('No debug functions registered.');
            } else {
                console.log('Available modules:');
                debugRegistry.forEach((d, i) => {
                    console.log(`%c${i + 1}%c ${d.name}`, 'background: #333; color: #fff; padding: 1px 4px; border-radius: 2px;', 'color: inherit;');
                });
                console.log('%c* %cExecute All', 'background: #333; color: #fff; padding: 1px 4px; border-radius: 2px;', 'color: inherit;');
            }
            console.groupEnd();
            return 'Pass the index to execute (e.g., QueloraDebug(1))';
        } 
        
        if (index === '*') {
            debugRegistry.forEach(d => d.func());
            return 'All debug functions executed.';
        } 

        const i = parseInt(index) - 1;
        if (debugRegistry[i]) {
            return debugRegistry[i].func(...params);
        } else {
            console.error('❌ Invalid debug index.');
            return 'Error: Index not found.';
        }
    };
}