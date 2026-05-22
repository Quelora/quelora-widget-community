/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

// npx rollup -c rollup.dir.config.js
import terser from '@rollup/plugin-terser';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import copy from 'rollup-plugin-copy';
import json from '@rollup/plugin-json';
import replace from '@rollup/plugin-replace';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PATHS ---
// All paths are resolved relative to this config file (__dirname = js/).
// dist/ lives one level up at quelora-widget-community/dist/.
const r = (...s) => path.resolve(__dirname, ...s);
const DIST = r('../dist');

// --- CLEAN DIST ---
if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
}

// --- VENDOR EXTERNALS ---
// Copied as-is to dist/vendors/; never bundled.
const VENDOR_EXTERNALS = [
    'sw.js',
    /vendors\/trystero-torrent\.min\.js$/,
    /vendors\/trystero-nostr\.min\.js$/,
    /vendors\/qrcode\.min\.js$/,
];

// --- EXTERMINATE DEBUG ---
// Tree-shakes every *debug.js / *-debug.js import in production builds.
const exterminateDebug = () => {
    const STUB = `export function registerDebug() {}\nexport default function() {}`;
    let counter = 0;
    return {
        name: 'exterminate-debug',
        resolveId(source) {
            if (source.includes('-debug.js') || source.endsWith('debug.js')) {
                return { id: `\0debug-stub-${counter++}`, moduleSideEffects: false };
            }
            return null;
        },
        load(id) {
            if (id.startsWith('\0debug-stub')) return { code: STUB, moduleSideEffects: false };
            return null;
        },
        transform(code) {
            if (code.includes('debug.js')) {
                return {
                    code: code.replace(
                        /import\s*\(\s*['"][^'"]*debug\.js['"]\s*\)/g,
                        'Promise.resolve({ default: function(){}, registerDebug: function(){} })'
                    ),
                    map: null,
                };
            }
            return null;
        },
    };
};

// --- TERSER ---
const terserConfig = () => ({
    ecma: 2020,
    module: true,
    compress: {
        passes: 3,
        drop_console: true,
        unsafe: true,
        pure_funcs: ['handleLog', 'handleLogs', 'registerDebug', 'QueloraDebug', 'window.QueloraDebug'],
    },
    format: { comments: false },
});

// --- SHARED ROLLUP PLUGINS (no copy) ---
const basePlugins = (browser = true) => [
    replace({ 'process.env.NODE_ENV': JSON.stringify('production'), preventAssignment: true }),
    exterminateDebug(),
    json({ compact: true }),
    resolve({ preferBuiltins: false, browser }),
    commonjs({ include: /node_modules|vendors/, ignoreDynamicRequires: true }),
    terser(terserConfig()),
];

export default [
    // ─────────────────────────────────────────────────────────────────────────
    // BUILD 1 — MAIN APP + UI PLUGINS
    //
    // Entry keys ARE the output paths (relative to dist/).
    // Shared core code (core/, ui/, modules/) lands in dist/chunks/[name]-[hash].js.
    // Each plugin entry produces a self-contained (or chunk-linked) ESM file
    // at the exact path the server config's `plugins.ui` array references via
    // dynamic import from dist/chunks/ → ../enterprise/... / ../plugins/...
    // ─────────────────────────────────────────────────────────────────────────
    {
        input: {
            // Main entry
            'quelora':                                      r('quelora.js'),

            // Enterprise UI plugins  (server path: "../enterprise/<x>")
            'enterprise/survey/survey':                     r('enterprise/survey/survey.js'),
            'enterprise/gamification/gamification':         r('enterprise/gamification/gamification.js'),
            'enterprise/banana/banana-engine':              r('enterprise/banana/banana-engine.js'),
            'enterprise/sse/services/sse':                  r('enterprise/sse/services/sse.js'),
            'enterprise/chat/chat':                         r('enterprise/chat/chat.js'),
            'enterprise/p2p/p2p':                           r('enterprise/p2p/p2p.js'),
            'enterprise/p2p/tracker-bridge':                r('enterprise/p2p/tracker-bridge.js'),
            'enterprise/resilience/resilience':             r('enterprise/resilience/resilience.js'),
            'enterprise/live/live.ui':                      r('enterprise/live/live.ui.js'),
            'enterprise/live/live':                         r('enterprise/live/live.js'),

            // Native plugins  (server path: "../plugins/<x>")
            'plugins/sentinel/sentinel':                    r('plugins/sentinel/sentinel.js'),
            'plugins/placer/interaction-placer':            r('plugins/placer/interaction-placer.js'),
        },
        output: {
            dir: DIST,
            format: 'esm',
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            sourcemap: false,
            /**
             * Force shared infrastructure into a single chunk.
             * Splitting core/ui/modules/services into separate chunks causes
             * circular ESM chunk references (core↔ui↔modules) which produce
             * TDZ "Cannot access before initialization" errors at runtime.
             * A single shared chunk avoids cross-file circular ESM issues
             * because JS engines resolve circular imports within one file correctly.
             */
            manualChunks(id) {
                if (id.includes('/node_modules/')) return 'vendor';
                if (/\/js\/(core|ui|modules|services)\//.test(id)) return 'shared';
            },
        },
        external: VENDOR_EXTERNALS,
        plugins: [
            ...basePlugins(true),
            copy({
                targets: [
                    { src: r('sw.js'),                 dest: DIST },
                    { src: r('vendors/*.js'),           dest: r('../dist/vendors') },
                    { src: r('worker/pkg/**/*.wasm'),   dest: r('../dist/worker/pkg') },
                    { src: r('locales'),                dest: DIST },
                    { src: r('css'),                    dest: DIST },
                ],
            }),
        ],
    },

    // ─────────────────────────────────────────────────────────────────────────
    // BUILD 2 — WEB WORKER + WORKER PLUGINS
    //
    // Worker plugins share the dist/enterprise/ directory with UI plugins
    // because both are resolved via "../enterprise/" — from dist/worker/ for
    // the worker entry, and from dist/chunks/ for the main app.
    // Shared worker utilities land in dist/worker/chunks/[name]-[hash].js.
    // ─────────────────────────────────────────────────────────────────────────
    {
        input: {
            // Worker entry
            'worker/queloraWorker':                                          r('worker/queloraWorker.js'),

            // Enterprise worker plugins  (server path: "../enterprise/<x>")
            'enterprise/sse/worker/notifications/activitiesWorker.db':      r('enterprise/sse/worker/notifications/activitiesWorker.db.js'),
            'enterprise/sse/worker/sse/sseWorker':                          r('enterprise/sse/worker/sse/sseWorker.js'),
            'enterprise/chat/worker/chatWorker':                            r('enterprise/chat/worker/chatWorker.js'),
            'enterprise/resilience/worker/resilienceManager':               r('enterprise/resilience/worker/resilienceManager.js'),
            'enterprise/resilience/worker/resilienceWorker':                r('enterprise/resilience/worker/resilienceWorker.js'),
            'enterprise/resilience/worker/fallbackWorker.db':               r('enterprise/resilience/worker/fallbackWorker.db.js'),
        },
        output: {
            dir: DIST,
            format: 'esm',
            entryFileNames: '[name].js',
            chunkFileNames: 'worker/chunks/[name]-[hash].js',
            sourcemap: false,
            /**
             * Same single-chunk strategy for the Worker build.
             * Keeps worker-side circular deps (core ↔ utilsWorker) inside one file.
             */
            manualChunks(id) {
                if (/\/js\/(core|worker)\//.test(id) && !id.endsWith('queloraWorker.js')) return 'worker-shared';
            },
        },
        plugins: basePlugins(false),
    },
];
