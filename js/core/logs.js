/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/logs.js */
/**
 * @module Core/Logs
 * @description High-contrast logging system with audit history, telemetry, and CSV export.
 * @version 2.8.2
 * @fix: Fix console method resolution and clean CSV stack output.
 */
import { registerDebug } from './debug.js';

const _auditLog = [];
const MAX_AUDIT_ITEMS = 500;
const SESSION_ID = Math.random().toString(36).substring(2, 8).toUpperCase();
let _lastLogTs = Date.now();

const handleLog = (errorOrMessage, context = 'SYSTEM', level = 'log', customIcon = null, payload = null) => {
    const bgColors = { 
        error: '#F44336', 
        warn: '#FF9800', 
        info: '#03A9F4', 
        log: '#4CAF50', 
        success: '#2E7D32',
        debug: '#757575' 
    };
    const defaultIcons = { 
        error: '🔥', 
        warn: '⚠️', 
        info: 'ℹ️', 
        log: '🛠️', 
        success: '✅',
        debug: '🐞' 
    };

    const now = Date.now();
    const deltaTime = now - _lastLogTs;
    _lastLogTs = now;

    const isError = errorOrMessage instanceof Error;
    const message = isError ? errorOrMessage.message : String(errorOrMessage);
    const icon = customIcon || defaultIcons[level] || '📝';
    const tag = context.toUpperCase();

    // Captura de origen
    const traceStack = new Error().stack;
    const stackLines = traceStack.split('\n');
    const stackLine = stackLines[2] || '';
    const callerMatch = stackLine.match(/at\s+(.*)\s+\((.*):(\d+):(\d+)\)/) || stackLine.match(/at\s+(.*):(\d+):(\d+)/);
    
    const callerInfo = callerMatch ? {
        function: callerMatch[1] || 'anonymous',
        file: callerMatch[2].split('/').pop() || 'unknown',
        line: callerMatch[3],
    } : { function: 'unknown', file: 'unknown', line: '0' };

    const telemetryString = `RAM:${navigator.deviceMemory || 'N/A'}G | NET:${navigator.onLine ? 'online' : 'offline'} | Δ:${deltaTime}ms`;

    const auditEntry = {
        ts: new Date().toISOString(),
        level,
        context: tag,
        message: message,
        caller: `${callerInfo.file}:${callerInfo.line} (${callerInfo.function})`,
        telemetry: telemetryString,
        stack: isError ? errorOrMessage.stack : traceStack,
        payload: payload ? JSON.parse(JSON.stringify(payload)) : null
    };
    
    _auditLog.push(auditEntry);
    if (_auditLog.length > MAX_AUDIT_ITEMS) _auditLog.shift();

    const currentIndex = _auditLog.length - 1;

    const styles = [
        `background: ${bgColors[level] || bgColors.log}; color: #fff; font-weight: bold; padding: 2px 5px; border-radius: 3px;`,
        'margin-left: 5px; font-weight: 600;'
    ];

    const logHeader = `${icon} %c[${currentIndex}]%c %c[${tag}]%c ${message}`;

    const idStyle = 'color: #AAAAAA; font-weight: normal; padding: 0 6px;'; // Gris tranquilo, sin fondo
    const resetStyle = 'color: inherit; font-weight: normal;';

    if (level === 'error' || level === 'warn' || payload) {
        console.groupCollapsed(logHeader, idStyle, resetStyle, ...styles);
        console.log(`📍 Origin: ${auditEntry.caller}`);
        console.log(`📡 Telemetry: ${auditEntry.telemetry}`);
        if (payload) console.log(`📦 Box Payload:`, payload);
        if (isError) console.log(`📜 Stack Trace:`, errorOrMessage);
        console.groupEnd();
    } else {
        const method = (level === 'success') ? 'log' : (console[level] ? level : 'log');
        console[method](logHeader, idStyle, resetStyle, ...styles);
    }
    
    return null;
};

