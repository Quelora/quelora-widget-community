#!/usr/bin/env node
/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/**
 * @file release.mjs
 * @description Build the Quelora widget and publish it to Cloudflare R2.
 *
 * Usage:
 *   node scripts/release.mjs [patch|minor|major]   — bump version, build, upload
 *   node scripts/release.mjs --dry-run             — build only, no upload
 *
 * Required environment variables (set in .env or shell):
 *   CF_ACCOUNT_ID         Cloudflare account ID
 *   R2_ACCESS_KEY_ID      R2 API token access key
 *   R2_SECRET_ACCESS_KEY  R2 API token secret key
 *   R2_BUCKET_NAME        R2 bucket name (e.g. quelora-cdn)
 */

import { execSync }                          from 'child_process';
import { readFileSync, readdirSync,
         statSync, writeFileSync }           from 'fs';
import { join, relative, extname, dirname }  from 'path';
import { fileURLToPath }                     from 'url';
import { S3Client, PutObjectCommand }        from '@aws-sdk/client-s3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DIST_DIR  = join(ROOT, 'js', 'dist');
const PKG_PATH  = join(ROOT, 'package.json');

// ─── Args ────────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const bump   = ['patch', 'minor', 'major'].find(b => args.includes(b)) ?? null;
const dryRun = args.includes('--dry-run');

// ─── Version bump ─────────────────────────────────────────────────────────────

/**
 * Increments the semver segment specified by `type`.
 * @param {string} version - Current semver string (e.g. "1.2.3")
 * @param {'patch'|'minor'|'major'} type
 * @returns {string} New semver string
 */
function bumpVersion(version, type) {
    const [major, minor, patch] = version.split('.').map(Number);
    if (type === 'major') return `${major + 1}.0.0`;
    if (type === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));

if (bump) {
    pkg.version = bumpVersion(pkg.version, bump);
    writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`Version bumped → ${pkg.version}`);
}

const VERSION = pkg.version;

// ─── Build ────────────────────────────────────────────────────────────────────

console.log(`\nBuilding v${VERSION}…`);
execSync('npx rollup -c rollup.dir.config.js', {
    cwd: join(ROOT, 'js'),
    stdio: 'inherit',
});
console.log('Build complete.');

if (dryRun) {
    console.log('\nDry run — skipping upload.');
    process.exit(0);
}

// ─── R2 client ───────────────────────────────────────────────────────────────

const { CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

for (const [name, value] of Object.entries({ CF_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME })) {
    if (!value) {
        console.error(`Missing environment variable: ${name}`);
        process.exit(1);
    }
}

const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
});

// ─── MIME types ───────────────────────────────────────────────────────────────

/**
 * Returns the MIME type for a given file path based on its extension.
 * @param {string} filePath
 * @returns {string}
 */
function getMimeType(filePath) {
    const ext = extname(filePath).toLowerCase();
    const map = {
        '.js':   'application/javascript',
        '.mjs':  'application/javascript',
        '.css':  'text/css',
        '.html': 'text/html',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.png':  'image/png',
        '.svg':  'image/svg+xml',
        '.ico':  'image/x-icon',
        '.txt':  'text/plain',
        '.map':  'application/json',
        '.webp': 'image/webp',
        '.gif':  'image/gif',
    };
    return map[ext] ?? 'application/octet-stream';
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Recursively collects all file paths under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            results.push(...collectFiles(full));
        } else {
            results.push(full);
        }
    }
    return results;
}

const files = collectFiles(DIST_DIR);
console.log(`\nUploading ${files.length} files to R2 (v${VERSION})…\n`);

let uploaded = 0;
for (const file of files) {
    const relPath    = relative(DIST_DIR, file);
    const key        = `v${VERSION}/${relPath}`;
    const body       = readFileSync(file);
    const isEnterprise = relPath.startsWith('enterprise/') || relPath.startsWith('enterprise\\');

    await s3.send(new PutObjectCommand({
        Bucket:      R2_BUCKET_NAME,
        Key:         key,
        Body:        body,
        ContentType: getMimeType(file),
        // Enterprise files: short cache so access can be revoked quickly.
        // Public files: immutable — hash in filename guarantees cache busting.
        CacheControl: isEnterprise
            ? 'private, max-age=3600'
            : 'public, max-age=31536000, immutable',
    }));

    console.log(`  ✓ ${key}`);
    uploaded++;
}

console.log(`\n✅ v${VERSION} — ${uploaded} files uploaded.`);
console.log(`   URL: https://cdn.quelora.com/v${VERSION}/quelora.js\n`);