const exportLogsToCSV = () => {
    if (_auditLog.length === 0) return "No logs to export.";
    const headers = ["Timestamp", "Level", "Context", "Message", "Caller", "Telemetry", "Payload", "Stack"];
    
    const rows = _auditLog.map(e => {
        // Limpiamos el stack: si no es un error real, no exportamos el chorro de texto del Error falso
        const cleanStack = e.level === 'error' ? e.stack : `Trace: ${e.caller}`;
        
        return [
            e.ts, 
            e.level.toUpperCase(), 
            e.context, 
            `"${e.message.replace(/"/g, '""')}"`, 
            `"${e.caller}"`, 
            `"${e.telemetry}"`,
            `"${e.payload ? JSON.stringify(e.payload).replace(/"/g, '""') : ''}"`, 
            `"${cleanStack.replace(/"/g, '""')}"`
        ];
    });

    const csvContent = [headers, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quelora_audit_${SESSION_ID}_${Date.now()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return `✅ Audit ${SESSION_ID} exported.`;
};

if (typeof registerDebug === 'function') {

    registerDebug('Audit_View_Table', () => {
        console.table(_auditLog.map(e => ({
            "Level": e.level.toUpperCase(),
            "Context": e.context,
            "Message": e.message,
            "Time": e.ts.split('T')[1],
            "Origin": e.caller
        })));
        return "Audit table rendered.";
    });

    registerDebug('Audit_Export_CSV', () => exportLogsToCSV());


    registerDebug('Audit_View_Entry', (entryId = null) => {
        if (_auditLog.length === 0) {
            console.warn('No entries in the audit log yet.');
            return 'Audit log is empty.';
        }

        let idx;

        if (entryId !== null && entryId !== undefined) {
            // Usar el ID pasado directamente
            idx = parseInt(entryId, 10);
            if (isNaN(idx) || idx < 0 || idx >= _auditLog.length) {
                console.error('Invalid entry ID provided.');
                return `Invalid entry ID. Valid range: 0–${_auditLog.length - 1}`;
            }
        } else {
            // Fallback al prompt (comportamiento original)
            const input = prompt(
                `Enter the entry number (0 to ${_auditLog.length - 1})\n` +
                `(or cancel to exit)`
            );

            if (input === null) {
                return 'Operation canceled.';
            }

            idx = parseInt(input, 10);
            if (isNaN(idx) || idx < 0 || idx >= _auditLog.length) {
                console.error('Invalid index.');
                return `Invalid index. Valid range: 0–${_auditLog.length - 1}`;
            }
        }

        const e = _auditLog[idx];

        console.groupCollapsed(
            `%c[${idx}]%c 🔍 [${e.level.toUpperCase()}] ${e.context} – ${e.message.substring(0, 100)}${e.message.length > 100 ? '...' : ''}`,
            'color: #AAAAAA; font-weight: normal; padding: 0 6px;',
            'font-weight: normal; font-size: 1em; color: inherit; background: none;'
        );

        console.table({
            "Entry ID": idx,
            Timestamp: e.ts,
            Level: e.level.toUpperCase(),
            Context: e.context,
            Message: e.message,
            Caller: e.caller,
            Telemetry: e.telemetry
        });

        if (e.payload) {
            console.log('%c📦 Payload:', 'font-weight: bold; color: #FF9800;');
            try {
                if (typeof e.payload === 'object' && e.payload !== null) {
                    console.table(e.payload);
                } else {
                    console.log(e.payload);
                }
            } catch (err) {
                console.log(e.payload);
            }
        } else {
            console.log('%c📦 Payload: none', 'color: #999;');
        }

        if (e.level === 'error' && e.stack) {
            console.log('%c📜 Stack Trace:', 'font-weight: bold; color: #F44336;');
            console.log(e.stack);
        }

        console.groupEnd();

        return `Details of entry #${idx} displayed in console.`;
    });
}

export default handleLog;